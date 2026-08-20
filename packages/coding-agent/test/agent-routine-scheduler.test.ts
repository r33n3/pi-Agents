import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoutineScheduler, type RoutineRunStarter } from "../src/core/serve/agent-routine-scheduler.ts";
import type { AgentRunRecord } from "../src/core/serve/agent-run-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeRuns implements RoutineRunStarter {
	readonly calls: Array<{ agentId: string; prompt: string }> = [];

	start(agentId: string, prompt: string): Promise<AgentRunRecord> {
		this.calls.push({ agentId, prompt });
		return Promise.resolve({
			id: `run-${this.calls.length}`,
			agentId,
			prompt,
			source: "routine",
			status: "running",
			createdAt: Date.now(),
			artifactDirectory: "artifacts",
		});
	}
}

describe("AgentRoutineScheduler", () => {
	test("starts due routines through the shared run manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-routines-"));
		roots.push(root);
		const registry = new AgentRegistry(root);
		await registry.save({
			id: "daily",
			name: "Daily",
			description: "Daily task",
			tools: [],
			memory: "none",
			persona: "Concise",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [{ id: "report", prompt: "Write the report", intervalMinutes: 5, enabled: true }],
		});
		const runs = new FakeRuns();
		const scheduler = new AgentRoutineScheduler(registry, runs);
		await scheduler.refresh(1000);

		await scheduler.runDue(300_999);
		expect(runs.calls).toEqual([]);
		await scheduler.runDue(301_000);
		expect(runs.calls).toEqual([{ agentId: "daily", prompt: "Write the report" }]);
		expect(scheduler.list()[0]).toMatchObject({ lastRunId: "run-1", nextRunAt: 601_000 });
	});
});
