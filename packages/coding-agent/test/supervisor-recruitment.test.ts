import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { requestsTeamMember } from "../src/core/serve/team-work-plan.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test.each([
	["We need a summarization, reporting agent that keeps material concise", true],
	["Can you create a reporting agent?", true],
	["What does a reporting agent do?", false],
	["Explain how to create an agent", false],
	["Don't create a reporting agent", false],
	["Create an agent\n\nUser clarification:\nDo it yourself", false],
	["Summarize today's results", false],
])("user-requested staffing: %s", (goal, expected) => {
	expect(requestsTeamMember(String(goal))).toBe(expected);
});

test.each(["create", "advice", "unallowed-tool", "unrequested"])("supervisor staffing through Pi: %s", async (mode) => {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-recruit-"));
	const assignments: string[] = [];
	const executor: AgentExecutor = {
		async start(context) {
			assignments.push(context.definition.id);
			const supervisor = context.definition.id === "supervisor";
			const recruit = supervisor && context.prompt.includes(", round 1.") && mode !== "advice";
			if (!supervisor) {
				expect(context.definition.tools).toEqual([]);
				expect(context.definition.capabilities).toEqual([]);
				expect(context.definition.teamContext).toContain("reporting");
			}
			return {
				result: Promise.resolve({
					output: JSON.stringify({
						outcome: "reply",
						requestAgentIds: [],
						message: supervisor
							? "Use the retained findings to prepare a concise report."
							: "SGF report: no verified fares.",
						...(recruit
							? {
									recruit: [
										{
											name: "Reporting Specialist",
											role: "Produce concise human-readable reports from retained team findings",
											...(mode === "unallowed-tool" ? { toolIds: ["write"] } : {}),
										},
									],
								}
							: {}),
					}),
					transcript: [],
				}),
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
	await registry.save({
		id: "supervisor",
		name: "Supervisor",
		description: "Coordinate",
		persona: "Coordinate",
		tools: ["read"],
		memory: "none",
		executor: "harness",
		permissionPolicy: "read-only",
		schedules: [],
	});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
	let restored: AgentRoomService | undefined;
	try {
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		await rooms.initialize();
		await rooms.save({
			id: "travel",
			name: "Travel",
			purpose: "Research SGF flights",
			allowRecruitment: false,
			supervisorAgentId: "supervisor",
			members: [{ agentId: "supervisor", role: "Coordinate" }],
			...(mode === "unallowed-tool" ? { toolIds: [] } : {}),
		});
		const result = await rooms.waitForCompletion(
			(
				await rooms.message(
					"travel",
					mode === "unrequested"
						? "Hello"
						: "We need a summarization, reporting agent that keeps material concise and easy to consume for human reader",
				)
			).id,
		);
		if (mode !== "create") {
			expect(result.status).not.toBe("completed");
			expect(rooms.getDefinition("travel")?.members).toHaveLength(1);
			expect(await registry.list()).toHaveLength(1);
			return;
		}
		expect(result.status, result.error).toBe("completed");
		const saved = rooms.getDefinition("travel")!;
		expect(saved.allowRecruitment).toBe(false);
		expect(saved.members).toHaveLength(2);
		const memberId = saved.members[1].agentId;
		expect(result.rounds[0].turns[0].recruitedAgentId).toBe(memberId);
		expect(assignments).toEqual(["supervisor", memberId, "supervisor"]);
		expect(
			(await tasks.listMessages(saved.conversationId)).some((message) =>
				message.text?.includes("Saved team member:"),
			),
		).toBe(true);
		restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getDefinition("travel")?.members).toEqual(saved.members);
		const repeat = await restored.waitForCompletion(
			(await restored.message("travel", "Create a Reporting Specialist agent")).id,
		);
		expect(repeat.status, repeat.error).toBe("completed");
		expect(restored.getDefinition("travel")?.members).toHaveLength(2);
		expect(await registry.list()).toHaveLength(2);
	} finally {
		await restored?.dispose();
		await rooms.dispose();
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
