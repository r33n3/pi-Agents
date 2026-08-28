import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentExecution, AgentExecutionPhase } from "./agent-executor.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type ExternalConnectionRunStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";

export interface ExternalConnectionModel extends ModelRef {
	name: string;
}

export interface ExternalConnectionDefinition {
	id: string;
	aliases?: string[];
	name: string;
	description: string;
	inputLabel: "Task" | "Goal";
	provider: "anthropic" | "openai" | "hermes";
	authentication: "subscription" | "api-key" | "configured";
	billing: "subscription" | "usage-based" | "configured";
	available: boolean;
	warning?: string;
	defaultModel: ModelRef;
	models: ExternalConnectionModel[];
}

export interface ExternalConnectionRunRecord {
	id: string;
	connectionId: string;
	prompt: string;
	cwd: string;
	model: ModelRef;
	status: ExternalConnectionRunStatus;
	createdAt: number;
	startedAt?: number;
	phase?: AgentExecutionPhase;
	progress?: string;
	lastActivityAt?: number;
	finishedAt?: number;
	artifactDirectory: string;
	error?: string;
}

export interface ExternalConnectionExecutionRequest {
	runId: string;
	connection: ExternalConnectionDefinition;
	prompt: string;
	cwd: string;
	model: ModelRef;
}

export type ExternalConnectionExecutionFactory = (
	request: ExternalConnectionExecutionRequest,
) => Promise<AgentExecution>;

interface ActiveRun {
	record: ExternalConnectionRunRecord;
	execution: AgentExecution;
	abortRequested: boolean;
	unsubscribe: () => void;
	completion?: Promise<void>;
}

/** Owns asynchronous external delegations and their durable result artifacts. */
export class ExternalConnectionManager implements AsyncDisposable {
	readonly #connections: ReadonlyMap<string, ExternalConnectionDefinition>;
	readonly #connectionAliases: ReadonlyMap<string, string>;
	readonly #executionFactory: ExternalConnectionExecutionFactory;
	readonly #artifactsRoot: string;
	readonly #defaultCwd: string;
	readonly #queue = new SerialOperationQueue();
	readonly #records = new Map<string, ExternalConnectionRunRecord>();
	readonly #activeByRun = new Map<string, ActiveRun>();
	#disposed = false;

