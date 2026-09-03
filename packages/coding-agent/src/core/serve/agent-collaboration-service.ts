import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	type AgentDeliveryContextRef,
	type AgentDeliveryEnvelope,
	AgentDeliveryError,
	type AgentDeliverySender,
	type AgentResolvedDeliveryContextRef,
	type SubmitAgentDelivery,
} from "./agent-collaboration-contract.ts";
import type { AgentContextAuthor, AgentContextReference } from "./agent-context-package.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";
import type { AgentTask, AgentTaskService, AgentTaskStatus } from "./agent-task-service.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface AgentDeliveryReceipt {
	deliveryId: string;
	taskId: string;
	conversationId: string;
	recipientAgentId: string;
	status: AgentTaskStatus;
	latestEventSequence: number;
	resultSummary?: string;
	artifactIds: string[];
	error?: { code: string; message: string };
}

export interface AgentCollaborationServiceOptions {
	assertLiveSession?: (sessionId: string) => void;
	maxDelegationDepth?: number;
	maxDirectChildren?: number;
}

interface DeliveryIndexEntry {
	idempotencyScope: string;
	idempotencyKey: string;
	requestDigest: string;
	deliveryId: string;
	taskId: string;
}

/** Admits durable, idempotent direct work while leaving execution and authority with existing owners. */
export class AgentCollaborationService implements AsyncDisposable {
	readonly #registry: AgentRegistry;
	readonly #runs: AgentRunManager;
	readonly #tasks: AgentTaskService;
	readonly #indexPath: string;
	readonly #queue = new SerialOperationQueue();
	readonly #byScopedKey = new Map<string, DeliveryIndexEntry>();
	readonly #byDeliveryId = new Map<string, DeliveryIndexEntry>();
	readonly #options: Required<Pick<AgentCollaborationServiceOptions, "maxDelegationDepth" | "maxDirectChildren">> &
		Pick<AgentCollaborationServiceOptions, "assertLiveSession">;

