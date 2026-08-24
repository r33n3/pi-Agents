import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRunManager, AgentRunRecord } from "./agent-run-manager.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentTaskSource = "chat" | "pi" | "routine" | "workflow" | "a2a";
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentConversation {
	id: string;
	agentId: string;
	createdAt: number;
	updatedAt: number;
}

export interface AgentConversationMessage {
	id: string;
	conversationId: string;
	role: "user" | "agent";
	text: string;
	taskId: string;
	createdAt: number;
}

export interface AgentTask {
	id: string;
	conversationId: string;
	agentId: string;
	parentTaskId?: string;
	workflowRunId?: string;
	source: AgentTaskSource;
	status: AgentTaskStatus;
	prompt: string;
	model?: ModelRef;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	attemptIds: string[];
	result?: string;
	error?: string;
}

export interface SubmitAgentTask {
	agentId: string;
	prompt: string;
	conversationId?: string;
	parentTaskId?: string;
	workflowRunId?: string;
	source: AgentTaskSource;
	model?: ModelRef;
}

export interface AgentTaskFilter {
	agentId?: string;
	conversationId?: string;
	workflowRunId?: string;
	status?: AgentTaskStatus;
}

export interface AgentTaskEvent {
	type: "task.queued" | "task.started" | "task.completed" | "task.failed" | "task.cancelled";
	taskId: string;
	agentId: string;
	conversationId: string;
	timestamp: number;
	summary?: string;
}

export type AgentTaskListener = (event: AgentTaskEvent) => void;

interface ActiveTask {
	task: AgentTask;
	runId: string;
	completion: Promise<void>;
}

interface TaskCompletion {
	promise: Promise<void>;
	resolve: () => void;
}

/** Owns durable agent conversations and maps each task to one executor attempt. */
export class AgentTaskService implements AsyncDisposable {
	readonly #registry: AgentRegistry;
	readonly #runs: AgentRunManager;
	readonly #root: string;
	readonly #conversationsDir: string;
	readonly #tasksDir: string;
	readonly #queue = new SerialOperationQueue();
	readonly #conversations = new Map<string, AgentConversation>();
	readonly #conversationByAgent = new Map<string, string>();
	readonly #tasks = new Map<string, AgentTask>();
	readonly #active = new Map<string, ActiveTask>();
	readonly #completions = new Map<string, TaskCompletion>();
	readonly #listeners = new Set<AgentTaskListener>();
	#disposed = false;

