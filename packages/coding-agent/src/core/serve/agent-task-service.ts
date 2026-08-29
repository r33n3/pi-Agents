import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import type { AgentRunManager, AgentRunRecord, AgentRunUsage } from "./agent-run-manager.ts";
import { type ArtifactRecord, ArtifactStore } from "./artifact-store.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentTaskSource = "chat" | "pi" | "routine" | "workflow" | "a2a";
export type AgentTaskStatus =
	| "queued"
	| "running"
	| "waiting_for_approval"
	| "waiting_for_input"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export type AgentPermissionMode = "manual" | "safe_auto" | "unrestricted";

export interface AgentTaskContractSnapshot {
	goal: string;
	actor: { kind: "pi" | "agent" | "user" | "routine" | "a2a"; id: string };
	conversationId: string;
	agentId: string;
	agentRevision: number;
	workspaceRoot: string;
	model?: ModelRef;
	capabilityGrantIds: string[];
	providerAccountRefs: string[];
	permissionMode: AgentPermissionMode;
	expectedDeliverable?: { kind?: string; title?: string; artifactId?: string };
	routine?: { id: string; revision: number; scheduledFor: number };
}

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
	contract: AgentTaskContractSnapshot;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	phase?: AgentRunRecord["phase"];
	progressMessage?: string;
	lastActivityAt?: number;
	attemptIds: string[];
	artifactIds: string[];
	usage?: AgentRunUsage;
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
	permissionMode?: AgentPermissionMode;
	expectedDeliverable?: { kind?: string; title?: string; artifactId?: string };
	routine?: { id: string; revision: number; scheduledFor: number };
}

export interface AgentTaskFilter {
	agentId?: string;
	conversationId?: string;
	workflowRunId?: string;
	status?: AgentTaskStatus;
}

export interface AgentTaskEvent {
	id: string;
	sequence: number;
	type:
		| "task.queued"
		| "task.started"
		| "task.stopping"
		| "task.completed"
		| "task.failed"
		| "task.cancelled"
		| "task.interrupted"
		| "approval.requested"
		| "approval.resolved"
		| "input.requested"
		| "input.received"
		| "artifact.created"
		| "artifact.version.created"
		| "attention.dismissed";
	taskId: string;
	agentId: string;
	conversationId: string;
	timestamp: number;
	summary?: string;
	artifactId?: string;
}

export type AttentionKind = "approval" | "question" | "failure" | "completed";
export type AttentionStatus = "open" | "resolved" | "dismissed";

export interface AttentionItem {
	id: string;
	taskId: string;
	attemptId?: string;
	eventSequence: number;
	kind: AttentionKind;
	status: AttentionStatus;
	title: string;
	summary: string;
	actionLabels: string[];
	createdAt: number;
	resolvedAt?: number;
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
	readonly #attentionPath: string;
	readonly #artifacts: ArtifactStore;
	readonly #queue = new SerialOperationQueue();
	readonly #conversations = new Map<string, AgentConversation>();
	readonly #conversationByAgent = new Map<string, string>();
	readonly #tasks = new Map<string, AgentTask>();
	readonly #active = new Map<string, ActiveTask>();
	readonly #completions = new Map<string, TaskCompletion>();
	readonly #eventSequences = new Map<string, number>();
	readonly #attention = new Map<string, AttentionItem>();
	readonly #listeners = new Set<AgentTaskListener>();
	#disposed = false;