	constructor(
		root: string,
		registry: AgentRegistry,
		runs: AgentRunManager,
		tasks: AgentTaskService,
		options: AgentCollaborationServiceOptions = {},
	) {
		this.#registry = registry;
		this.#runs = runs;
		this.#tasks = tasks;
		this.#indexPath = resolve(root, "collaboration", "delivery-index.json");
		this.#options = {
			assertLiveSession: options.assertLiveSession,
			maxDelegationDepth: options.maxDelegationDepth ?? 4,
			maxDirectChildren: options.maxDirectChildren ?? 8,
		};
	}

	async initialize(): Promise<void> {
		for (const task of this.#tasks.listTasks()) {
			const envelope = task.contract.delivery;
			if (!envelope) continue;
			if (envelope.taskId !== task.id || envelope.recipientAgentId !== task.agentId) {
				throw new Error(`Delivery ${envelope.id} does not match task ${task.id}`);
			}
			this.#index(envelope);
			await this.#tasks.ensureDeliveryMessage(task.id);
		}
		await this.#persistIndex();
	}

	dispose(): Promise<void> {
		return this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async submit(sender: AgentDeliverySender, request: SubmitAgentDelivery): Promise<AgentDeliveryReceipt> {
		return this.#queue.run(async () => {
			validateRequest(request);
			const scope = senderScope(sender);
			await this.#authorizeSender(sender, request.recipientAgentId);
			const resolvedRefs = await Promise.all(
				request.contextRefs.map((reference) => this.#resolveReference(sender, reference)),
			);
			const requestDigest = digest(
				canonicalClone({
					recipientAgentId: request.recipientAgentId,
					goal: request.goal.trim(),
					contextRefs: resolvedRefs,
					expectedDeliverable: request.expectedDeliverable,
				}),
			);
			const key = scopedKey(scope, request.idempotencyKey);
			const existing = this.#byScopedKey.get(key);
			if (existing) {
				if (existing.requestDigest !== requestDigest) {
					throw new AgentDeliveryError(
						"invalid_request",
						"The idempotency key is already bound to different delivery content",
					);
				}
				return this.#receipt(existing.taskId);
			}

			const recipient = await this.#registry.get(request.recipientAgentId);
			if (!recipient) throw new AgentDeliveryError("recipient_unavailable", "The recipient agent is unavailable");
			const inbox = await this.#tasks.ensureAgentInbox(recipient.id);
			const executionSeed = await this.#runs.createExecutionSeed(recipient.id);
			const context = await this.#tasks.createContext(
				recipient.id,
				request.goal,
				resolvedRefs.map(toContextReference),
			);
			const deliveryId = randomUUID();
			const taskId = randomUUID();
			const envelope: AgentDeliveryEnvelope = {
				version: 1,
				id: deliveryId,
				idempotencyScope: scope,
				idempotencyKey: request.idempotencyKey,
				requestDigest,
				sender: structuredClone(sender),
				recipientAgentId: recipient.id,
				recipientRevision: executionSeed.agentRevision,
				conversationId: inbox.id,
				taskId,
				parentTaskId: sender.kind === "agent" ? sender.taskId : undefined,
				goal: request.goal.trim(),
				contextRefs: resolvedRefs,
				expectedDeliverable: request.expectedDeliverable ? { ...request.expectedDeliverable } : undefined,
				createdAt: Date.now(),
			};
			const task = await this.#tasks.submit({
				taskId,
				agentId: recipient.id,
				conversationId: inbox.id,
				parentTaskId: envelope.parentTaskId,
				source: taskSource(sender),
				prompt: envelope.goal,
				expectedDeliverable: envelope.expectedDeliverable,
				executionSeed,
				context,
				delivery: envelope,
				messageId: `delivery:${deliveryId}:request`,
				eventId: `delivery:${deliveryId}:queued`,
				messageAuthor: senderAuthor(
					sender,
					sender.kind === "agent" ? this.#tasks.getTask(sender.taskId)?.contract.agentRevision : undefined,
				),
			});
			this.#index(envelope);
			await this.#persistIndex();
			return receiptFromTask(task, deliveryId, this.#tasks.getLatestEventSequence(task.id));
		});
	}

	get(deliveryId: string): AgentDeliveryReceipt | undefined {
		const entry = this.#byDeliveryId.get(deliveryId);
		return entry ? this.#receipt(entry.taskId) : undefined;
	}

	async inspect(deliveryId: string, sender: AgentDeliverySender): Promise<AgentDeliveryReceipt> {
		const entry = this.#byDeliveryId.get(deliveryId);
		if (!entry) throw new AgentDeliveryError("invalid_request", `Delivery ${deliveryId} was not found`);
		const task = this.#tasks.getTask(entry.taskId);
		if (!task?.contract.delivery) throw new AgentDeliveryError("internal", "Delivery task is unavailable");
		await this.#assertDeliveryOwner(sender, task);
		return this.#receipt(task.id);
	}

	async cancel(deliveryId: string, sender?: AgentDeliverySender): Promise<AgentDeliveryReceipt> {
		const entry = this.#byDeliveryId.get(deliveryId);
		if (!entry) throw new AgentDeliveryError("invalid_request", `Delivery ${deliveryId} was not found`);
		const task = this.#tasks.getTask(entry.taskId);
		if (!task?.contract.delivery) throw new AgentDeliveryError("internal", "Delivery task is unavailable");
		if (sender) await this.#assertDeliveryOwner(sender, task);
		await this.#tasks.cancel(task.id);
		return this.#receipt(task.id);
	}

	async #assertDeliveryOwner(sender: AgentDeliverySender, task: AgentTask): Promise<void> {
		if (sender.kind === "user" || sender.kind === "pi") this.#options.assertLiveSession?.(sender.sessionId);
		if (sender.kind === "agent") {
			this.#runs.assertActive(sender.attemptId);
			const sourceTask = this.#tasks.getTask(sender.taskId);
			if (
				!sourceTask ||
				sourceTask.agentId !== sender.agentId ||
				!sourceTask.attemptIds.includes(sender.attemptId)
			) {
				throw new AgentDeliveryError("delegation_not_allowed", "The source attempt does not own the source task");
			}
		}
		if (senderScope(sender) !== task.contract.delivery?.idempotencyScope) {
			throw new AgentDeliveryError("delegation_not_allowed", "The sender does not own this delivery");
		}
	}

	async #authorizeSender(sender: AgentDeliverySender, recipientAgentId: string): Promise<void> {
		if (sender.kind === "user" || sender.kind === "pi") {
			this.#options.assertLiveSession?.(sender.sessionId);
			return;
		}
		if (sender.kind !== "agent") return;
		this.#runs.assertActive(sender.attemptId);
		const sourceTask = this.#tasks.getTask(sender.taskId);
		if (!sourceTask || sourceTask.agentId !== sender.agentId || !sourceTask.attemptIds.includes(sender.attemptId)) {
			throw new AgentDeliveryError("delegation_not_allowed", "The source attempt does not own the source task");
		}
		if (sourceTask.contract.room) {
			throw new AgentDeliveryError(
				"delegation_not_allowed",
				"Room participation does not grant direct-delegation authority",
			);
		}
		const configuration = await this.#runs.getConfiguration(sender.attemptId);
		if (!configuration?.definition.delegateAgentIds.includes(recipientAgentId)) {
			throw new AgentDeliveryError("delegation_not_allowed", "The recipient is not in the source run allowlist");
		}
		if (delegationDepth(sourceTask, this.#tasks) >= this.#options.maxDelegationDepth) {
			throw new AgentDeliveryError("delegation_depth_exceeded", "The direct delegation depth limit is reached");
		}
		const childCount = this.#tasks
			.listTasks()
			.filter((task) => task.contract.delivery?.sender.kind === "agent")
			.filter((task) => {
				const childSender = task.contract.delivery?.sender;
				return childSender?.kind === "agent" && childSender.taskId === sourceTask.id;
			}).length;
		if (childCount >= this.#options.maxDirectChildren) {
			throw new AgentDeliveryError("budget_exhausted", "The direct delegation fan-out limit is reached");
		}
	}

	async #resolveReference(
		sender: AgentDeliverySender,
		reference: AgentDeliveryContextRef,
	): Promise<AgentResolvedDeliveryContextRef> {
		switch (reference.kind) {
			case "task-result": {
				const task = this.#tasks.getTask(reference.taskId);
				if (!task?.result || task.status !== "completed") {
					throw new AgentDeliveryError("invalid_request", `Task result ${reference.taskId} is unavailable`);
				}
				this.#assertReadableTask(sender, task);
				return { kind: "task-result", id: task.id, digest: digest(task.result) };
			}
			case "artifact": {
				const artifact = this.#tasks.getArtifact(reference.artifactId);
				if (!artifact)
					throw new AgentDeliveryError("invalid_request", `Artifact ${reference.artifactId} is unavailable`);
				const sourceTask = this.#tasks.getTask(artifact.taskId);
				if (!sourceTask) throw new AgentDeliveryError("invalid_request", "Artifact source task is unavailable");
				this.#assertReadableTask(sender, sourceTask);
				const version = await this.#tasks.getArtifactVersion(reference.artifactId, reference.versionId);
				if (!version) throw new AgentDeliveryError("invalid_request", "Artifact version is unavailable");
				return { kind: "artifact", id: artifact.id, version: version.id, digest: version.sha256 };
			}
			case "message": {
				if (sender.kind === "agent") {
					const sourceTask = this.#tasks.getTask(sender.taskId);
					if (!sourceTask || sourceTask.conversationId !== reference.conversationId) {
						throw new AgentDeliveryError(
							"delegation_not_allowed",
							"The message is outside the source conversation",
						);
					}
				}
				const message = (await this.#tasks.listMessages(reference.conversationId)).find(
					(entry) => entry.sequence === reference.sequence,
				);
				if (!message?.text) throw new AgentDeliveryError("invalid_request", "Message reference is unavailable");
				return {
					kind: "message",
					id: `${reference.conversationId}:${reference.sequence}`,
					version: String(reference.sequence),
					digest: digest(message.text),
				};
			}
		}
	}

	#assertReadableTask(sender: AgentDeliverySender, task: AgentTask): void {
		if (sender.kind !== "agent") return;
		if (task.id === sender.taskId || task.parentTaskId === sender.taskId) return;
		throw new AgentDeliveryError("delegation_not_allowed", "The referenced task is outside source authority");
	}

	#index(envelope: AgentDeliveryEnvelope): void {
		const key = scopedKey(envelope.idempotencyScope, envelope.idempotencyKey);
		const existing = this.#byScopedKey.get(key);
		if (existing && (existing.requestDigest !== envelope.requestDigest || existing.taskId !== envelope.taskId)) {
			throw new Error(`Conflicting persisted delivery idempotency key ${envelope.idempotencyKey}`);
		}
		const entry: DeliveryIndexEntry = {
			idempotencyScope: envelope.idempotencyScope,
			idempotencyKey: envelope.idempotencyKey,
			requestDigest: envelope.requestDigest,
			deliveryId: envelope.id,
			taskId: envelope.taskId,
		};
		this.#byScopedKey.set(key, entry);
		this.#byDeliveryId.set(entry.deliveryId, entry);
	}

	#receipt(taskId: string): AgentDeliveryReceipt {
		const task = this.#tasks.getTask(taskId);
		const deliveryId = task?.contract.delivery?.id;
		if (!task || !deliveryId) throw new AgentDeliveryError("internal", "Delivery task is unavailable");
		return receiptFromTask(task, deliveryId, this.#tasks.getLatestEventSequence(task.id));
	}

	async #persistIndex(): Promise<void> {
		const entries = [...this.#byDeliveryId.values()].sort((left, right) =>
			left.deliveryId.localeCompare(right.deliveryId),
		);
		await writeAtomic(this.#indexPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
	}
}