	constructor(registry: AgentRegistry, runs: AgentRunManager, root: string) {
		this.#registry = registry;
		this.#runs = runs;
		this.#root = resolve(root);
		this.#conversationsDir = resolve(this.#root, "conversations");
		this.#tasksDir = resolve(this.#root, "tasks");
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.#conversationsDir, { recursive: true }),
			mkdir(this.#tasksDir, { recursive: true }),
		]);
		for (const entry of await readdir(this.#conversationsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const conversation = parseConversation(
					JSON.parse(await readFile(resolve(this.#conversationsDir, entry.name, "conversation.json"), "utf8")),
				);
				this.#conversations.set(conversation.id, conversation);
				const currentId = this.#conversationByAgent.get(conversation.agentId);
				const current = currentId ? this.#conversations.get(currentId) : undefined;
				if (!current || current.updatedAt < conversation.updatedAt) {
					this.#conversationByAgent.set(conversation.agentId, conversation.id);
				}
			} catch {
				// Malformed conversation directories are not exposed.
			}
		}
		for (const agentEntry of await readdir(this.#tasksDir, { withFileTypes: true })) {
			if (!agentEntry.isDirectory()) continue;
			const agentRoot = resolve(this.#tasksDir, agentEntry.name);
			for (const taskEntry of await readdir(agentRoot, { withFileTypes: true })) {
				if (!taskEntry.isDirectory()) continue;
				try {
					const task = parseTask(
						JSON.parse(await readFile(resolve(agentRoot, taskEntry.name, "task.json"), "utf8")),
					);
					if (task.status === "queued" || task.status === "running") {
						task.status = "failed";
						task.finishedAt = Date.now();
						task.error = "Serve host stopped before the task completed";
						await this.#persistTask(task);
					}
					this.#tasks.set(task.id, task);
				} catch {
					// Malformed task directories are not exposed or resumed.
				}
			}
		}
	}

	async ensureConversation(agentId: string): Promise<AgentConversation> {
		return this.#queue.run(async () => {
			if (!(await this.#registry.get(agentId))) throw new Error(`Agent ${agentId} was not found`);
			const existingId = this.#conversationByAgent.get(agentId);
			const existing = existingId ? this.#conversations.get(existingId) : undefined;
			if (existing) return { ...existing };
			const now = Date.now();
			const conversation: AgentConversation = { id: randomUUID(), agentId, createdAt: now, updatedAt: now };
			this.#conversations.set(conversation.id, conversation);
			this.#conversationByAgent.set(agentId, conversation.id);
			await this.#persistConversation(conversation);
			return { ...conversation };
		});
	}

	listConversations(agentId?: string): AgentConversation[] {
		return [...this.#conversations.values()]
			.filter((entry) => agentId === undefined || entry.agentId === agentId)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.map((entry) => ({ ...entry }));
	}

	async listMessages(conversationId: string): Promise<AgentConversationMessage[]> {
		const conversation = this.#conversations.get(conversationId);
		if (!conversation) throw new Error(`Conversation ${conversationId} was not found`);
		try {
			const content = await readFile(this.#messagesPath(conversationId), "utf8");
			return content
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => parseMessage(JSON.parse(line)));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}

	async submit(request: SubmitAgentTask): Promise<AgentTask> {
		if (this.#disposed) throw new Error("Agent task service is disposed");
		const prompt = request.prompt.trim();
		if (!prompt) throw new Error("Agent task prompt is required");
		const conversation = request.conversationId
			? this.#conversations.get(request.conversationId)
			: await this.ensureConversation(request.agentId);
		if (!conversation || conversation.agentId !== request.agentId) {
			throw new Error("Conversation does not belong to the requested agent");
		}
		const task: AgentTask = {
			id: randomUUID(),
			conversationId: conversation.id,
			agentId: request.agentId,
			parentTaskId: request.parentTaskId,
			workflowRunId: request.workflowRunId,
			source: request.source,
			status: "queued",
			prompt,
			model: request.model,
			createdAt: Date.now(),
			attemptIds: [],
		};
		this.#tasks.set(task.id, task);
		this.#completions.set(task.id, createCompletion());
		await this.#persistTask(task);
		await this.#appendMessage(conversation, task, "user", prompt);
		await this.#emit(task, "task.queued");
		await this.#schedule();
		return cloneTask(task);
	}

	continue(taskId: string, message: string): Promise<AgentTask> {
		const task = this.#tasks.get(taskId);
		if (!task) return Promise.reject(new Error(`Task ${taskId} was not found`));
		return this.submit({
			agentId: task.agentId,
			conversationId: task.conversationId,
			parentTaskId: task.id,
			workflowRunId: task.workflowRunId,
			source: task.source,
			prompt: message,
			model: task.model,
		});
	}

	async cancel(taskId: string): Promise<AgentTask> {
		const active = this.#active.get(taskId);
		if (!active) {
			const queued = this.#tasks.get(taskId);
			if (!queued) throw new Error(`Task ${taskId} was not found`);
			if (queued.status !== "queued") return cloneTask(queued);
			queued.status = "cancelled";
			queued.finishedAt = Date.now();
			await this.#persistTask(queued);
			await this.#emit(queued, "task.cancelled");
			this.#completions.get(taskId)?.resolve();
			return cloneTask(queued);
		}
		await this.#runs.abort(active.runId);
		await active.completion;
		return cloneTask(active.task);
	}

	waitForCompletion(taskId: string): Promise<AgentTask> {
		const completion = this.#completions.get(taskId)?.promise ?? this.#active.get(taskId)?.completion;
		return (completion ?? Promise.resolve()).then(() => {
			const task = this.#tasks.get(taskId);
			if (!task) throw new Error(`Task ${taskId} was not found`);
			return cloneTask(task);
		});
	}

	getTask(taskId: string): AgentTask | undefined {
		const task = this.#tasks.get(taskId);
		return task ? cloneTask(task) : undefined;
	}

	listTasks(filter: AgentTaskFilter = {}): AgentTask[] {
		return [...this.#tasks.values()]
			.filter(
				(task) =>
					(filter.agentId === undefined || task.agentId === filter.agentId) &&
					(filter.conversationId === undefined || task.conversationId === filter.conversationId) &&
					(filter.workflowRunId === undefined || task.workflowRunId === filter.workflowRunId) &&
					(filter.status === undefined || task.status === filter.status),
			)
			.sort((left, right) => right.createdAt - left.createdAt)
			.map(cloneTask);
	}

	subscribe(listener: AgentTaskListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all(
			[...this.#active.values()].map((entry) => this.#runs.abort(entry.runId).catch(() => undefined)),
		);
		await Promise.all([...this.#active.values()].map((entry) => entry.completion));
		await this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #settle(active: ActiveTask): Promise<void> {
		const run = await this.#runs.waitForCompletion(active.runId);
		const task = active.task;
		task.finishedAt = run.finishedAt ?? Date.now();
		if (run.status === "succeeded") {
			task.status = "completed";
			task.result = (await this.#runs.readResult(run.id))?.trimEnd() ?? "";
			await this.#appendMessage(this.#conversations.get(task.conversationId)!, task, "agent", task.result);
			await this.#persistTask(task);
			await this.#emit(task, "task.completed");
		} else if (run.status === "aborted") {
			task.status = "cancelled";
			task.error = run.error;
			await this.#persistTask(task);
			await this.#emit(task, "task.cancelled", task.error);
		} else {
			task.status = "failed";
			task.error = run.error ?? `Agent attempt ${run.status}`;
			await this.#persistTask(task);
			await this.#emit(task, "task.failed", task.error);
		}
		this.#active.delete(task.id);
		this.#completions.get(task.id)?.resolve();
		void this.#schedule();
	}

	async #schedule(): Promise<void> {
		await this.#queue.run(async () => {
			if (this.#disposed) return;
			const queued = [...this.#tasks.values()]
				.filter((task) => task.status === "queued")
				.sort((left, right) => left.createdAt - right.createdAt);
			for (const task of queued) {
				if ((await this.#runs.availability(task.agentId)) !== "available") continue;
				try {
					const run = await this.#runs.start(
						task.agentId,
						task.prompt,
						taskSourceToRunSource(task.source),
						task.model,
					);
					task.status = "running";
					task.startedAt = run.startedAt ?? Date.now();
					task.attemptIds.push(run.id);
					await this.#persistTask(task);
					await this.#emit(task, "task.started");
					const active: ActiveTask = { task, runId: run.id, completion: Promise.resolve() };
					this.#active.set(task.id, active);
					active.completion = this.#settle(active);
				} catch (error) {
					task.status = "failed";
					task.finishedAt = Date.now();
					task.error = error instanceof Error ? error.message : String(error);
					await this.#persistTask(task);
					await this.#emit(task, "task.failed", task.error);
					this.#completions.get(task.id)?.resolve();
				}
			}
		});
	}

	async #appendMessage(
		conversation: AgentConversation,
		task: AgentTask,
		role: AgentConversationMessage["role"],
		text: string,
	): Promise<void> {
		const message: AgentConversationMessage = {
			id: randomUUID(),
			conversationId: conversation.id,
			role,
			text,
			taskId: task.id,
			createdAt: Date.now(),
		};
		await mkdir(dirname(this.#messagesPath(conversation.id)), { recursive: true });
		await appendFile(this.#messagesPath(conversation.id), `${JSON.stringify(message)}\n`, "utf8");
		conversation.updatedAt = message.createdAt;
		await this.#persistConversation(conversation);
	}

	async #emit(task: AgentTask, type: AgentTaskEvent["type"], summary?: string): Promise<void> {
		const event: AgentTaskEvent = {
			type,
			taskId: task.id,
			agentId: task.agentId,
			conversationId: task.conversationId,
			timestamp: Date.now(),
			summary,
		};
		await appendFile(resolve(this.#taskDirectory(task), "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
		for (const listener of this.#listeners) listener(event);
	}

	#messagesPath(conversationId: string): string {
		return resolve(this.#conversationsDir, conversationId, "messages.jsonl");
	}

	#taskDirectory(task: AgentTask): string {
		return resolve(this.#tasksDir, task.agentId, task.id);
	}

	async #persistConversation(conversation: AgentConversation): Promise<void> {
		await writeAtomic(
			resolve(this.#conversationsDir, conversation.id, "conversation.json"),
			`${JSON.stringify(conversation, null, 2)}\n`,
		);
	}

	async #persistTask(task: AgentTask): Promise<void> {
		await writeAtomic(resolve(this.#taskDirectory(task), "task.json"), `${JSON.stringify(task, null, 2)}\n`);
	}
}

function taskSourceToRunSource(source: AgentTaskSource): AgentRunRecord["source"] {
	return source === "routine" ? "routine" : "manual";
}

function cloneTask(task: AgentTask): AgentTask {
	return { ...task, model: task.model ? { ...task.model } : undefined, attemptIds: [...task.attemptIds] };
}

function createCompletion(): TaskCompletion {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((settled) => {
		resolve = settled;
	});
	return { promise, resolve };
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

function parseConversation(value: unknown): AgentConversation {
	const record = object(value, "conversation");
	return {
		id: requiredString(record.id, "conversation.id"),
		agentId: requiredString(record.agentId, "conversation.agentId"),
		createdAt: requiredNumber(record.createdAt, "conversation.createdAt"),
		updatedAt: requiredNumber(record.updatedAt, "conversation.updatedAt"),
	};
}

function parseMessage(value: unknown): AgentConversationMessage {
	const record = object(value, "conversation message");
	const role = record.role;
	if (role !== "user" && role !== "agent") throw new Error("Invalid conversation message role");
	return {
		id: requiredString(record.id, "message.id"),
		conversationId: requiredString(record.conversationId, "message.conversationId"),
		role,
		text: typeof record.text === "string" ? record.text : "",
		taskId: requiredString(record.taskId, "message.taskId"),
		createdAt: requiredNumber(record.createdAt, "message.createdAt"),
	};
}

function parseTask(value: unknown): AgentTask {
	const record = object(value, "agent task");
	const source = record.source;
	if (!isTaskSource(source)) throw new Error("Invalid task source");
	const status = record.status;
	if (!isTaskStatus(status)) throw new Error("Invalid task status");
	if (!Array.isArray(record.attemptIds) || !record.attemptIds.every((entry) => typeof entry === "string")) {
		throw new Error("Invalid task attempts");
	}
	return {
		id: requiredString(record.id, "task.id"),
		conversationId: requiredString(record.conversationId, "task.conversationId"),
		agentId: requiredString(record.agentId, "task.agentId"),
		parentTaskId: optionalString(record.parentTaskId),
		workflowRunId: optionalString(record.workflowRunId),
		source,
		status,
		prompt: requiredString(record.prompt, "task.prompt"),
		model: record.model === undefined ? undefined : parseModel(record.model),
		createdAt: requiredNumber(record.createdAt, "task.createdAt"),
		startedAt: optionalNumber(record.startedAt),
		finishedAt: optionalNumber(record.finishedAt),
		attemptIds: [...record.attemptIds],
		result: optionalString(record.result),
		error: optionalString(record.error),
	};
}

function parseModel(value: unknown): ModelRef {
	const record = object(value, "task model");
	return { provider: requiredString(record.provider, "model.provider"), id: requiredString(record.id, "model.id") };
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value) throw new Error(`${name} must be a string`);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isTaskSource(value: unknown): value is AgentTaskSource {
	return value === "chat" || value === "pi" || value === "routine" || value === "workflow" || value === "a2a";
}

function isTaskStatus(value: unknown): value is AgentTaskStatus {
	return (
		value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