	constructor(registry: AgentRegistry, runs: AgentRunManager, root: string) {
		this.#registry = registry;
		this.#runs = runs;
		this.#root = resolve(root);
		this.#conversationsDir = resolve(this.#root, "conversations");
		this.#tasksDir = resolve(this.#root, "tasks");
		this.#attentionPath = resolve(this.#root, "attention", "projection.json");
		this.#artifacts = new ArtifactStore(this.#root);
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.#conversationsDir, { recursive: true }),
			mkdir(this.#tasksDir, { recursive: true }),
			this.#artifacts.initialize(),
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
					this.#tasks.set(task.id, task);
					this.#completions.set(task.id, createCompletion());
					await this.#restoreEvents(task);
					if (
						task.status === "running" ||
						task.status === "stopping" ||
						(task.status === "queued" && task.contract.workspaceRoot === "legacy_unknown")
					) {
						task.status = "interrupted";
						task.finishedAt = Date.now();
						task.error = "Serve host stopped before the local attempt completed";
						await this.#persistTask(task);
						await this.#emit(task, "task.interrupted", task.error);
						this.#completions.get(task.id)?.resolve();
					} else if (
						isTerminalStatus(task.status) ||
						task.status === "waiting_for_approval" ||
						task.status === "waiting_for_input"
					) {
						this.#completions.get(task.id)?.resolve();
					}
				} catch {
					// Malformed task directories are not exposed or resumed.
				}
			}
		}
		await this.#persistAttention();
		await this.#schedule();
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

	async createConversation(agentId: string): Promise<AgentConversation> {
		return this.#queue.run(async () => {
			if (!(await this.#registry.get(agentId))) throw new Error(`Agent ${agentId} was not found`);
			const now = Date.now();
			const conversation: AgentConversation = { id: randomUUID(), agentId, createdAt: now, updatedAt: now };
			this.#conversations.set(conversation.id, conversation);
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
		const definition = await this.#registry.get(request.agentId);
		if (!definition) throw new Error(`Agent ${request.agentId} was not found`);
		const model = request.model ?? definition.model;
		const task: AgentTask = {
			id: randomUUID(),
			conversationId: conversation.id,
			agentId: request.agentId,
			parentTaskId: request.parentTaskId,
			workflowRunId: request.workflowRunId,
			source: request.source,
			status: "queued",
			prompt,
			model,
			contract: createContractSnapshot(
				request,
				definition,
				conversation.id,
				this.#registry.workspacePath(definition),
				model,
			),
			createdAt: Date.now(),
			attemptIds: [],
			artifactIds: [],
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
			permissionMode: task.contract.permissionMode,
			expectedDeliverable: task.contract.expectedDeliverable,
		});
	}

	async retry(taskId: string): Promise<AgentTask> {
		const task = this.#tasks.get(taskId);
		if (!task) throw new Error(`Task ${taskId} was not found`);
		if (task.status !== "failed" && task.status !== "interrupted" && task.status !== "cancelled") {
			throw new Error(`Task ${taskId} cannot be retried from ${task.status}`);
		}
		task.status = "queued";
		task.startedAt = undefined;
		task.finishedAt = undefined;
		task.error = undefined;
		task.result = undefined;
		this.#completions.set(task.id, createCompletion());
		await this.#resolveAttentionForTask(task.id, ["failure"]);
		await this.#persistTask(task);
		await this.#emit(task, "task.queued", "Retry queued");
		await this.#schedule();
		return cloneTask(task);
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
		active.task.status = "stopping";
		await this.#persistTask(active.task);
		await this.#emit(active.task, "task.stopping");
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
		return task ? this.#taskView(task) : undefined;
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
			.map((task) => this.#taskView(task));
	}

	listAttention(status?: AttentionStatus): AttentionItem[] {
		return [...this.#attention.values()]
			.filter((item) => status === undefined || item.status === status)
			.sort((left, right) => attentionPriority(left) - attentionPriority(right) || right.createdAt - left.createdAt)
			.map(cloneAttention);
	}

	async dismissAttention(id: string): Promise<AttentionItem> {
		const item = this.#attention.get(id);
		if (!item) throw new Error(`Attention item ${id} was not found`);
		if (item.kind === "approval" || item.kind === "question") {
			throw new Error("Pending approvals and questions must be resolved from their task");
		}
		const task = this.#tasks.get(item.taskId);
		if (!task) throw new Error(`Task ${item.taskId} was not found`);
		await this.#emit(task, "attention.dismissed", item.id);
		return cloneAttention(item);
	}

	listArtifacts(options: { taskId?: string; agentId?: string; includeArchived?: boolean } = {}): ArtifactRecord[] {
		return this.#artifacts.list(options);
	}

	getArtifact(id: string): ArtifactRecord | undefined {
		return this.#artifacts.get(id);
	}

	readArtifactContent(id: string, versionId?: string) {
		return this.#artifacts.readContent(id, versionId);
	}

	getArtifactVersion(id: string, versionId?: string) {
		return this.#artifacts.getVersion(id, versionId);
	}

	archiveArtifact(id: string): Promise<ArtifactRecord> {
		return this.#artifacts.archive(id);
	}

	deleteArtifact(id: string): Promise<void> {
		const dependent = [...this.#tasks.values()].find(
			(task) =>
				!isTerminalStatus(task.status) &&
				(task.artifactIds.includes(id) || task.contract.expectedDeliverable?.artifactId === id),
		);
		if (dependent) {
			return Promise.reject(new Error(`Artifact ${id} is in use by active task ${dependent.id}`));
		}
		return this.#artifacts.delete(id);
	}

	restoreArtifact(id: string, versionId: string): Promise<ArtifactRecord> {
		const artifact = this.#artifacts.get(id);
		if (!artifact) return Promise.reject(new Error(`Artifact ${id} was not found`));
		return this.#artifacts.restore(id, versionId, artifact.taskId, artifact.attemptId);
	}

	async refreshArtifact(id: string): Promise<AgentTask> {
		const artifact = this.#artifacts.get(id);
		if (!artifact) throw new Error(`Artifact ${id} was not found`);
		const origin = this.#tasks.get(artifact.taskId);
		if (!origin) throw new Error(`Origin task ${artifact.taskId} was not found`);
		return this.submit({
			agentId: origin.agentId,
			prompt: origin.prompt,
			conversationId: origin.conversationId,
			parentTaskId: origin.id,
			source: origin.source,
			model: origin.model,
			permissionMode: origin.contract.permissionMode,
			expectedDeliverable: {
				kind: artifact.kind,
				title: artifact.title,
				artifactId: artifact.id,
			},
		});
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
		task.usage = run.usage ? { ...run.usage } : undefined;
		if (run.status === "succeeded") {
			try {
				task.result = (await this.#runs.readResult(run.id))?.trimEnd() ?? "";
				if (task.source !== "chat" || task.contract.expectedDeliverable) {
					const definition = await this.#registry.get(task.agentId);
					const artifactInput = {
						title: task.contract.expectedDeliverable?.title ?? `${definition?.name ?? task.agentId} result`,
						taskId: task.id,
						attemptId: run.id,
						conversationId: task.conversationId,
						agentId: task.agentId,
						workspaceRoot: task.contract.workspaceRoot,
						sourcePath: resolve(run.artifactDirectory, "result.md"),
						allowedRoot: run.artifactDirectory,
						kind: "markdown" as const,
						safeSummary: task.result.slice(0, 240),
					};
					const targetArtifactId = task.contract.expectedDeliverable?.artifactId;
					const artifact = targetArtifactId
						? await this.#artifacts.addVersion(targetArtifactId, artifactInput)
						: await this.#artifacts.register(artifactInput);
					task.artifactIds.push(artifact.id);
					await this.#emit(
						task,
						targetArtifactId ? "artifact.version.created" : "artifact.created",
						artifact.title,
						artifact.id,
					);
				}
				task.status = "completed";
				await this.#appendMessage(this.#conversations.get(task.conversationId)!, task, "agent", task.result);
				await this.#persistTask(task);
				await this.#emit(task, "task.completed");
			} catch (error) {
				task.status = "failed";
				task.error = `Result persistence failed: ${error instanceof Error ? error.message : String(error)}`;
				await this.#persistTask(task);
				await this.#emit(task, "task.failed", task.error);
			}
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

	#taskView(task: AgentTask): AgentTask {
		const runId = task.attemptIds.at(-1);
		const run = runId ? this.#runs.get(runId) : undefined;
		return cloneTask({
			...task,
			phase: run?.phase,
			progressMessage: run?.progressMessage,
			lastActivityAt: run?.lastActivityAt,
		});
	}

	async #emit(task: AgentTask, type: AgentTaskEvent["type"], summary?: string, artifactId?: string): Promise<void> {
		const sequence = (this.#eventSequences.get(task.id) ?? 0) + 1;
		const event: AgentTaskEvent = {
			id: randomUUID(),
			sequence,
			type,
			taskId: task.id,
			agentId: task.agentId,
			conversationId: task.conversationId,
			timestamp: Date.now(),
			summary: summary === undefined ? undefined : safeTaskSummary(summary),
			artifactId,
		};
		this.#eventSequences.set(task.id, sequence);
		await appendFile(resolve(this.#taskDirectory(task), "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
		await this.#projectAttention(task, event);
		for (const listener of this.#listeners) listener(event);
	}

	async #restoreEvents(task: AgentTask): Promise<void> {
		try {
			const lines = (await readFile(resolve(this.#taskDirectory(task), "events.jsonl"), "utf8"))
				.split(/\r?\n/)
				.filter(Boolean);
			let sequence = 0;
			for (const line of lines) {
				sequence += 1;
				const event = parseTaskEvent(JSON.parse(line), task, sequence);
				this.#eventSequences.set(task.id, Math.max(this.#eventSequences.get(task.id) ?? 0, event.sequence));
				await this.#projectAttention(task, event, false);
			}
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
	}

	async #projectAttention(task: AgentTask, event: AgentTaskEvent, persist = true): Promise<void> {
		if (event.type === "attention.dismissed") {
			const existing = event.summary ? this.#attention.get(event.summary) : undefined;
			if (!existing || existing.taskId !== task.id) return;
			existing.status = "dismissed";
			existing.resolvedAt = event.timestamp;
			if (persist) await this.#persistAttention();
			return;
		}
		if (event.type === "task.queued" && event.sequence > 1) {
			let changed = false;
			for (const existing of this.#attention.values()) {
				if (existing.taskId !== task.id || existing.kind !== "failure" || existing.status !== "open") continue;
				existing.status = "resolved";
				existing.resolvedAt = event.timestamp;
				changed = true;
			}
			if (persist && changed) await this.#persistAttention();
			return;
		}
		const key = `${task.id}:${event.type}:${event.sequence}`;
		let item: AttentionItem | undefined;
		if (event.type === "task.failed" || event.type === "task.interrupted") {
			item = {
				id: key,
				taskId: task.id,
				attemptId: task.attemptIds.at(-1),
				eventSequence: event.sequence,
				kind: "failure",
				status: "open",
				title: event.type === "task.interrupted" ? "Run interrupted" : "Run failed",
				summary: safeTaskSummary(event.summary ?? task.error ?? task.prompt),
				actionLabels: ["Open", "Retry", "Dismiss"],
				createdAt: event.timestamp,
			};
		} else if (event.type === "task.completed" && task.source !== "chat") {
			item = {
				id: key,
				taskId: task.id,
				attemptId: task.attemptIds.at(-1),
				eventSequence: event.sequence,
				kind: "completed",
				status: "open",
				title: "Work completed",
				summary: safeTaskSummary(task.result || task.prompt),
				actionLabels: task.artifactIds.length > 0 ? ["Open result", "Dismiss"] : ["Open", "Dismiss"],
				createdAt: event.timestamp,
			};
		}
		if (!item || this.#attention.has(key)) return;
		this.#attention.set(key, item);
		if (persist) await this.#persistAttention();
	}

	async #resolveAttentionForTask(taskId: string, kinds: AttentionKind[]): Promise<void> {
		let changed = false;
		for (const item of this.#attention.values()) {
			if (item.taskId !== taskId || item.status !== "open" || !kinds.includes(item.kind)) continue;
			item.status = "resolved";
			item.resolvedAt = Date.now();
			changed = true;
		}
		if (changed) await this.#persistAttention();
	}

	async #persistAttention(): Promise<void> {
		await writeAtomic(
			this.#attentionPath,
			`${JSON.stringify({ version: 1, items: [...this.#attention.values()] }, null, 2)}\n`,
		);
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
	return {
		...task,
		model: task.model ? { ...task.model } : undefined,
		contract: cloneContract(task.contract),
		attemptIds: [...task.attemptIds],
		artifactIds: [...task.artifactIds],
		usage: task.usage ? { ...task.usage } : undefined,
	};
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
		contract: record.contract === undefined ? legacyContract(record) : parseContract(record.contract),
		createdAt: requiredNumber(record.createdAt, "task.createdAt"),
		startedAt: optionalNumber(record.startedAt),
		finishedAt: optionalNumber(record.finishedAt),
		attemptIds: [...record.attemptIds],
		artifactIds:
			Array.isArray(record.artifactIds) && record.artifactIds.every((entry) => typeof entry === "string")
				? [...record.artifactIds]
				: [],
		usage: record.usage === undefined ? undefined : parseTaskUsage(record.usage),
		result: optionalString(record.result),
		error: optionalString(record.error),
	};
}

function parseTaskUsage(value: unknown): AgentRunUsage {
	const record = object(value, "task usage");
	const number = (field: string): number => {
		const item = record[field];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
			throw new Error(`Invalid task usage ${field}`);
		}
		return item;
	};
	return {
		inputTokens: number("inputTokens"),
		outputTokens: number("outputTokens"),
		totalTokens: number("totalTokens"),
		costUsd: number("costUsd"),
	};
}

function parseModel(value: unknown): ModelRef {
	const record = object(value, "task model");
	return { provider: requiredString(record.provider, "model.provider"), id: requiredString(record.id, "model.id") };
}

function createContractSnapshot(
	request: SubmitAgentTask,
	definition: AgentDefinition,
	conversationId: string,
	workspaceRoot: string,
	model: ModelRef | undefined,
): AgentTaskContractSnapshot {
	const capabilityGrantIds = definition.capabilities.map((grant) =>
		[`${grant.capabilityId}@${grant.capabilityVersion}`, grant.providerId, grant.connectionId]
			.filter(Boolean)
			.join(":"),
	);
	const providerAccountRefs = definition.capabilities
		.map((grant) => grant.connectionId)
		.filter((value): value is string => value !== undefined);
	return {
		goal: request.prompt.trim(),
		actor: taskActor(request),
		conversationId,
		agentId: definition.id,
		agentRevision: definition.revision,
		workspaceRoot,
		model: model ? { ...model } : undefined,
		capabilityGrantIds,
		providerAccountRefs: [...new Set(providerAccountRefs)],
		permissionMode:
			request.permissionMode ?? (definition.permissionPolicy === "workspace-write" ? "safe_auto" : "manual"),
		expectedDeliverable: request.expectedDeliverable ? { ...request.expectedDeliverable } : undefined,
		routine: request.routine ? { ...request.routine } : undefined,
	};
}

function taskActor(request: SubmitAgentTask): AgentTaskContractSnapshot["actor"] {
	if (request.source === "routine") return { kind: "routine", id: request.routine?.id ?? request.agentId };
	if (request.source === "a2a") return { kind: "a2a", id: request.agentId };
	if (request.source === "pi") return { kind: "pi", id: request.agentId };
	if (request.source === "workflow") return { kind: "agent", id: request.parentTaskId ?? request.agentId };
	return { kind: "user", id: "local-user" };
}

function parseContract(value: unknown): AgentTaskContractSnapshot {
	const record = object(value, "task contract");
	const actor = object(record.actor, "task actor");
	const kind = actor.kind;
	if (kind !== "pi" && kind !== "agent" && kind !== "user" && kind !== "routine" && kind !== "a2a") {
		throw new Error("Invalid task actor kind");
	}
	const permissionMode = record.permissionMode;
	if (permissionMode !== "manual" && permissionMode !== "safe_auto" && permissionMode !== "unrestricted") {
		throw new Error("Invalid task permission mode");
	}
	if (
		!Array.isArray(record.capabilityGrantIds) ||
		!record.capabilityGrantIds.every((entry) => typeof entry === "string")
	) {
		throw new Error("Invalid task capability grants");
	}
	if (
		!Array.isArray(record.providerAccountRefs) ||
		!record.providerAccountRefs.every((entry) => typeof entry === "string")
	) {
		throw new Error("Invalid task provider accounts");
	}
	return {
		goal: requiredString(record.goal, "contract.goal"),
		actor: { kind, id: requiredString(actor.id, "contract.actor.id") },
		conversationId: requiredString(record.conversationId, "contract.conversationId"),
		agentId: requiredString(record.agentId, "contract.agentId"),
		agentRevision: requiredNumber(record.agentRevision, "contract.agentRevision"),
		workspaceRoot: requiredString(record.workspaceRoot, "contract.workspaceRoot"),
		model: record.model === undefined ? undefined : parseModel(record.model),
		capabilityGrantIds: [...record.capabilityGrantIds],
		providerAccountRefs: [...record.providerAccountRefs],
		permissionMode,
		expectedDeliverable: parseDeliverable(record.expectedDeliverable),
		routine: parseRoutineSnapshot(record.routine),
	};
}

function legacyContract(record: Record<string, unknown>): AgentTaskContractSnapshot {
	const model = record.model === undefined ? undefined : parseModel(record.model);
	return {
		goal: requiredString(record.prompt, "task.prompt"),
		actor: { kind: "agent", id: requiredString(record.agentId, "task.agentId") },
		conversationId: requiredString(record.conversationId, "task.conversationId"),
		agentId: requiredString(record.agentId, "task.agentId"),
		agentRevision: 1,
		workspaceRoot: "legacy_unknown",
		model,
		capabilityGrantIds: [],
		providerAccountRefs: [],
		permissionMode: "manual",
	};
}

function parseDeliverable(value: unknown): { kind?: string; title?: string; artifactId?: string } | undefined {
	if (value === undefined) return undefined;
	const record = object(value, "expected deliverable");
	return {
		kind: optionalString(record.kind),
		title: optionalString(record.title),
		artifactId: optionalString(record.artifactId),
	};
}

function parseRoutineSnapshot(value: unknown): { id: string; revision: number; scheduledFor: number } | undefined {
	if (value === undefined) return undefined;
	const record = object(value, "routine snapshot");
	return {
		id: requiredString(record.id, "routine.id"),
		revision: requiredNumber(record.revision, "routine.revision"),
		scheduledFor: requiredNumber(record.scheduledFor, "routine.scheduledFor"),
	};
}

function cloneContract(contract: AgentTaskContractSnapshot): AgentTaskContractSnapshot {
	return {
		...contract,
		actor: { ...contract.actor },
		model: contract.model ? { ...contract.model } : undefined,
		capabilityGrantIds: [...contract.capabilityGrantIds],
		providerAccountRefs: [...contract.providerAccountRefs],
		expectedDeliverable: contract.expectedDeliverable ? { ...contract.expectedDeliverable } : undefined,
		routine: contract.routine ? { ...contract.routine } : undefined,
	};
}

function parseTaskEvent(value: unknown, task: AgentTask, fallbackSequence: number): AgentTaskEvent {
	const record = object(value, "task event");
	const type = record.type;
	if (!isTaskEventType(type)) throw new Error("Invalid task event type");
	return {
		id: typeof record.id === "string" ? record.id : `legacy-${task.id}-${fallbackSequence}`,
		sequence:
			typeof record.sequence === "number" && Number.isSafeInteger(record.sequence) && record.sequence > 0
				? record.sequence
				: fallbackSequence,
		type,
		taskId: typeof record.taskId === "string" ? record.taskId : task.id,
		agentId: typeof record.agentId === "string" ? record.agentId : task.agentId,
		conversationId: typeof record.conversationId === "string" ? record.conversationId : task.conversationId,
		timestamp: requiredNumber(record.timestamp, "event.timestamp"),
		summary: optionalString(record.summary) ? safeTaskSummary(String(record.summary)) : undefined,
		artifactId: optionalString(record.artifactId),
	};
}

function isTaskEventType(value: unknown): value is AgentTaskEvent["type"] {
	return [
		"task.queued",
		"task.started",
		"task.stopping",
		"task.completed",
		"task.failed",
		"task.cancelled",
		"task.interrupted",
		"approval.requested",
		"approval.resolved",
		"input.requested",
		"input.received",
		"artifact.created",
		"artifact.version.created",
		"attention.dismissed",
	].includes(String(value));
}

function attentionPriority(item: AttentionItem): number {
	if (item.kind === "approval") return 0;
	if (item.kind === "question") return 1;
	if (item.kind === "failure") return 2;
	return 3;
}

function cloneAttention(item: AttentionItem): AttentionItem {
	return { ...item, actionLabels: [...item.actionLabels] };
}

function safeTaskSummary(value: string): string {
	return value
		.replace(/authorization\s*[:=]\s*(?:Bearer\s+)?\S+/gi, "Authorization=[redacted]")
		.replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
		.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[path]")
		.replace(/\/(?:Users|home|tmp|etc|var)\/\S+/g, "[path]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 240);
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
		value === "queued" ||
		value === "running" ||
		value === "waiting_for_approval" ||
		value === "waiting_for_input" ||
		value === "stopping" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "interrupted"
	);
}

function isTerminalStatus(value: AgentTaskStatus): boolean {
	return value === "completed" || value === "failed" || value === "cancelled" || value === "interrupted";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
