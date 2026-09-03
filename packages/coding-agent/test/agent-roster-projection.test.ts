import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentExecution, AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentPresentationStore } from "../src/core/serve/agent-presentation-store.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRosterProjection } from "../src/core/serve/agent-roster-projection.ts";
import type { RoutineDispatcher } from "../src/core/serve/agent-routine-scheduler.ts";
import { AgentRoutineScheduler } from "../src/core/serve/agent-routine-scheduler.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ImmediateExecutor implements AgentExecutor {
	start(context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve({
			result: Promise.resolve({ output: `Done: ${context.prompt}`, transcript: [] }),
			subscribe: () => () => {},
			abort: () => Promise.resolve(),
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

const routineDispatcher: RoutineDispatcher = {
	start: () =>
		Promise.resolve({
			runId: "routine-run",
			completion: Promise.resolve({}),
			cancel: () => Promise.resolve(),
		}),
};

describe("AgentRosterProjection", () => {
	test("ignores a corrupt rebuildable presentation projection", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-presentation-corrupt-"));
		roots.push(root);
		await mkdir(join(root, "presentation"), { recursive: true });
		await writeFile(join(root, "presentation", "agents.json"), "not-json", "utf8");
		const presentation = new AgentPresentationStore(root);
		await expect(presentation.initialize()).resolves.toBeUndefined();
		expect(presentation.get("reporter")).toMatchObject({ hidden: false, lastReadConversationSequence: 0 });
	});

	test("projects stable inbox, unread, presentation, activity, and routine state", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-roster-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
		await registry.save({
			id: "reporter",
			name: "Reporter",
			description: "Writes reports",
			tools: ["read"],
			memory: "none",
			persona: "Precise",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
		await runs.initialize();
		const tasks = new AgentTaskService(registry, runs, join(root, "serve"));
		await tasks.initialize();
		const routineRegistry = new RoutineRegistry(join(root, "routines"));
		await routineRegistry.save({
			id: "morning-report",
			name: "Morning report",
			prompt: "Write it",
			enabled: true,
			cron: "0 9 * * *",
			timezone: "UTC",
			maxDurationMinutes: 30,
			target: { kind: "agent", agentId: "reporter" },
		});
		const scheduler = new AgentRoutineScheduler(routineRegistry, routineDispatcher);
		await scheduler.refresh(1_000);
		const presentation = new AgentPresentationStore(join(root, "serve"));
		await presentation.initialize();
		const roster = new AgentRosterProjection(registry, tasks, scheduler, presentation);
		await roster.initialize();

		const initial = await roster.snapshot();
		expect(initial.entries).toMatchObject([
			{ agentId: "reporter", status: "idle", unreadCount: 0, routines: { enabled: 1 } },
		]);
		const task = await tasks.submit({ agentId: "reporter", prompt: "Create report", source: "chat" });
		await tasks.waitForCompletion(task.id);
		const unread = await roster.snapshot();
		expect(unread.rosterRevision).toBeGreaterThan(initial.rosterRevision);
		expect(unread.entries[0]).toMatchObject({ status: "idle", unreadCount: 1 });

		await roster.markRead("reporter");
		expect((await roster.snapshot()).entries[0]?.unreadCount).toBe(0);
		await roster.updatePresentation("reporter", { hidden: true, pinnedOrder: 0 });
		expect((await roster.snapshot()).entries).toEqual([]);
		expect((await roster.snapshot({ includeHidden: true })).entries[0]).toMatchObject({
			hidden: true,
			pinnedOrder: 0,
		});
		expect((await registry.get("reporter"))?.revision).toBe(1);

		await roster.dispose();
		await tasks.dispose();
		await scheduler.dispose();
	});
});
