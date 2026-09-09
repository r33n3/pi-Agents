import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { planTeamWork } from "../src/core/serve/team-work-plan.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("a builder contribution cannot satisfy the retained reporter requirement", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-required-members-"));
	const calls: string[] = [];
	let supervisorTurns = 0;
	const executor: AgentExecutor = {
		async start(context) {
			calls.push(context.definition.id);
			const output: Record<string, unknown> = {
				outcome: "reply",
				requestAgentIds: [],
				message: "Contribution completed",
			};
			if (context.definition.id === "supervisor") {
				supervisorTurns++;
				output.plan = {
					toolHandoffs: [],
					contribution: "separate-member",
					memberIds: supervisorTurns === 1 ? ["builder", "reporter"] : [],
					teamIds: [],
					reason: "Build then render",
				};
				if (supervisorTurns === 1) output.requestAgentIds = ["builder"];
				if (supervisorTurns === 2) output.message = "Builder finished; done";
				if (supervisorTurns === 3) {
					expect(context.prompt).toContain("Host completion check");
					output.requestAgentIds = ["reporter"];
				}
			}
			return {
				result: Promise.resolve({ output: JSON.stringify(output), transcript: [] }),
				subscribe: () => () => {},
				abort: async () => {},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	};
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["supervisor", "builder", "reporter"])
		await registry.save({
			id,
			name: id,
			description: id,
			persona: id,
			tools: [],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
	try {
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		await rooms.initialize();
		await rooms.save({
			id: "reports",
			name: "Reports",
			purpose: "Build and render",
			supervisorAgentId: "supervisor",
			members: [
				{ agentId: "supervisor", role: "Coordinate" },
				{ agentId: "builder", role: "Build" },
				{ agentId: "reporter", role: "Render" },
			],
		});
		const result = await rooms.waitForCompletion(
			(await rooms.start("reports", "Have the builder build and the reporter render")).id,
		);
		expect(result.status, result.error).toBe("completed");
		expect(calls).toEqual(["supervisor", "builder", "supervisor", "supervisor", "reporter", "supervisor"]);
		expect(result.workPlan?.memberIds).toEqual(["builder", "reporter"]);
		const restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getRun(result.id)?.workPlan?.memberIds).toEqual(["builder", "reporter"]);
		await restored.dispose();
		expect(planTeamWork("Do it yourself", "Reports", [], result.workPlan).memberIds).toBeUndefined();
	} finally {
		await rooms.dispose();
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