function validateRequest(request: SubmitAgentDelivery): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(request.idempotencyKey)) {
		throw new AgentDeliveryError("invalid_request", "The idempotency key is invalid");
	}
	if (!request.recipientAgentId || !request.goal.trim()) {
		throw new AgentDeliveryError("invalid_request", "Recipient and goal are required");
	}
	if (Buffer.byteLength(request.goal.trim(), "utf8") > 16 * 1024) {
		throw new AgentDeliveryError("context_overflow", "The delivery goal exceeds 16 KiB");
	}
	if (request.contextRefs.length > 16) {
		throw new AgentDeliveryError("context_overflow", "A delivery accepts at most 16 context references");
	}
}

function senderScope(sender: AgentDeliverySender): string {
	switch (sender.kind) {
		case "user":
			return `user:${sender.id}:session:${sender.sessionId}`;
		case "pi":
			return `pi:${sender.sessionId}`;
		case "agent":
			return `agent:${sender.agentId}:task:${sender.taskId}`;
		case "routine":
			return `routine:${sender.routineId}:revision:${sender.revision}`;
		case "workflow":
			return `workflow:${sender.workflowRunId}:node:${sender.nodeId}`;
		case "a2a":
			return `a2a:${sender.principalId}:request:${sender.requestId}`;
	}
}

