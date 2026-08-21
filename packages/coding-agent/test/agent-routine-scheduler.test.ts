import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentRoutineScheduler, type RoutineDispatcher } from "../src/core/serve/agent-routine-scheduler.ts";
import type { RoutineDefinition } from "../src/core/serve/routine-registry.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDispatcher implements RoutineDispatcher {
	readonly calls: RoutineDefinition[] = [];

	start(definition: RoutineDefinition) {
		this.calls.push(definition);
		return Promise.resolve({
			runId: `run-${this.calls.length}`,
			completion: Promise.resolve({}),
		});
	}
}

describe("AgentRoutineScheduler", () => {
	test("starts due routines through the shared run manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-routines-"));
		roots.push(root);
		const registry = new RoutineRegistry(root);
		await registry.save({
			id: "daily-report",
			name: "Daily report",
			prompt: "Write the report",
			intervalMinutes: 5,
			enabled: true,
			target: { kind: "agent", agentId: "daily" },
		});
		const dispatcher = new FakeDispatcher();
		const scheduler = new AgentRoutineScheduler(registry, dispatcher);
		await scheduler.refresh(1000);

		await scheduler.runDue(300_999);
		expect(dispatcher.calls).toEqual([]);
		await scheduler.runDue(301_000);
		expect(dispatcher.calls).toMatchObject([{ id: "daily-report", target: { agentId: "daily" } }]);
		expect(scheduler.list()[0]).toMatchObject({ lastRunId: "run-1", nextRunAt: 601_000 });
	});

	test("runs paused routines manually without enabling their schedule", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-routines-"));
		roots.push(root);
		const registry = new RoutineRegistry(root);
		await registry.save({
			id: "review",
			name: "Review",
			prompt: "Review changes",
			intervalMinutes: 60,
			enabled: false,
			target: { kind: "skill", skillName: "code-review" },
		});
		const dispatcher = new FakeDispatcher();
		const scheduler = new AgentRoutineScheduler(registry, dispatcher);
		await scheduler.refresh(1000);

		await scheduler.runNow("review", 2000);
		expect(dispatcher.calls).toMatchObject([{ target: { kind: "skill", skillName: "code-review" } }]);
		expect(scheduler.list()[0]).toMatchObject({ enabled: false, lastRunAt: 2000 });
	});
});
