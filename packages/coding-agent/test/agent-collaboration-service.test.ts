import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentCollaborationService } from "../src/core/serve/agent-collaboration-service.ts";
import { createAgentCollaborationTools } from "../src/core/serve/agent-collaboration-tools.ts";
import type { AgentExecution, AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ImmediateExecutor implements AgentExecutor {
	start(context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve({
			result: Promise.resolve({ output: `Result for ${context.prompt}`, transcript: [] }),
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

class ControlledExecutor implements AgentExecutor {
	readonly #completions = new Map<
		string,
		{
			resolve: (value: { output: string; transcript: [] }) => void;
			promise: Promise<{ output: string; transcript: [] }>;
		}
	>();

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		let resolve!: (value: { output: string; transcript: [] }) => void;
		const promise = new Promise<{ output: string; transcript: [] }>((done) => {
			resolve = done;
		});
		this.#completions.set(context.runId, { resolve, promise });
		return Promise.resolve({
			result: promise,
			subscribe: () => () => {},
			abort: () => {
				resolve({ output: "Aborted", transcript: [] });
				return Promise.resolve();
			},
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	complete(runId: string): void {
		this.#completions.get(runId)?.resolve({ output: "Completed", transcript: [] });
	}

	dispose(): Promise<void> {
		for (const completion of this.#completions.values()) completion.resolve({ output: "Disposed", transcript: [] });
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

describe("AgentCollaborationService", () => {
	test("admits one durable task for a scoped idempotency key and rebuilds its index", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-collaboration-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews work",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
		await runs.initialize();
		const tasks = new AgentTaskService(registry, runs, join(root, "serve"));
		await tasks.initialize();
		const sessions: string[] = [];
		const collaboration = new AgentCollaborationService(root, registry, runs, tasks, {
			assertLiveSession: (sessionId) => sessions.push(sessionId),
		});
		await collaboration.initialize();
		const sender = { kind: "user" as const, id: "local-user" as const, sessionId: "session-1" };
		const request = {
			idempotencyKey: "send-1",
			recipientAgentId: "reviewer",
			goal: "Review the evidence",
			contextRefs: [],
		};

		const first = await collaboration.submit(sender, request);
		const duplicate = await collaboration.submit(sender, request);
		expect(duplicate.taskId).toBe(first.taskId);
		expect(tasks.listTasks().filter((task) => task.contract.delivery)).toHaveLength(1);
		await tasks.waitForCompletion(first.taskId);
		const inbox = await tasks.ensureAgentInbox("reviewer");
		expect((await tasks.listMessages(inbox.id)).filter((message) => message.kind === "delivery")).toHaveLength(1);
		await expect(collaboration.submit(sender, { ...request, goal: "Different content" })).rejects.toMatchObject({
			code: "invalid_request",
		});
		expect(sessions).toEqual(["session-1", "session-1", "session-1"]);

		const rebuilt = new AgentCollaborationService(root, registry, runs, tasks);
		await rebuilt.initialize();
		expect(rebuilt.get(first.deliveryId)).toMatchObject({ taskId: first.taskId, status: "completed" });
		await tasks.dispose();
	});

	test("binds agent delegation to a live source attempt and cascades source cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-collaboration-authority-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews work",
			tools: ["read"],
			memory: "none",
			persona: "Review",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		await registry.save({
			id: "coordinator",
			name: "Coordinator",
			description: "Coordinates work",
			tools: ["read"],
			memory: "none",
			persona: "Coordinate",
			executor: "harness",
			permissionPolicy: "read-only",
			delegateAgentIds: ["reviewer"],
			schedules: [],
		});
		const executor = new ControlledExecutor();
		const runs = new AgentRunManager(registry, executor, join(root, "runs"));
		await runs.initialize();
		const tasks = new AgentTaskService(registry, runs, join(root, "serve"));
		await tasks.initialize();
		const collaboration = new AgentCollaborationService(root, registry, runs, tasks);
		await collaboration.initialize();
		const source = await tasks.submit({ agentId: "coordinator", prompt: "Coordinate", source: "chat" });
		const sourceAttemptId = tasks.getTask(source.id)?.attemptIds[0];
		expect(sourceAttemptId).toBeTypeOf("string");
		const sender = {
			kind: "agent" as const,
			agentId: "coordinator",
			taskId: source.id,
			attemptId: sourceAttemptId!,
		};
		const tools = createAgentCollaborationTools(collaboration, tasks, {
			agentId: "coordinator",
			runId: sourceAttemptId!,
		});
		expect(tools.map((tool) => tool.name)).toEqual(["delegate_agent", "inspect_delegation", "cancel_delegation"]);
		expect(tools[0].parameters.properties).not.toHaveProperty("sender");
		const child = await collaboration.submit(sender, {
			idempotencyKey: "review-once",
			recipientAgentId: "reviewer",
			goal: "Review the work",
			contextRefs: [],
		});
		expect(await collaboration.inspect(child.deliveryId, sender)).toMatchObject({ taskId: child.taskId });
		await expect(
			collaboration.inspect(child.deliveryId, { ...sender, taskId: "different-task" }),
		).rejects.toMatchObject({ code: "delegation_not_allowed" });

		await tasks.cancel(source.id);
		expect((await tasks.waitForCompletion(source.id)).status).toBe("cancelled");
		expect((await tasks.waitForCompletion(child.taskId)).status).toBe("cancelled");

		const roomSource = await tasks.submit({
			agentId: "coordinator",
			prompt: "Participate in the room",
			source: "workflow",
			room: { id: "review-room", runId: "room-run", round: 1, memberIndex: 0 },
		});
		const roomAttemptId = tasks.getTask(roomSource.id)?.attemptIds[0];
		expect(roomAttemptId).toBeTypeOf("string");
		await expect(
			collaboration.submit(
				{
					kind: "agent",
					agentId: "coordinator",
					taskId: roomSource.id,
					attemptId: roomAttemptId!,
				},
				{
					idempotencyKey: "room-delegation",
					recipientAgentId: "reviewer",
					goal: "Delegate from room",
					contextRefs: [],
				},
			),
		).rejects.toMatchObject({ code: "delegation_not_allowed" });
		await tasks.cancel(roomSource.id);
		await tasks.dispose();
	});
});