function senderAuthor(sender: AgentDeliverySender, sourceRevision?: number): AgentContextAuthor {
	switch (sender.kind) {
		case "user":
			return { kind: "user", id: "local-user" };
		case "pi":
			return { kind: "pi", sessionId: sender.sessionId };
		case "agent":
			return { kind: "agent", agentId: sender.agentId, agentRevision: sourceRevision ?? 1 };
		case "routine":
			return { kind: "routine", routineId: sender.routineId, revision: sender.revision };
		case "workflow":
		case "a2a":
			return { kind: "system" };
	}
}

function taskSource(sender: AgentDeliverySender): "chat" | "pi" | "agent" | "routine" | "workflow" | "a2a" {
	return sender.kind === "user"
		? "chat"
		: sender.kind === "agent"
			? "agent"
			: sender.kind === "workflow"
				? "workflow"
				: sender.kind;
}

function toContextReference(reference: AgentResolvedDeliveryContextRef): AgentContextReference {
	return { ...reference };
}

function receiptFromTask(task: AgentTask, deliveryId: string, latestEventSequence: number): AgentDeliveryReceipt {
	return {
		deliveryId,
		taskId: task.id,
		conversationId: task.conversationId,
		recipientAgentId: task.agentId,
		status: task.status,
		latestEventSequence,
		resultSummary: task.result ? safeResult(task.result) : undefined,
		artifactIds: [...task.artifactIds],
		error: task.error
			? { code: task.status === "cancelled" ? "cancelled" : "internal", message: safeResult(task.error) }
			: undefined,
	};
}

function delegationDepth(task: AgentTask, tasks: AgentTaskService): number {
	let depth = 0;
	let current = task;
	const seen = new Set<string>();
	while (current.parentTaskId && !seen.has(current.parentTaskId)) {
		seen.add(current.parentTaskId);
		const parent = tasks.getTask(current.parentTaskId);
		if (!parent) break;
		depth += 1;
		current = parent;
	}
	return depth;
}

function scopedKey(scope: string, key: string): string {
	return `${scope}\u0000${key}`;
}

function safeResult(value: string): string {
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

function digest(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
}

function canonicalClone(value: unknown): unknown {
	if (value === undefined) return undefined;
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new AgentDeliveryError("invalid_request", "Delivery contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map(canonicalClone);
	if (typeof value !== "object") throw new AgentDeliveryError("invalid_request", "Delivery contains a non-JSON value");
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) result[key] = canonicalClone(entry);
	}
	return result;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}
