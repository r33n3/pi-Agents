import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAgentContextPackage } from "../src/core/serve/agent-context-package.ts";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("large workflow handoffs and correction turns retain evidence without enlarging user goals", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-workflow-context-"));
	const evidence = `Source evidence: ${"航班 details ".repeat(2500)} END-OF-EVIDENCE`;
	const prompts: string[] = [];
	let correct = false;
	const executor: AgentExecutor = {
		async start(context) {
			prompts.push(context.prompt);
			const output =
				context.definition.id === "researcher"
					? evidence
					: context.prompt.includes("only correction attempt")
						? '{"report":"verified"}'
						: correct
							? "invalid output"
							: "Report complete";
			return {
				result: Promise.resolve({ output, transcript: [] }),
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
	for (const id of ["researcher", "supervisor", "checker"])
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
			delegateAgentIds: id === "supervisor" ? ["researcher"] : [],
		});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	try {
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		const definition = {
			name: "Report",
			pattern: "supervisor" as const,
			supervisorAgentId: "supervisor",
			nodes: [
				{ id: "research", agentId: "researcher", prompt: "Research" },
				{ id: "review", agentId: "supervisor", prompt: "Review the returned evidence" },
			],
			edges: [{ from: "research", to: "review" }],
			maxConcurrency: 1,
			maxDelegationDepth: 2,
			failurePolicy: "stop" as const,
		};
		const result = await workflows.waitForCompletion((await workflows.startAdHoc(definition, "Report today")).id);
		expect(result.status, result.error).toBe("completed");
		expect(prompts[1]).toContain(evidence);
		expect(prompts[2]).toContain(evidence);
		correct = true;
		const corrected = await workflows.waitForCompletion(
			(
				await workflows.startAdHoc(
					{
						...definition,
						pattern: "sequential",
						nodes: [
							{
								id: "member-0",
								agentId: "checker",
								prompt: evidence,
								outputSchema: {
									type: "object",
									properties: { report: { type: "string" } },
									required: ["report"],
								},
							},
						],
						edges: [],
					},
					"Produce report",
					{ id: "report-room", runId: "report-run", round: 3 },
				)
			).id,
		);
		expect(corrected.status, corrected.error).toBe("completed");
		expect(corrected.taskIds).toHaveLength(2);
		expect(prompts.at(-1)).toContain(evidence);
		expect(corrected.result).toBe('{"report":"verified"}');
		expect(() =>
			createAgentContextPackage({ conversationId: "user", contextEpoch: 1, goal: evidence, messages: [] }),
		).toThrow("goal exceeds");
		const tooLarge = await workflows.waitForCompletion(
			(
				await workflows.startAdHoc(
					{
						...definition,
						pattern: "sequential",
						nodes: [{ id: "review", agentId: "supervisor", prompt: "x".repeat(128 * 1024) }],
						edges: [],
					},
					"Report",
				)
			).id,
		);
		expect(tooLarge.status).toBe("failed");
		expect(tooLarge.error).toContain("128 KiB");
	} finally {
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
