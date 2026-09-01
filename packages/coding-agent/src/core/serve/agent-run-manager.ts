import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type {
	AgentExecution,
	AgentExecutionEvent,
	AgentExecutionPhase,
	AgentExecutionResult,
	AgentExecutor,
} from "./agent-executor.ts";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentRunStatus = "starting" | "running" | "succeeded" | "failed" | "aborted";
export type AgentRunSource = "manual" | "routine";

export interface AgentRunUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

export interface AgentRunRecord {
	id: string;
	agentId: string;
	prompt: string;
	source: AgentRunSource;
	status: AgentRunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	phase?: AgentExecutionPhase;
	progressMessage?: string;
	lastActivityAt?: number;
	lastHeartbeatAt?: number;
	artifactDirectory: string;
	error?: string;
	model?: ModelRef;
	agentRevision: number;
	temporarySourceAgentId?: string;
	usage?: AgentRunUsage;
}

interface ActiveRun {
	record: AgentRunRecord;
	execution: AgentExecution;
	workspaceKey: string;
	workspaceWritable: boolean;
	abortRequested: boolean;
	resourceKeys: string[];
	budget?: AgentDefinition["budget"];
	unsubscribe: () => void;
	progressPersistence: Promise<void>;
	lastProgressPersistedAt: number;
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
	readonly #activeByWorkspace = new Map<string, Set<ActiveRun>>();
	readonly #activeByRun = new Map<string, ActiveRun>();
	readonly #activeByResource = new Map<string, ActiveRun>();
	readonly #maxConcurrentRuns: number;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(registry: AgentRegistry, executor: AgentExecutor, artifactsRoot: string, maxConcurrentRuns = 4) {
		if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
			throw new Error("Agent maxConcurrentRuns must be positive");
		}
		this.#registry = registry;
		this.#executor = executor;
		this.#artifactsRoot = resolve(artifactsRoot);
		this.#maxConcurrentRuns = maxConcurrentRuns;
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

	async availability(agentId: string): Promise<"available" | "agent-busy" | "workspace-busy" | "capacity"> {
		if (this.#activeByAgent.has(agentId)) return "agent-busy";
		if (this.#activeByRun.size >= this.#maxConcurrentRuns) return "capacity";
		const definition = await this.#registry.get(agentId);
		if (!definition) throw new Error(`Agent ${agentId} was not found`);
		const workspace = this.#registry.workspacePath(definition);
		const workspaceKey = process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace);
		if (hasWorkspaceConflict(definition, this.#activeByWorkspace.get(workspaceKey))) return "workspace-busy";
		return resourceKeys(definition).some((key) => this.#activeByResource.has(key)) ? "workspace-busy" : "available";
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

	async readTranscript(runId: string): Promise<readonly unknown[] | undefined> {
		const record = this.#records.get(runId);
		if (!record || record.status !== "succeeded") return undefined;
		try {
			const value: unknown = JSON.parse(
				await readFile(resolve(record.artifactDirectory, "transcript.json"), "utf8"),
			);
			if (!Array.isArray(value)) throw new Error(`Run ${runId} transcript must be an array`);
			return value;
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
			const definition = await this.#registry.get(agentId);
			if (!definition) throw new Error(`Agent ${agentId} was not found`);
			return this.#startDefinition(definition, prompt, source, model);
		});
	}

	async startCandidate(definition: AgentDefinition, prompt: string): Promise<AgentRunRecord> {
		return this.#queue.run(async () => this.#startDefinition(definition, prompt, "manual"));
	}

	async startTemporarySpecialist(sourceAgentId: string, prompt: string, model?: ModelRef): Promise<AgentRunRecord> {
		return this.#queue.run(async () => {
			const sourceDefinition = await this.#registry.get(sourceAgentId);
			if (!sourceDefinition) throw new Error(`Agent ${sourceAgentId} was not found`);
			const definition: AgentDefinition = {
				...sourceDefinition,
				id: `temporary-${randomUUID()}`,
				name: `${sourceDefinition.name} specialist`,
			};
			return this.#startDefinition(definition, prompt, "manual", model, sourceAgentId);
		});
	}

	async abort(runId: string): Promise<AgentRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (!active) {
			const record = this.#records.get(runId);
			if (!record) throw new Error(`Run ${runId} was not found`);
			return { ...record };
		}
		active.abortRequested = true;
		try {
			await active.execution.abort();
		} finally {
			await active.completion;
		}
		return { ...active.record };
	}

	async waitForCompletion(runId: string): Promise<AgentRunRecord> {
		const active = this.#activeByRun.get(runId);
		if (active?.completion) await active.completion;
		const record = this.#records.get(runId);
		if (!record) throw new Error(`Run ${runId} was not found`);
		return { ...record };
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#dispose();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #startDefinition(
		definition: AgentDefinition,
		prompt: string,
		source: AgentRunSource,
		model?: ModelRef,
		temporarySourceAgentId?: string,
	): Promise<AgentRunRecord> {
		if (this.#disposed) throw new Error("Agent run manager is disposed");
		if (prompt.trim() === "") throw new Error("Agent run prompt is required");
		const executionDefinition = model ? { ...definition, model } : definition;
		if (executionDefinition.modelControls !== undefined) this.#registry.validateModelSettings(executionDefinition);
		if (this.#activeByRun.size >= this.#maxConcurrentRuns) throw new Error("Agent run capacity is reached");
		if (this.#activeByAgent.has(definition.id)) throw new Error(`Agent ${definition.id} already has an active run`);
		const workspace = this.#registry.workspacePath(definition);
		const workspaceKey = process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace);
		if (hasWorkspaceConflict(definition, this.#activeByWorkspace.get(workspaceKey))) {
			throw new Error(`Agent project ${workspace} already has an active run`);
		}
		const requiredResources = resourceKeys(definition);
		const busyResource = requiredResources.find((key) => this.#activeByResource.has(key));
		if (busyResource) throw new Error(`Agent resource ${busyResource} already has an active run`);
		const runId = randomUUID();
		const artifactDirectory = resolve(this.#artifactsRoot, definition.id, runId);
		const record: AgentRunRecord = {
			id: runId,
			agentId: definition.id,
			prompt: prompt.trim(),
			source,
			status: "starting",
			createdAt: Date.now(),
			artifactDirectory,
			model,
			agentRevision: definition.revision,
			temporarySourceAgentId,
		};
		this.#records.set(runId, record);
		await this.#persistRecord(record);
		try {
			const execution = await this.#executor.start({
				runId,
				definition: executionDefinition,
				workspace,
				prompt: record.prompt,
			});
			record.status = "running";
			record.startedAt = Date.now();
			record.phase = "initializing";
			record.progressMessage = "Starting isolated agent worker";
			record.lastActivityAt = record.startedAt;
			record.lastHeartbeatAt = record.startedAt;
			const active: ActiveRun = {
				record,
				execution,
				workspaceKey,
				workspaceWritable: definition.permissionPolicy === "workspace-write",
				abortRequested: false,
				resourceKeys: requiredResources,
				budget: definition.budget,
				unsubscribe: () => {},
				progressPersistence: Promise.resolve(),
				lastProgressPersistedAt: record.startedAt,
			};
			active.unsubscribe = execution.subscribe((event) => this.#recordProgress(active, event));
			this.#activeByAgent.set(definition.id, active);
			const workspaceRuns = this.#activeByWorkspace.get(workspaceKey) ?? new Set<ActiveRun>();
			workspaceRuns.add(active);
			this.#activeByWorkspace.set(workspaceKey, workspaceRuns);
			this.#activeByRun.set(runId, active);
			for (const key of requiredResources) this.#activeByResource.set(key, active);
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
			record.usage = summarizeExecutionUsage(result);
			const budgetError = active.abortRequested ? undefined : budgetViolation(record.usage, active.budget);
			record.status = active.abortRequested ? "aborted" : budgetError ? "failed" : "succeeded";
			record.error = budgetError;
		} catch (error) {
			record.status = active.abortRequested ? "aborted" : "failed";
			record.error = error instanceof Error ? error.message : String(error);
		} finally {
			active.unsubscribe();
			await active.progressPersistence;
			try {
				await execution.dispose();
			} catch (error) {
				record.status = active.abortRequested ? "aborted" : "failed";
				record.error = error instanceof Error ? error.message : String(error);
			}
			record.finishedAt = Date.now();
			try {
				await this.#persistRecord(record);
			} catch (error) {
				record.status = "failed";
				record.error = `Run record persistence failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			if (this.#activeByAgent.get(record.agentId) === active) this.#activeByAgent.delete(record.agentId);
			const workspaceRuns = this.#activeByWorkspace.get(active.workspaceKey);
			workspaceRuns?.delete(active);
			if (workspaceRuns?.size === 0) this.#activeByWorkspace.delete(active.workspaceKey);
			if (this.#activeByRun.get(record.id) === active) this.#activeByRun.delete(record.id);
			for (const key of active.resourceKeys) {
				if (this.#activeByResource.get(key) === active) this.#activeByResource.delete(key);
			}
		}
	}

	#recordProgress(active: ActiveRun, event: AgentExecutionEvent): void {
		if (this.#activeByRun.get(active.record.id) !== active) return;
		const phaseChanged = active.record.phase !== event.phase;
		active.record.phase = event.phase;
		active.record.lastHeartbeatAt = event.timestamp;
		if (event.kind === "progress") {
			active.record.progressMessage = event.message;
			active.record.lastActivityAt = event.timestamp;
		}
		if (!phaseChanged && event.timestamp - active.lastProgressPersistedAt < 5_000) return;
		active.lastProgressPersistedAt = event.timestamp;
		active.progressPersistence = active.progressPersistence
			.then(() => this.#persistRecord(active.record))
			.catch((error: unknown) => {
				active.record.error = `Run progress persistence failed: ${error instanceof Error ? error.message : String(error)}`;
			});
	}

	async #dispose(): Promise<void> {
		this.#disposed = true;
		await this.#queue.close();
		const activeRuns = [...this.#activeByRun.values()];
		for (const active of activeRuns) active.abortRequested = true;
		await Promise.allSettled(activeRuns.map((active) => active.execution.abort()));
		await Promise.allSettled(
			activeRuns
				.map((active) => active.completion)
				.filter((completion): completion is Promise<void> => completion !== undefined),
		);
		await this.#executor.dispose();
	}

	async #persistRecord(record: AgentRunRecord): Promise<void> {
		await mkdir(record.artifactDirectory, { recursive: true });
		await writeFile(resolve(record.artifactDirectory, "run.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
	}
}

function resourceKeys(definition: AgentDefinition): string[] {
	return definition.browser?.profile.kind === "named" ? [`browser-profile:${definition.browser.profile.id}`] : [];
}

function hasWorkspaceConflict(definition: AgentDefinition, activeRuns: ReadonlySet<ActiveRun> | undefined): boolean {
	if (!activeRuns || activeRuns.size === 0) return false;
	if (definition.permissionPolicy === "workspace-write") return true;
	return [...activeRuns].some((active) => active.record.agentId !== definition.id && isWorkspaceWriter(active));
}

function isWorkspaceWriter(active: ActiveRun): boolean {
	return active.workspaceWritable;
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
		phase: isExecutionPhase(record.phase) ? record.phase : undefined,
		progressMessage: typeof record.progressMessage === "string" ? record.progressMessage : undefined,
		lastActivityAt: typeof record.lastActivityAt === "number" ? record.lastActivityAt : undefined,
		lastHeartbeatAt: typeof record.lastHeartbeatAt === "number" ? record.lastHeartbeatAt : undefined,
		artifactDirectory,
		error: typeof record.error === "string" ? record.error : undefined,
		model: record.model === undefined ? undefined : modelRef(record.model),
		agentRevision:
			typeof record.agentRevision === "number" &&
			Number.isSafeInteger(record.agentRevision) &&
			record.agentRevision > 0
				? record.agentRevision
				: 1,
		temporarySourceAgentId:
			typeof record.temporarySourceAgentId === "string" ? record.temporarySourceAgentId : undefined,
		usage: record.usage === undefined ? undefined : parseRunUsage(record.usage),
	};
}

function summarizeExecutionUsage(result: AgentExecutionResult): AgentRunUsage {
	const usage: AgentRunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
	for (const message of result.transcript) {
		if (message.role !== "assistant" && message.role !== "toolResult") continue;
		const item = message.usage;
		if (!item) continue;
		usage.inputTokens += item.input;
		usage.outputTokens += item.output;
		usage.totalTokens += item.totalTokens || item.input + item.output + item.cacheRead + item.cacheWrite;
		usage.costUsd += item.cost.total;
	}
	return usage;
}

function budgetViolation(usage: AgentRunUsage, budget: AgentDefinition["budget"]): string | undefined {
	if (budget?.maxTokens !== undefined && usage.outputTokens > budget.maxTokens) {
		return `Agent output token budget exceeded: ${usage.outputTokens} > ${budget.maxTokens}`;
	}
	if (budget?.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) {
		return `Agent cost budget exceeded: ${usage.costUsd} > ${budget.maxCostUsd}`;
	}
	return undefined;
}

function parseRunUsage(value: unknown): AgentRunUsage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid run usage");
	const usage = value as Record<string, unknown>;
	const number = (field: string): number => {
		const item = usage[field];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new Error("Invalid run usage");
		return item;
	};
	return {
		inputTokens: number("inputTokens"),
		outputTokens: number("outputTokens"),
		totalTokens: number("totalTokens"),
		costUsd: number("costUsd"),
	};
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
