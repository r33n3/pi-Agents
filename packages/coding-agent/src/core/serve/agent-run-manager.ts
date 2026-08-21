import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentExecution, AgentExecutor } from "./agent-executor.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentRunStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";
export type AgentRunSource = "manual" | "routine";

export interface AgentRunRecord {
	id: string;
	agentId: string;
	prompt: string;
	source: AgentRunSource;
	status: AgentRunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	artifactDirectory: string;
	error?: string;
	model?: ModelRef;
}

interface ActiveRun {
	record: AgentRunRecord;
	execution: AgentExecution;
	abortRequested: boolean;
	completion?: Promise<void>;
}

/** Serializes lifecycle changes and grants at most one execution lease per agent workspace. */
export class AgentRunManager implements AsyncDisposable {
	readonly #registry: AgentRegistry;
	readonly #executor: AgentExecutor;
	readonly #artifactsRoot: string;
	readonly #queue = new SerialOperationQueue();
	readonly #records = new Map<string, AgentRunRecord>();
	readonly #activeByAgent = new Map<string, ActiveRun>();
	readonly #activeByRun = new Map<string, ActiveRun>();
	#disposed = false;

	constructor(registry: AgentRegistry, executor: AgentExecutor, artifactsRoot: string) {
		this.#registry = registry;
		this.#executor = executor;
		this.#artifactsRoot = resolve(artifactsRoot);
	}

	async initialize(): Promise<void> {
		await mkdir(this.#artifactsRoot, { recursive: true });
		for (const agentEntry of await readdir(this.#artifactsRoot, { withFileTypes: true })) {
			if (!agentEntry.isDirectory()) continue;
			const agentRoot = resolve(this.#artifactsRoot, agentEntry.name);
			for (const runEntry of await readdir(agentRoot, { withFileTypes: true })) {
				if (!runEntry.isDirectory()) continue;
				const artifactDirectory = resolve(agentRoot, runEntry.name);
				try {
					const value: unknown = JSON.parse(await readFile(resolve(artifactDirectory, "run.json"), "utf8"));
					const record = parseRunRecord(value, artifactDirectory);
					if (record.status === "starting" || record.status === "running") {
						record.status = "failed";
						record.finishedAt = Date.now();
						record.error = "Serve host stopped before the run completed";
						await this.#persistRecord(record);
					}
					this.#records.set(record.id, record);
				} catch {
					// Ignore malformed artifact directories; they are never executed or exposed.
				}
			}
		}
	}

	list(): AgentRunRecord[] {
		return [...this.#records.values()].sort((left, right) => right.createdAt - left.createdAt);
	}

	get(runId: string): AgentRunRecord | undefined {
		return this.#records.get(runId);
	}

	async readResult(runId: string): Promise<string | undefined> {
		const record = this.#records.get(runId);
		if (!record || record.status !== "succeeded") return undefined;
		try {
			return await readFile(resolve(record.artifactDirectory, "result.md"), "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async start(
		agentId: string,
		prompt: string,
		source: AgentRunSource = "manual",
		model?: ModelRef,
	): Promise<AgentRunRecord> {
		return this.#queue.run(async () => {
			if (this.#disposed) throw new Error("Agent run manager is disposed");
			if (prompt.trim() === "") throw new Error("Agent run prompt is required");
			if (this.#activeByAgent.has(agentId)) throw new Error(`Agent ${agentId} already has an active run`);
			const definition = await this.#registry.get(agentId);
			if (!definition) throw new Error(`Agent ${agentId} was not found`);
			const runId = randomUUID();
			const artifactDirectory = resolve(this.#artifactsRoot, agentId, runId);
			const record: AgentRunRecord = {
				id: runId,
				agentId,
				prompt: prompt.trim(),
				source,
				status: "starting",
				createdAt: Date.now(),
				artifactDirectory,
				model,
			};
			this.#records.set(runId, record);
			await this.#persistRecord(record);
			try {
				const execution = await this.#executor.start({
					runId,
					definition: model ? { ...definition, model } : definition,
					workspace: this.#registry.workspacePath(definition),
					prompt: record.prompt,
				});
				record.status = "running";
				record.startedAt = Date.now();
				const active: ActiveRun = { record, execution, abortRequested: false };
				this.#activeByAgent.set(agentId, active);
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

	async abort(runId: string): Promise<AgentRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (!active) throw new Error(`Run ${runId} is not active`);
		active.abortRequested = true;
		await active.execution.abort();
		await active.completion;
		return { ...active.record };
	}

	async waitForCompletion(runId: string): Promise<AgentRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (active?.completion) await active.completion;
		const record = this.#records.get(runId);
		if (!record) throw new Error(`Run ${runId} was not found`);
		return { ...record };
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all([...this.#activeByRun.values()].map((active) => active.execution.abort()));
		await Promise.all([...this.#activeByRun.values()].map((active) => active.completion));
		await this.#executor.dispose();
		await this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #settle(active: ActiveRun): Promise<void> {
		const { record, execution } = active;
		try {
			const result = await execution.result;
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
			record.finishedAt = Date.now();
			await this.#persistRecord(record);
			this.#activeByAgent.delete(record.agentId);
			this.#activeByRun.delete(record.id);
			await execution.dispose();
		}
	}

	async #persistRecord(record: AgentRunRecord): Promise<void> {
		await mkdir(record.artifactDirectory, { recursive: true });
		await writeFile(resolve(record.artifactDirectory, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	}
}

function parseRunRecord(value: unknown, artifactDirectory: string): AgentRunRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid run record");
	const record = value as Record<string, unknown>;
	const status = record.status;
	if (!isRunStatus(status)) throw new Error("Invalid run status");
	if (typeof record.id !== "string" || typeof record.agentId !== "string" || typeof record.prompt !== "string") {
		throw new Error("Invalid run identity");
	}
	if (record.source !== "manual" && record.source !== "routine") throw new Error("Invalid run source");
	if (typeof record.createdAt !== "number") throw new Error("Invalid run timestamp");
	return {
		id: record.id,
		agentId: record.agentId,
		prompt: record.prompt,
		source: record.source,
		status,
		createdAt: record.createdAt,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
		finishedAt: typeof record.finishedAt === "number" ? record.finishedAt : undefined,
		artifactDirectory,
		error: typeof record.error === "string" ? record.error : undefined,
		model: record.model === undefined ? undefined : modelRef(record.model),
	};
}

function modelRef(value: unknown): ModelRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid run model");
	const model = value as Record<string, unknown>;
	if (typeof model.provider !== "string" || typeof model.id !== "string") throw new Error("Invalid run model");
	return { provider: model.provider, id: model.id };
}

function isRunStatus(value: unknown): value is AgentRunStatus {
	return (
		value === "starting" || value === "running" || value === "succeeded" || value === "failed" || value === "aborted"
	);
}