	constructor(
		connections: readonly ExternalConnectionDefinition[],
		executionFactory: ExternalConnectionExecutionFactory,
		artifactsRoot: string,
		defaultCwd: string,
	) {
		this.#connections = new Map(connections.map((connection) => [connection.id, connection]));
		this.#connectionAliases = new Map(
			connections.flatMap((connection) =>
				(connection.aliases ?? []).map((alias) => [alias, connection.id] as const),
			),
		);
		this.#executionFactory = executionFactory;
		this.#artifactsRoot = resolve(artifactsRoot);
		this.#defaultCwd = resolve(defaultCwd);
	}

	async initialize(): Promise<void> {
		await mkdir(this.#artifactsRoot, { recursive: true });
		for (const entry of await readdir(this.#artifactsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const artifactDirectory = resolve(this.#artifactsRoot, entry.name);
			try {
				const value: unknown = JSON.parse(await readFile(resolve(artifactDirectory, "run.json"), "utf8"));
				const record = parseRunRecord(value, artifactDirectory);
				if (record.status === "starting" || record.status === "running") {
					record.status = "failed";
					record.finishedAt = Date.now();
					record.error = "Serve host stopped before the delegated run completed";
					await this.#persistRecord(record);
				}
				this.#records.set(record.id, record);
			} catch {
				// Malformed artifact directories are not exposed or executed.
			}
		}
	}

	listConnections(): ExternalConnectionDefinition[] {
		return [...this.#connections.values()];
	}

	listRuns(): ExternalConnectionRunRecord[] {
		return [...this.#records.values()].sort((left, right) => right.createdAt - left.createdAt);
	}

	getRun(runId: string): ExternalConnectionRunRecord | undefined {
		return this.#records.get(runId);
	}

	async readResult(runId: string): Promise<string | undefined> {
		const record = this.#records.get(runId);
		if (!record || record.status !== "succeeded") return undefined;
		try {
			return await readFile(resolve(record.artifactDirectory, "result.md"), "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async start(input: {
		connectionId: string;
		prompt: string;
		cwd?: string;
		model?: ModelRef;
	}): Promise<ExternalConnectionRunRecord> {
		return this.#queue.run(async () => {
			if (this.#disposed) throw new Error("External connection manager is disposed");
			const connectionId = this.#connectionAliases.get(input.connectionId) ?? input.connectionId;
			const connection = this.#connections.get(connectionId);
			if (!connection) throw new Error(`External connection ${input.connectionId} was not found`);
			if (!connection.available) throw new Error(`${connection.name} is unavailable in this Pi process`);
			const prompt = input.prompt.trim();
			if (!prompt) throw new Error(`${connection.inputLabel} is required`);
			const model = input.model ?? connection.defaultModel;
			if (
				!connection.models.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)
			) {
				throw new Error(`Model ${model.provider}/${model.id} is not supported by ${connection.name}`);
			}
			const runId = randomUUID();
			const artifactDirectory = resolve(this.#artifactsRoot, runId);
			const record: ExternalConnectionRunRecord = {
				id: runId,
				connectionId: connection.id,
				prompt,
				cwd: resolve(input.cwd?.trim() || this.#defaultCwd),
				model: { provider: model.provider, id: model.id },
				status: "starting",
				createdAt: Date.now(),
				artifactDirectory,
			};
			this.#records.set(runId, record);
			await this.#persistRecord(record);
			try {
				const execution = await this.#executionFactory({ runId, connection, prompt, cwd: record.cwd, model });
				record.status = "running";
				record.startedAt = Date.now();
				const active: ActiveRun = { record, execution, abortRequested: false, unsubscribe: () => {} };
				active.unsubscribe = execution.subscribe((event) => {
					record.phase = event.phase;
					record.progress = externalProgressMessage(connection.name, event.phase);
					record.lastActivityAt = event.timestamp;
				});
				this.#activeByRun.set(runId, active);
				await this.#persistRecord(record);
				active.completion = this.#settle(active);
				return { ...record };
			} catch (error) {
				record.status = "failed";
				record.finishedAt = Date.now();
				record.error = error instanceof Error ? error.message : String(error);
				await this.#persistRecord(record);
				throw error;
			}
		});
	}

	async abort(runId: string): Promise<ExternalConnectionRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (!active) throw new Error(`External run ${runId} is not active`);
		active.abortRequested = true;
		await active.execution.abort();
		await active.completion;
		return { ...active.record };
	}

	async waitForCompletion(runId: string): Promise<ExternalConnectionRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (active?.completion) await active.completion;
		const record = this.#records.get(runId);
		if (!record) throw new Error(`External run ${runId} was not found`);
		return { ...record };
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all([...this.#activeByRun.values()].map((active) => active.execution.abort()));
		await Promise.all([...this.#activeByRun.values()].map((active) => active.completion));
		await this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #settle(active: ActiveRun): Promise<void> {
		const { record, execution } = active;
		try {
			const result = await execution.result;
			const protocolError = externalProtocolError(result.output);
			if (protocolError) throw new Error(protocolError);
			await mkdir(record.artifactDirectory, { recursive: true });
			await Promise.all([
				writeFile(resolve(record.artifactDirectory, "result.md"), `${result.output}\n`, "utf8"),
				writeFile(
					resolve(record.artifactDirectory, "transcript.json"),
					`${JSON.stringify(result.transcript, null, 2)}\n`,
					"utf8",
				),
			]);
			record.status = active.abortRequested ? "aborted" : "succeeded";
		} catch (error) {
			record.status = active.abortRequested ? "aborted" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			active.unsubscribe();
			record.finishedAt = Date.now();
			await this.#persistRecord(record);
			this.#activeByRun.delete(record.id);
			await execution.dispose();
		}
	}

	async #persistRecord(record: ExternalConnectionRunRecord): Promise<void> {
		await mkdir(record.artifactDirectory, { recursive: true });
		await writeFile(resolve(record.artifactDirectory, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	}
}

function parseRunRecord(value: unknown, artifactDirectory: string): ExternalConnectionRunRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid external run");
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.connectionId !== "string" ||
		typeof record.prompt !== "string" ||
		typeof record.cwd !== "string" ||
		typeof record.createdAt !== "number" ||
		!isRunStatus(record.status)
	) {
		throw new Error("Invalid external run record");
	}
	const model = modelRef(record.model);
	return {
		id: record.id,
		connectionId: record.connectionId,
		prompt: record.prompt,
		cwd: record.cwd,
		model,
		status: record.status,
		createdAt: record.createdAt,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
		phase: isExecutionPhase(record.phase) ? record.phase : undefined,
		progress: typeof record.progress === "string" ? record.progress : undefined,
		lastActivityAt: typeof record.lastActivityAt === "number" ? record.lastActivityAt : undefined,
		finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
		artifactDirectory,
		error: typeof record.error === "string" ? record.error : undefined,
	};
}

function modelRef(value: unknown): ModelRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid run model");
	const model = value as Record<string, unknown>;
	if (typeof model.provider !== "string" || typeof model.id !== "string") throw new Error("Invalid run model");
	return { provider: model.provider, id: model.id };
}

function isRunStatus(value: unknown): value is ExternalConnectionRunStatus {
	return (
		value === "starting" || value === "running" || value === "succeeded" || value === "failed" || value === "aborted"
	);
}

function isExecutionPhase(value: unknown): value is AgentExecutionPhase {
	return (
		value === "initializing" ||
		value === "waiting-for-model" ||
		value === "generating" ||
		value === "running-tool" ||
		value === "writing-results"
	);
}

function externalProgressMessage(connectionName: string, phase: AgentExecutionPhase): string {
	if (phase === "running-tool") return `${connectionName} is working`;
	if (phase === "generating") return `${connectionName} is responding`;
	if (phase === "writing-results") return "Saving result";
	if (phase === "waiting-for-model") return `Waiting for ${connectionName}`;
	return `Starting ${connectionName}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function externalProtocolError(output: string): string | undefined {
	const message = output.trim();
	if (/^HTTP\s+(?:401|403|407|429|5\d\d)(?:\s|:|$)/i.test(message)) return message;
	return undefined;
}
