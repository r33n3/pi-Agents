import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { parseTeamWorkPlan, planTeamWork } from "../src/core/serve/team-work-plan.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test.each([
	"Bring in a reviewer and check this plan",
	"Bring in a Node.js test specialist to independently check the puzzle",
	"Get a second opinion on the plan",
	"Have someone check this",
	"Can you get a second pair of eyes on this?",
	"Add an agent to review our work",
	"Independently review the plan",
])("records separate staffing before execution: %s", (goal) => {
	expect(planTeamWork(goal, "Deliver a prototype").contribution).toBe("separate-member");
});

test.each([
	"Hello",
	"What tools do we have?",
	"Who gave the second opinion?",
	"Explain how to recruit an agent",
	"Review the plan yourself; no reviewer needed",
	"Bring in a reviewer\n\nUser clarification:\nDo it yourself",
])("does not require new staffing: %s", (goal) => {
	expect(planTeamWork(goal, "Deliver a prototype").contribution).toBe("direct");
});

test("uses the defined purpose when explicitly asked to pursue it, and retains the contract", () => {
	const plan = planTeamWork("Work towards your defined purpose", "Produce an independent review of our prototype");
	expect(plan.contribution).toBe("separate-member");
	expect(planTeamWork("Hello", plan.purpose).contribution).toBe("direct");
	expect(parseTeamWorkPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
	expect(() => parseTeamWorkPlan({ ...plan, contribution: "skip-check" })).toThrow("Invalid retained");
});

test("clarifications retain declared team requirements unless the user explicitly waives them", () => {
	const prior = {
		goal: "Have both teams check",
		purpose: "Review",
		contribution: "separate-team" as const,
		teamIds: ["design", "review"],
		reason: "Both were requested",
	};
	expect(planTeamWork("Have both selected teams check now", "Review", [], prior).teamIds).toEqual([
		"design",
		"review",
	]);
	expect(planTeamWork("Do it yourself", "Review", [], prior).contribution).toBe("direct");
});

test.each(["Have both selected teams check the scope", "How about having both teams check the scope?"])(
	"retains natural requests for both teams: %s",
	(goal) => {
		const plan = planTeamWork(goal, "Review", [
			{ id: "design", name: "Design" },
			{ id: "review", name: "Review" },
		]);
		expect(plan.contribution).toBe("separate-team");
		expect(plan.teamIds).toEqual(["design", "review"]);
	},
);

test.each([true, false])(
	"rejects self-review completion and bounds staffing repair: cooperates=%s",
	async (cooperates) => {
		const root = await mkdtemp(join(tmpdir(), "pi-staffing-contract-"));
		const prompts: string[] = [];
		let supervisorTurns = 0;
		const executor: AgentExecutor = {
			async start(context) {
				prompts.push(context.prompt);
				if (context.prompt.includes("STAFFING DECISION ONLY")) {
					expect(context.definition.tools).toEqual([]);
					expect(context.definition.capabilities).toEqual([]);
				}
				if (context.definition.id !== "supervisor") expect(context.definition.tools).toEqual(["read"]);
				if (context.definition.id === "supervisor") supervisorTurns++;
				const recruit = cooperates && supervisorTurns === 2 && context.definition.id === "supervisor";
				return {
					result: Promise.resolve({
						output: JSON.stringify({
							outcome: "reply",
							// Long retained reports must not crowd the current contract out of the task context.
							message: recruit
								? "Reviewer, independently check our plan."
								: "Checked the plan. ".repeat(cooperates ? 240 : 1),
							requestAgentIds: [],
							...(recruit
								? { recruit: [{ name: "Reviewer", role: "Independently check the requested plan" }] }
								: {}),
							remember: [{ key: "review", text: "Review done", scope: "team" }],
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
			tools: ["read", "write"],
			memory: "none",
			executor: "harness",
			permissionPolicy: "workspace-write",
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
				id: "studio",
				name: "Studio",
				purpose: "Deliver a prototype",
				supervisorAgentId: "supervisor",
				allowRecruitment: cooperates,
				memoryStrategy: "team",
				members: [{ agentId: "supervisor", role: "Coordinate" }],
			});
			const run = await rooms.waitForCompletion(
				(await rooms.message("studio", "Bring in a reviewer and check the plan")).id,
			);
			expect(run.workPlan?.contribution).toBe("separate-member");
			expect(prompts[1]).toContain("Host completion check");
			expect(prompts[1]).toContain("STAFFING DECISION ONLY");
			// Assembled workflow context has a 128 KiB bound; the user goal alone has a 16 KiB bound.
			expect(prompts.every((prompt) => Buffer.byteLength(prompt, "utf8") <= 128 * 1024)).toBe(true);
			expect(run.status).toBe(cooperates ? "completed" : "needs-user");
			if (cooperates) {
				expect(run.rounds).toHaveLength(4);
				expect(run.rounds[2]?.turns[0]?.agentId).not.toBe("supervisor");
				expect(prompts[2]).not.toContain("STAFFING DECISION ONLY");
				const repeated = await rooms.waitForCompletion(
					(await rooms.message("studio", "Get a second opinion again")).id,
				);
				expect(repeated.status).toBe("needs-user");
				expect(repeated.result).toBeUndefined();
			} else {
				expect(run.rounds).toHaveLength(2);
				expect(run.result).toBeUndefined();
				expect(rooms.memory("studio")).toEqual([]);
				const restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
				await restored.initialize();
				expect(restored.getRun(run.id)?.workPlan).toEqual(run.workPlan);
				const resumed = await restored.waitForCompletion((await restored.resume(run.id, "Do it yourself")).id);
				expect(resumed.status).toBe("completed");
				await restored.dispose();
			}
		} finally {
			await rooms.dispose();
			await tasks.dispose();
			await runs.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
);
