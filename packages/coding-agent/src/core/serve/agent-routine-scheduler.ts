import { nextCronRun } from "./cron-schedule.ts";
import type { RoutineDefinition, RoutineRegistry } from "./routine-registry.ts";

export interface RoutineExecution {
	runId: string;
	completion: Promise<{ error?: string }>;
	cancel: () => Promise<void>;
}

export interface RoutineDispatcher {
	start(definition: RoutineDefinition): Promise<RoutineExecution>;
}

export interface AgentRoutineState extends RoutineDefinition {
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunId?: string;
	lastError?: string;
	activeRunId?: string;
}

/** Schedules target-agnostic routine definitions while preventing overlapping runs. */
export class AgentRoutineScheduler implements AsyncDisposable {
	readonly #registry: RoutineRegistry;
	readonly #dispatcher: RoutineDispatcher;
	readonly #states = new Map<string, AgentRoutineState>();
	#timer: NodeJS.Timeout | undefined;
	#tickActive = false;

	constructor(registry: RoutineRegistry, dispatcher: RoutineDispatcher) {
		this.#registry = registry;
		this.#dispatcher = dispatcher;
	}

	list(): AgentRoutineState[] {
		return [...this.#states.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	async start(): Promise<void> {
		if (this.#timer) return;
		await this.refresh();
		this.#timer = setInterval(() => void this.#tick(), 1000);
		this.#timer.unref();
	}

	async refresh(now = Date.now()): Promise<void> {
		const next = new Map<string, AgentRoutineState>();
		for (const routine of await this.#registry.list()) {
			const existing = this.#states.get(routine.id);
			next.set(routine.id, {
				...routine,
				nextRunAt: routine.enabled
					? existing?.nextRunAt && existing.cron === routine.cron && existing.timezone === routine.timezone
						? existing.nextRunAt
						: nextCronRun(routine.cron, routine.timezone, now)
					: undefined,
				lastRunAt: existing?.lastRunAt,
				lastRunId: existing?.lastRunId,
				lastError: existing?.lastError,
				activeRunId: existing?.activeRunId,
			});
		}
		this.#states.clear();
		for (const [key, state] of next) this.#states.set(key, state);
	}

	async runDue(now = Date.now()): Promise<void> {
		for (const state of this.#states.values()) {
			if (!state.enabled || state.nextRunAt === undefined || state.nextRunAt > now) continue;
			state.nextRunAt = nextCronRun(state.cron, state.timezone, now);
			if (!state.activeRunId) await this.#run(state, now);
		}
	}

	async runNow(id: string, now = Date.now()): Promise<AgentRoutineState> {
		const state = this.#states.get(id);
		if (!state) throw new Error(`Routine ${id} was not found`);
		if (state.activeRunId) throw new Error(`Routine ${id} already has an active run`);
		await this.#run(state, now);
		return { ...state };
	}

	dispose(): Promise<void> {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #tick(): Promise<void> {
		if (this.#tickActive) return;
		this.#tickActive = true;
		try {
			await this.runDue();
		} finally {
			this.#tickActive = false;
		}
	}

	async #run(state: AgentRoutineState, now: number): Promise<void> {
		try {
			const execution = await this.#dispatcher.start(state);
			state.lastRunAt = now;
			state.lastRunId = execution.runId;
			state.activeRunId = execution.runId;
			state.lastError = undefined;
			const timeout = setTimeout(
				() => void execution.cancel().catch(() => undefined),
				state.maxDurationMinutes * 60_000,
			);
			timeout.unref();
			void execution.completion.then((result) => {
				clearTimeout(timeout);
				if (state.activeRunId !== execution.runId) return;
				state.activeRunId = undefined;
				state.lastError = result.error;
			});
		} catch (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
		}
	}
}
