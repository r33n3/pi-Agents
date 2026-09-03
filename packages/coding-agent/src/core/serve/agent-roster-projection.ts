import type { AgentPresentationStore, AgentPresentationUpdate } from "./agent-presentation-store.ts";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import type { AgentRoutineScheduler } from "./agent-routine-scheduler.ts";
import type { AgentTask, AgentTaskService, AgentTaskStatus } from "./agent-task-service.ts";

export type AgentRosterStatus = "needs-attention" | "active" | "queued" | "idle" | "unavailable";

export interface AgentRosterEntry {
	agentId: string;
	agentRevision: number;
	name: string;
	description: string;
	personaId?: string;
	inboxConversationId: string;
	status: AgentRosterStatus;
	currentTask?: { id: string; summary: string; status: AgentTaskStatus };
	latestMessage?: { sequence: number; preview: string; createdAt: number };
	activeUntil?: number;
	unreadCount: number;
	hidden: boolean;
	pinnedOrder?: number;
	routines: { enabled: number; nextRunAt?: number };
}

export interface AgentRosterSnapshot {
	version: 1;
	rosterRevision: number;
	entries: AgentRosterEntry[];
}

export interface AgentRosterQuery {
	includeHidden?: boolean;
	search?: string;
}

/** Rebuildable, safe roster view over the authoritative registry, task, presentation, and routine owners. */
export class AgentRosterProjection implements AsyncDisposable {
	readonly #registry: AgentRegistry;
	readonly #tasks: AgentTaskService;
	readonly #routines: AgentRoutineScheduler;
	readonly #presentation: AgentPresentationStore;
	readonly #unsubscribers: Array<() => void> = [];
	#revision = 1;

	constructor(
		registry: AgentRegistry,
		tasks: AgentTaskService,
		routines: AgentRoutineScheduler,
		presentation: AgentPresentationStore,
	) {
		this.#registry = registry;
		this.#tasks = tasks;
		this.#routines = routines;
		this.#presentation = presentation;
	}

	async initialize(): Promise<void> {
		for (const definition of await this.#registry.list()) await this.#tasks.ensureAgentInbox(definition.id);
		this.#unsubscribers.push(
			this.#registry.subscribe(() => this.#invalidate()),
			this.#tasks.subscribe(() => this.#invalidate()),
			this.#routines.subscribe(() => this.#invalidate()),
			this.#presentation.subscribe(() => this.#invalidate()),
		);
	}

	async snapshot(query: AgentRosterQuery = {}): Promise<AgentRosterSnapshot> {
		const search = query.search?.trim().toLowerCase();
		const definitions = await this.#registry.list();
		const entries = await Promise.all(definitions.map((definition) => this.#entry(definition)));
		return {
			version: 1,
			rosterRevision: this.#revision,
			entries: entries
				.filter((entry) => (query.includeHidden ? true : !entry.hidden))
				.filter(
					(entry) =>
						!search ||
						entry.agentId.toLowerCase() === search ||
						entry.name.toLowerCase().includes(search) ||
						entry.description.toLowerCase().includes(search),
				)
				.sort(rosterOrder),
		};
	}

	async updatePresentation(agentId: string, update: AgentPresentationUpdate): Promise<AgentRosterEntry> {
		const definition = await this.#registry.get(agentId);
		if (!definition) throw new Error(`Agent ${agentId} was not found`);
		await this.#presentation.update(agentId, update);
		return this.#entry(definition);
	}

	async markRead(agentId: string, throughSequence?: number): Promise<AgentRosterEntry> {
		const inbox = await this.#tasks.ensureAgentInbox(agentId);
		const messages = await this.#tasks.listMessages(inbox.id);
		const latest = messages.at(-1)?.sequence ?? 0;
		const target = throughSequence === undefined ? latest : Math.min(throughSequence, latest);
		return this.updatePresentation(agentId, { lastReadConversationSequence: target });
	}

	async newContext(agentId: string): Promise<{ contextEpoch: number; sequence: number }> {
		const message = await this.#tasks.newContext(agentId);
		return { contextEpoch: message.contextEpoch, sequence: message.sequence };
	}

	async dispose(): Promise<void> {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		await this.#presentation.dispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #entry(definition: AgentDefinition): Promise<AgentRosterEntry> {
		const inbox = await this.#tasks.ensureAgentInbox(definition.id);
		const [messages] = await Promise.all([this.#tasks.listMessages(inbox.id)]);
		const tasks = this.#tasks.listTasks({ agentId: definition.id });
		const presentation = this.#presentation.get(definition.id);
		const attentionTaskIds = new Set(this.#tasks.listAttention("open").map((item) => item.taskId));
		const currentTask = tasks.find((task) => isActiveTask(task.status));
		const latestMessage = [...messages]
			.reverse()
			.find((message) => message.kind !== "context-checkpoint" && typeof message.text === "string");
		const unreadCount = messages.filter(
			(message) =>
				message.sequence > presentation.lastReadConversationSequence &&
				message.author.kind !== "user" &&
				message.kind !== "context-checkpoint",
		).length;
		const routines = this.#routines
			.list()
			.filter((routine) => routine.target.kind === "agent" && routine.target.agentId === definition.id);
		const latestActivity = Math.max(
			0,
			...tasks.map((task) => task.lastActivityAt ?? task.finishedAt ?? task.startedAt ?? task.createdAt),
		);
		return {
			agentId: definition.id,
			agentRevision: definition.revision,
			name: definition.name,
			description: definition.description,
			personaId: definition.personaId,
			inboxConversationId: inbox.id,
			status: rosterStatus(tasks, attentionTaskIds),
			currentTask: currentTask
				? { id: currentTask.id, summary: safeRosterPreview(currentTask.prompt), status: currentTask.status }
				: undefined,
			latestMessage: latestMessage
				? {
						sequence: latestMessage.sequence,
						preview: safeRosterPreview(latestMessage.text ?? ""),
						createdAt: latestMessage.createdAt,
					}
				: undefined,
			activeUntil: latestActivity > 0 ? latestActivity + 5 * 60_000 : undefined,
			unreadCount,
			hidden: presentation.hidden,
			pinnedOrder: presentation.pinnedOrder,
			routines: {
				enabled: routines.filter((routine) => routine.enabled).length,
				nextRunAt: routines
					.map((routine) => routine.nextRunAt)
					.filter((value): value is number => value !== undefined)
					.sort((left, right) => left - right)[0],
			},
		};
	}

	#invalidate(): void {
		this.#revision += 1;
	}
}

function rosterStatus(tasks: readonly AgentTask[], attentionTaskIds: ReadonlySet<string>): AgentRosterStatus {
	if (tasks.some((task) => attentionTaskIds.has(task.id))) return "needs-attention";
	if (
		tasks.some((task) => ["running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(task.status))
	) {
		return "active";
	}
	if (tasks.some((task) => task.status === "queued")) return "queued";
	return "idle";
}

function isActiveTask(status: AgentTaskStatus): boolean {
	return ["queued", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(status);
}

function rosterOrder(left: AgentRosterEntry, right: AgentRosterEntry): number {
	const leftPinned = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
	const rightPinned = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
	return leftPinned - rightPinned || left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId);
}

function safeRosterPreview(value: string): string {
	return value
		.replace(/authorization\s*[:=]\s*(?:Bearer\s+)?\S+/gi, "Authorization=[redacted]")
		.replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
		.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[path]")
		.replace(/\/(?:Users|home|tmp|etc|var)\/\S+/g, "[path]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 160);
}
