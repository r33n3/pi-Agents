import { expect, test } from "vitest";
import { taskActivitySummary } from "../src/core/serve/activity-summary.ts";
import type { AgentTask } from "../src/core/serve/agent-task-service.ts";
import { ActivityRefresh } from "../src/core/serve/browser/activity-refresh.ts";

test("activity transfer stays small while complete evidence remains intact", () => {
	const task: AgentTask = {
		id: "task",
		agentId: "agent",
		conversationId: "chat",
		source: "chat",
		status: "completed",
		prompt: "request".repeat(100_000),
		result: "evidence".repeat(100_000),
		createdAt: 1,
		attemptIds: ["attempt"],
		artifactIds: ["artifact"],
		usage: { inputTokens: 1200, outputTokens: 100, totalTokens: 1300, costUsd: 0.01 },
		contract: {
			goal: "goal",
			actor: { kind: "user", id: "user" },
			conversationId: "chat",
			agentId: "agent",
			agentRevision: 1,
			workspaceRoot: "/workspace",
			capabilityGrantIds: [],
			providerAccountRefs: [],
			permissionMode: "manual",
		},
	};
	const summary = taskActivitySummary(task);
	expect(JSON.stringify(summary).length).toBeLessThan(1000);
	expect(summary).not.toHaveProperty("contract");
	expect(summary).not.toHaveProperty("result");
	expect(summary.usage).toEqual(task.usage);
	expect(summary).toMatchObject({ id: "task", status: "completed", artifactIds: ["artifact"], summary: true });
	expect(task.result).toHaveLength(800_000);
	expect(task.prompt).toHaveLength(700_000);
});

test("overlapping refreshes are serialized and retain events arriving during a request", async () => {
	let release = () => {};
	let calls = 0;
	let active = 0;
	let maximum = 0;
	const refresh = new ActivityRefresh(async () => {
		calls++;
		maximum = Math.max(maximum, ++active);
		if (calls === 1)
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		active--;
	});
	const first = refresh.refresh();
	await Promise.resolve();
	const second = refresh.refresh();
	const third = refresh.refresh();
	release();
	await Promise.all([first, second, third]);
	expect(calls).toBe(2);
	expect(maximum).toBe(1);
});

test("refresh can recover after failure and ignores unchanged display data", async () => {
	let fail = true;
	const refresh = new ActivityRefresh(async () => {
		if (fail) throw new Error("offline");
	});
	await expect(refresh.refresh()).rejects.toThrow("offline");
	fail = false;
	await refresh.refresh();
	expect(refresh.changed("navigation", { status: "running" })).toBe(true);
	expect(refresh.changed("navigation", { status: "running" })).toBe(false);
	expect(refresh.changed("navigation", { status: "completed" })).toBe(true);
});
