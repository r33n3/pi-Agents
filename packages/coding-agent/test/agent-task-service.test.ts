import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeferredExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	resolve: (result: AgentExecutionResult) => void = () => {};
	reject: (error: Error) => void = () => {};

	constructor() {
		this.result = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	subscribe(): () => void {
		return () => {};
	}

	abort(): Promise<void> {
		this.reject(new Error("aborted"));
		return Promise.resolve();
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class FakeExecutor implements AgentExecutor {
	readonly executions: DeferredExecution[] = [];
	readonly contexts: AgentExecutionContext[] = [];

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		this.contexts.push(context);
		const execution = new DeferredExecution();
		this.executions.push(execution);
		return Promise.resolve(execution);
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(deferScheduling = false) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-tasks-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	await registry.save({
		id: "researcher",
		name: "Researcher",
		description: "Researches",
		tools: ["read"],
		memory: "none",
		persona: "Careful",
		executor: "harness",
		permissionPolicy: "read-only",
		schedules: [],
	});
	const executor = new FakeExecutor();
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	await runs.initialize();
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	await tasks.initialize({ deferScheduling });
	return { root, registry, executor, runs, tasks };
}

describe("AgentTaskService", () => {
	test("defers queued execution until recovery services are ready", async () => {
		const { executor, tasks } = await setup(true);
		const task = await tasks.submit({ agentId: "researcher", prompt: "Wait for recovery", source: "chat" });
		expect(task.status).toBe("queued");
		expect(executor.executions).toHaveLength(0);
		await tasks.startScheduling();
		expect(executor.executions).toHaveLength(1);
		executor.executions[0]!.resolve({ output: "Recovered", transcript: [] });
		await expect(tasks.waitForCompletion(task.id)).resolves.toMatchObject({ status: "completed" });
		await tasks.dispose();
	});

	test("persists a durable conversation and completed task", async () => {
		const { root, registry, executor, runs, tasks } = await setup();
		const task = await tasks.submit({ agentId: "researcher", prompt: "Find evidence", source: "chat" });
		executor.executions[0]!.resolve({ output: "Evidence found", transcript: [] });
		await expect(tasks.waitForCompletion(task.id)).resolves.toMatchObject({
			status: "completed",
			result: "Evidence found",
		});
		await expect(tasks.listMessages(task.conversationId)).resolves.toMatchObject([
			{ role: "user", text: "Find evidence" },
			{ role: "agent", text: "Evidence found" },
		]);

		const restored = new AgentTaskService(registry, runs, join(root, "tasks"));
		await restored.initialize();
		expect(restored.getTask(task.id)).toMatchObject({ status: "completed", result: "Evidence found" });
		await restored.dispose();
		await tasks.dispose();
	});

	test("marks an active task interrupted during restart recovery", async () => {
		const { root, registry, runs, tasks } = await setup();
		const task = await tasks.submit({ agentId: "researcher", prompt: "Long job", source: "pi" });
		const restored = new AgentTaskService(registry, runs, join(root, "tasks"));
		await restored.initialize();
		expect(restored.getTask(task.id)).toMatchObject({
			status: "interrupted",
			error: "Serve host stopped before the local attempt completed",
		});
		expect(restored.listAttention("open")).toMatchObject([
			{ taskId: task.id, kind: "failure", title: "Run interrupted" },
		]);
		await restored.dispose();
		await tasks.cancel(task.id);
		await tasks.dispose();
	});

	test("runs read-only same-workspace tasks concurrently", async () => {
		const { registry, executor, tasks } = await setup();
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const first = await tasks.submit({ agentId: "researcher", prompt: "Research", source: "chat" });
		const second = await tasks.submit({ agentId: "reviewer", prompt: "Review", source: "chat" });
		expect(second.status).toBe("running");
		expect(executor.executions).toHaveLength(2);
		executor.executions[0]!.resolve({ output: "Research done", transcript: [] });
		executor.executions[1]!.resolve({ output: "Review done", transcript: [] });
		await expect(tasks.waitForCompletion(first.id)).resolves.toMatchObject({ status: "completed" });
		await expect(tasks.waitForCompletion(second.id)).resolves.toMatchObject({ status: "completed" });
		await tasks.dispose();
	});

	test("keeps one explicit inbox even when a newer task conversation exists", async () => {
		const { root, registry, runs, tasks } = await setup();
		const inbox = await tasks.ensureAgentInbox("researcher");
		const taskConversation = await tasks.createTaskConversation("researcher");
		expect(taskConversation.kind).toBe("task");
		expect(tasks.listConversations("researcher")[0]).toMatchObject({ id: inbox.id, kind: "agent-inbox" });

		const restored = new AgentTaskService(registry, runs, join(root, "tasks"));
		await restored.initialize();
		expect(restored.listConversations("researcher").filter((entry) => entry.kind === "agent-inbox")).toEqual([
			expect.objectContaining({ id: inbox.id }),
		]);
		await restored.dispose();
		await tasks.dispose();
	});

	test("freezes queued execution configuration and excludes prior context epochs", async () => {
		const { registry, executor, tasks } = await setup();
		const first = await tasks.submit({ agentId: "researcher", prompt: "Block the agent", source: "chat" });
		const queued = await tasks.submit({ agentId: "researcher", prompt: "Use revision one", source: "chat" });
		expect(queued.status).toBe("queued");
		await registry.save({
			id: "researcher",
			name: "Researcher updated",
			description: "Researches with a new revision",
			tools: ["read"],
			memory: "none",
			persona: "Updated",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		executor.executions[0]!.resolve({ output: "First done", transcript: [] });
		await tasks.waitForCompletion(first.id);
		await expect.poll(() => executor.contexts.length).toBe(2);
		expect(executor.contexts[1]?.definition).toMatchObject({ revision: 1, name: "Researcher" });
		executor.executions[1]!.resolve({ output: "Second done", transcript: [] });
		await tasks.waitForCompletion(queued.id);

		await tasks.newContext("researcher");
		const afterCheckpoint = await tasks.submit({ agentId: "researcher", prompt: "Fresh context", source: "chat" });
		expect(afterCheckpoint.contract.context).toMatchObject({ contextEpoch: 2, messages: [] });
		executor.executions[2]!.resolve({ output: "Fresh done", transcript: [] });
		await tasks.waitForCompletion(afterCheckpoint.id);
		await tasks.dispose();
	});
});
