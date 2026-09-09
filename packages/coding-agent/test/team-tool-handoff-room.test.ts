import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test.each(["failed-registration", "updated-version", "stale-version", "approval", "builder-handoff"])(
	"room enforces %s across assignment and reload",
	async (scenario) => {
		const succeeds = scenario === "updated-version" || scenario === "approval" || scenario === "builder-handoff";
		const root = await mkdtemp(join(tmpdir(), "pi-handoff-room-"));
		const tool = "saved_report_example_v2";
		let supervisorTurns = 0;
		const calls: string[] = [];
		const executor: AgentExecutor = {
			async start(context) {
				const id = context.definition.id;
				calls.push(id);
				const output: Record<string, unknown> = { outcome: "reply", requestAgentIds: [], message: "Done" };
				if (id === "supervisor") {
					expect(context.definition.persona).toContain(
						'"teamInstructions":"Build only when the template needs changes"',
					);
					expect(context.definition.persona).toContain('"instructions":"builder"');
					supervisorTurns++;
					output.plan = {
						contribution: "separate-member",
						memberIds: ["builder", "reporter"],
						teamIds: [],
						toolHandoffs: supervisorTurns === 1 ? [{ builderId: "builder", consumerId: "reporter" }] : [],
						reason: "Build then render",
					};
					if (supervisorTurns === 1) output.requestAgentIds = ["builder"];
					else if (supervisorTurns === 2 && scenario !== "builder-handoff") output.requestAgentIds = ["reporter"];
					else if (scenario === "failed-registration" || (!succeeds && supervisorTurns >= 4)) {
						output.outcome = "needs-user";
						output.message = "Registration or required renderer still needs correction";
					}
				} else if (id === "builder" && scenario !== "failed-registration") {
					output.toolEvidence = [{ kind: "registered", tool }];
					if (scenario === "builder-handoff") output.requestAgentIds = ["reporter"];
				} else if (id === "reporter") {
					expect(context.definition.tools).toContain(tool);
					output.toolEvidence = [
						{
							kind: "rendered",
							tool: scenario === "stale-version" ? "saved_report_example_v1" : tool,
							reportPath: "reports/example.html",
							sha256: "a".repeat(64),
						},
					];
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
		class FixtureResources extends TeamResources {
			override list() {
				return [...super.list(), { id: tool, name: tool, description: "fixture", tools: [tool], capabilities: [] }];
			}
		}
		const resources = new FixtureResources();
		const runs = new AgentRunManager(registry, executor, join(root, "runs"));
		const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, resources);
		try {
			await runs.initialize();
			await tasks.initialize();
			await workflows.initialize();
			await rooms.initialize();
			await rooms.save({
				id: "reports",
				name: "Reports",
				purpose: "Report tools",
				supervisorAgentId: "supervisor",
				toolIds: scenario === "approval" ? [] : [tool],
				members: ["supervisor", "builder", "reporter"].map((agentId) => ({
					agentId,
					role: agentId,
					toolIds: [],
					notes: agentId === "builder" ? "Build only when the template needs changes" : undefined,
				})),
			});
			let result = await rooms.waitForCompletion(
				(await rooms.start("reports", "Build a new report tool and use it")).id,
			);
			if (scenario === "approval") {
				expect(result.status).toBe("needs-user");
				const count = calls.length;
				await rooms.resume(result.id, "Approve tools");
				result = await rooms.waitForCompletion(result.id);
				expect(calls[count]).toBe("reporter");
			}
			expect(result.status, result.error).toBe(succeeds ? "completed" : "needs-user");
			if (scenario === "builder-handoff") expect(calls).toEqual(["supervisor", "builder", "reporter", "supervisor"]);
			expect(result.workPlan?.toolHandoffs).toEqual([{ builderId: "builder", consumerId: "reporter" }]);
			if (scenario === "failed-registration") expect(calls).not.toContain("reporter");
			else expect(calls.filter((id) => id === "reporter")).toHaveLength(1);
			const reloaded = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, resources);
			await reloaded.initialize();
			expect(reloaded.getRun(result.id)?.rounds).toEqual(result.rounds);
			expect(reloaded.getRun(result.id)?.workPlan?.toolHandoffs).toEqual(result.workPlan?.toolHandoffs);
			await reloaded.dispose();
		} finally {
			await rooms.dispose();
			await tasks.dispose();
			await runs.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
);
