import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { A2A_PROTOCOL_VERSION, A2aAdapter, A2aError } from "../src/core/serve/a2a-adapter.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ImmediateExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;

	constructor(output: string) {
		this.result = Promise.resolve({ output, transcript: [] });
	}

	subscribe(): () => void {
		return () => {};
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class ImmediateExecutor implements AgentExecutor {
	start(context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve(new ImmediateExecution(`${context.definition.name}: ${context.prompt}`));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-services-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const [id, a2a] of [
		["researcher", true],
		["reviewer", false],
	] as const) {
		await registry.save({
			id,
			name: id,
			description: `${id} agent`,
			projectRoot: join(root, id),
			tools: ["read"],
			memory: "none",
			persona: "Evidence based",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			a2a: { enabled: a2a },
		});
	}
	const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
	await runs.initialize();
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	await tasks.initialize();
	return { root, registry, tasks };
}

describe("agent workflows and A2A", () => {
	test("persists and restores a bounded parallel workflow", async () => {
		const { root, registry, tasks } = await setup();
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		await workflows.save({
			id: "research-review",
			name: "Research review",
			pattern: "parallel",
			nodes: [
				{ id: "research", agentId: "researcher", prompt: "Research" },
				{ id: "review", agentId: "reviewer", prompt: "Review" },
			],
			edges: [],
			maxConcurrency: 2,
			maxDelegationDepth: 2,
			failurePolicy: "stop",
		});
		const run = await workflows.start("research-review", "Assess the design");
		await expect(workflows.waitForCompletion(run.id)).resolves.toMatchObject({
			status: "completed",
			taskIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
		});

		const restored = new WorkflowService(join(root, "workflows"), registry, tasks);
		await restored.initialize();
		expect(restored.getDefinition("research-review")).toMatchObject({ pattern: "parallel", maxConcurrency: 2 });
		expect(restored.getRun(run.id)).toMatchObject({ status: "completed" });
		await tasks.dispose();
	});

	test("exposes only opted-in agents through A2A v1.0", async () => {
		const { registry, tasks } = await setup();
		const adapter = new A2aAdapter(registry, tasks);
		expect(adapter.validateVersion(A2A_PROTOCOL_VERSION)).toBeUndefined();
		await expect(adapter.agentCard("researcher", "http://127.0.0.1:4173")).resolves.toMatchObject({
			name: "researcher",
			supportedInterfaces: [{ protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
		});
		await expect(adapter.agentCard("reviewer", "http://127.0.0.1:4173")).rejects.toMatchObject({
			reason: "AGENT_NOT_FOUND",
		});
		const submitted = await adapter.sendMessage("researcher", {
			message: { parts: [{ text: "Find the evidence" }] },
		});
		const completed = await tasks.waitForCompletion(submitted.task.id);
		expect(adapter.getTask("researcher", completed.id)).toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
			artifacts: [{ parts: [{ text: expect.stringContaining("Find the evidence") }] }],
		});
		expect(() => adapter.validateVersion("0.3")).toThrow(A2aError);
		await tasks.dispose();
	});
});
