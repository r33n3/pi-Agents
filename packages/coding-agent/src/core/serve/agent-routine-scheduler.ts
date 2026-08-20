import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRunRecord } from "./agent-run-manager.ts";

export interface RoutineRunStarter {
	start(agentId: string, prompt: string, source: "routine"): Promise<AgentRunRecord>;
}

export interface AgentRoutineState {
	agentId: string;
	routineId: string;
	prompt: string;
	intervalMinutes: number;
	nextRunAt: number;
	lastRunAt?: number;
	lastRunId?: string;
	lastError?: string;
}

/** Converts persisted interval definitions into runs without bypassing workspace leases. */
export class AgentRoutineScheduler implements AsyncDisposable {
	readonly #registry: AgentRegistry;
	readonly #runs: RoutineRunStarter;
	readonly #states = new Map<string, AgentRoutineState>();
	#timer: NodeJS.Timeout | undefined;
	#tickActive = false;

	constructor(registry: AgentRegistry, runs: RoutineRunStarter) {
		this.#registry = registry;
		this.#runs = runs;
	}

	list(): AgentRoutineState[] {
		return [...this.#states.values()].sort((left, right) => left.nextRunAt - right.nextRunAt);
	}

	async start(): Promise<void> {
		if (this.#timer) return;
		await this.refresh();
		this.#timer = setInterval(() => void this.#tick(), 1000);
		this.#timer.unref();
	}

	async refresh(now = Date.now()): Promise<void> {
		const next = new Map<string, AgentRoutineState>();
		for (const agent of await this.#registry.list()) {
			for (const routine of agent.schedules) {
				if (!routine.enabled) continue;
				const key = `${agent.id}/${routine.id}`;
				const existing = this.#states.get(key);
				next.set(key, {
					agentId: agent.id,
					routineId: routine.id,
					prompt: routine.prompt,
					intervalMinutes: routine.intervalMinutes,
					nextRunAt:
						existing && existing.intervalMinutes === routine.intervalMinutes
							? existing.nextRunAt
							: now + routine.intervalMinutes * 60_000,
					lastRunAt: existing?.lastRunAt,
					lastRunId: existing?.lastRunId,
					lastError: existing?.lastError,
				});
			}
		}
		this.#states.clear();
		for (const [key, state] of next) this.#states.set(key, state);
	}

	async runDue(now = Date.now()): Promise<void> {
		for (const state of this.#states.values()) {
			if (state.nextRunAt > now) continue;
			state.nextRunAt = now + state.intervalMinutes * 60_000;
			try {
				const run = await this.#runs.start(state.agentId, state.prompt, "routine");
				state.lastRunAt = now;
				state.lastRunId = run.id;
				state.lastError = undefined;
			} catch (error) {
				state.lastError = error instanceof Error ? error.message : String(error);
			}
		}
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
}
