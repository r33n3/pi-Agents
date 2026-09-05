import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentExecution, AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { createServePage } from "../src/core/serve/serve-page.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

const roots: string[] = [];
type RoomMode = "converge" | "needs-user" | "reply" | "one-round";

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class RoomExecutor implements AgentExecutor {
	readonly contexts: AgentExecutionContext[] = [];
	readonly #mode: RoomMode;
	readonly #starts = new Map<string, number>();
	readonly #outputOverride: Record<string, unknown>;

	constructor(mode: RoomMode, outputOverride: Record<string, unknown> = {}) {
		this.#mode = mode;
		this.#outputOverride = outputOverride;
	}

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		this.contexts.push(context);
		const count = (this.#starts.get(context.definition.id) ?? 0) + 1;
		this.#starts.set(context.definition.id, count);
		const outcome =
			this.#mode === "reply"
				? { outcome: "reply", message: `${context.definition.id} contribution`, requestAgentIds: ["reviewer"] }
				: this.#mode === "needs-user" && context.definition.id === "researcher" && count === 1
					? { outcome: "needs-user", message: "Choose option A or B", requestAgentIds: [] }
					: (this.#mode === "converge" || this.#mode === "one-round") &&
							context.definition.id === "researcher" &&
							count === 1
						? {
								outcome: "reply",
								message: "Initial evidence",
								requestAgentIds: this.#mode === "converge" ? ["reviewer"] : [],
							}
						: { outcome: "pass", message: "No further changes", requestAgentIds: [] };
		return Promise.resolve({
			result: Promise.resolve({ output: JSON.stringify({ ...outcome, ...this.#outputOverride }), transcript: [] }),
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

class ControlledRoomExecutor implements AgentExecutor {
	readonly contexts: AgentExecutionContext[] = [];
	readonly #resolvers = new Map<string, (value: { output: string; transcript: [] }) => void>();

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		this.contexts.push(context);
		let resolve!: (value: { output: string; transcript: [] }) => void;
		const result = new Promise<{ output: string; transcript: [] }>((done) => {
			resolve = done;
		});
		this.#resolvers.set(context.runId, resolve);
		return Promise.resolve({
			result,
			subscribe: () => () => {},
			abort: () => {
				resolve({
					output: JSON.stringify({ outcome: "pass", message: "Cancelled", requestAgentIds: [] }),
					transcript: [],
				});
				return Promise.resolve();
			},
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	dispose(): Promise<void> {
		for (const resolve of this.#resolvers.values()) {
			resolve({
				output: JSON.stringify({ outcome: "pass", message: "Disposed", requestAgentIds: [] }),
				transcript: [],
			});
		}
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(mode: RoomMode, executor: AgentExecutor = new RoomExecutor(mode)) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-rooms-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["reviewer", "researcher"]) {
		await registry.save({
			id,
			name: id,
			description: `${id} agent`,
			tools: ["read"],
			memory: "none",
			persona: "Evidence based",
			executor: "harness",
			permissionPolicy: "read-only",
			delegateAgentIds: id === "researcher" ? ["reviewer"] : [],
			schedules: [],
		});
	}
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	await runs.initialize();
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	await tasks.initialize();
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	await workflows.initialize();
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
	await rooms.initialize();
	return { root, registry, runs, tasks, workflows, rooms };
}

async function saveRoom(rooms: AgentRoomService, limits: { maxRounds?: number } = {}) {
	return rooms.save({
		id: "design-review",
		name: "Design review",
		purpose: "Compare evidence and converge on a recommendation",
		members: [
			{ agentId: "researcher", role: "Present evidence" },
			{ agentId: "reviewer", role: "Challenge unsupported claims" },
		],
		limits,
	});
}

describe("AgentRoomService", () => {
	test("addresses a roster member directly and returns control to the supervisor", async () => {
		const executor = new RoomExecutor("one-round");
		const { tasks, rooms } = await setup("one-round", executor);
		await rooms.save({
			id: "addressed-team",
			name: "Addressed team",
			purpose: "Review",
			supervisorAgentId: "researcher",
			members: [
				{ agentId: "researcher", role: "Supervise" },
				{ agentId: "reviewer", role: "Review" },
			],
		});
		const completed = await rooms.waitForCompletion(
			(await rooms.start("addressed-team", "@reviewer check the evidence")).id,
		);
		expect(completed.status).toBe("completed");
		expect(executor.contexts.map((context) => context.definition.id)).toEqual(["reviewer", "researcher"]);
		await rooms.dispose();
		await tasks.dispose();
	});
	test("stops a supervised task at its turn limit without waking other members", async () => {
		const executor = new RoomExecutor("reply");
		const { tasks, rooms } = await setup("reply", executor);
		await rooms.save({
			id: "bounded-team",
			name: "Bounded team",
			purpose: "Review",
			supervisorAgentId: "researcher",
			members: [
				{ agentId: "researcher", role: "Supervise" },
				{ agentId: "reviewer", role: "Review" },
			],
			limits: { maxRounds: 1 },
		});
		const run = await rooms.waitForCompletion((await rooms.start("bounded-team", "Review the evidence")).id);
		expect(run.status).toBe("bounded");
		expect(executor.contexts.map((context) => context.definition.id)).toEqual(["researcher"]);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("cancels the supervisor and rejects roster changes while its task is active", async () => {
		const executor = new ControlledRoomExecutor();
		const { tasks, rooms } = await setup("reply", executor);
		const definition = await rooms.save({
			id: "stoppable-team",
			name: "Stoppable team",
			purpose: "Review",
			supervisorAgentId: "researcher",
			members: [
				{ agentId: "researcher", role: "Supervise" },
				{ agentId: "reviewer", role: "Review" },
			],
		});
		const started = await rooms.start(definition.id, "Review evidence");
		await expect.poll(() => executor.contexts.length).toBe(1);
		await expect(rooms.save(definition)).rejects.toThrow("active run");
		const cancelled = await rooms.cancel(started.id);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.taskIds).toHaveLength(1);
		expect(tasks.getTask(cancelled.taskIds[0]!)?.status).toBe("cancelled");
		await rooms.dispose();
		await tasks.dispose();
	});

	test("supervisor recruits from its roster, routes peer requests, and receives the final evidence", async () => {
		const executor = new RoomExecutor("one-round");
		const contexts: AgentExecutionContext[] = [];
		vi.spyOn(executor, "start").mockImplementation(async (context) => {
			contexts.push(context);
			const index = contexts.length;
			const output = {
				outcome: "reply",
				message: index === 3 ? "Final checked evidence" : `Evidence ${index}`,
				requestAgentIds: index === 1 ? ["reviewer"] : index === 2 ? ["observer", "researcher"] : [],
			};
			return {
				result: Promise.resolve({ output: JSON.stringify(output), transcript: [] }),
				subscribe: () => () => {},
				abort: async () => {},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		});
		const { registry, tasks, rooms } = await setup("one-round", executor);
		await registry.save({ ...(await registry.get("reviewer"))!, id: "observer", name: "Observer" });
		await rooms.save({
			id: "supervised",
			name: "Review team",
			purpose: "Review evidence",
			supervisorAgentId: "researcher",
			members: [
				{ agentId: "researcher", role: "Supervise" },
				{ agentId: "reviewer", role: "Check evidence" },
				{ agentId: "observer", role: "Answer the reviewer's question" },
			],
		});
		const completed = await rooms.waitForCompletion((await rooms.start("supervised", "Review this design")).id);
		expect(completed.status).toBe("completed");
		expect(contexts.map((context) => context.definition.id)).toEqual([
			"researcher",
			"reviewer",
			"observer",
			"researcher",
		]);
		expect(contexts[3]?.prompt).toContain("Final checked evidence");
		expect(contexts.every((context) => context.prompt.includes("Review this design"))).toBe(true);
		expect(completed.rounds.every((round) => round.turns.length === 1)).toBe(true);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("recruits one bounded specialist and retains membership across restart", async () => {
		const executor = new RoomExecutor("one-round");
		const contexts: AgentExecutionContext[] = [];
		vi.spyOn(executor, "start").mockImplementation(async (context) => {
			contexts.push(context);
			const output =
				contexts.length === 1
					? {
							outcome: "reply",
							message: "Check the source",
							requestAgentIds: [],
							recruit: [{ name: "Source checker", role: "Read and verify the source" }],
						}
					: { outcome: "reply", message: "Source verified", requestAgentIds: [] };
			return {
				result: Promise.resolve({ output: JSON.stringify(output), transcript: [] }),
				subscribe: () => () => {},
				abort: async () => {},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		});
		const { root, registry, tasks, workflows, rooms } = await setup("one-round", executor);
		await rooms.save({
			id: "staffing",
			name: "Staffing team",
			purpose: "Check evidence",
			supervisorAgentId: "researcher",
			allowRecruitment: true,
			members: [{ agentId: "researcher", role: "Supervise" }],
		});
		const completed = await rooms.waitForCompletion((await rooms.start("staffing", "Check the source")).id);
		expect(completed.status).toBe("completed");
		expect(contexts).toHaveLength(3);
		const recruited = contexts[1]!.definition;
		expect(recruited).toMatchObject({
			name: "Source checker",
			tools: ["read"],
			permissionPolicy: "read-only",
			schedules: [],
			delegateAgentIds: [],
			capabilities: [],
			memory: "none",
		});
		expect(contexts[2]?.prompt).toContain(recruited.id);
		expect(rooms.getDefinition("staffing")?.members).toHaveLength(2);
		const restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getRun(completed.id)?.definitionSnapshot?.members).toHaveLength(2);
		expect(restored.getDefinition("staffing")?.members[1]?.name).toBe("Source checker");
		await restored.dispose();
		await rooms.dispose();
		await tasks.dispose();
	});

	test.each([
		{ requestAgentIds: ["reviewer"] },
		{ requestAgentIds: [], recruit: [{ name: "Unauthorized", role: "Do work" }] },
	])("rejects unauthorized supervisor action %j", async (action) => {
		const { tasks, rooms } = await setup("one-round", new RoomExecutor("one-round", action));
		await rooms.save({
			id: "restricted",
			name: "Restricted",
			purpose: "Check",
			supervisorAgentId: "researcher",
			members: [{ agentId: "researcher", role: "Supervise" }],
		});
		const run = await rooms.waitForCompletion((await rooms.start("restricted", "Check evidence")).id);
		expect(run.status).toBe("failed");
		expect(run.taskIds).toHaveLength(1);
		expect(rooms.getDefinition("restricted")?.members).toHaveLength(1);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("persists stable ordered rounds backed by ordinary room-scoped tasks", async () => {
		const executor = new RoomExecutor("converge");
		const { root, registry, tasks, workflows, rooms } = await setup("converge", executor);
		const definition = await saveRoom(rooms);
		const started = await rooms.start(definition.id, "Review the design");
		const completed = await rooms.waitForCompletion(started.id);

		expect(completed).toMatchObject({ status: "completed", messageCount: 5 });
		expect(completed.rounds).toHaveLength(2);
		expect(completed.rounds[0]?.turns.map((turn) => turn.agentId)).toEqual(["researcher", "reviewer"]);
		expect(completed.rounds[1]?.turns.map((turn) => turn.status)).toEqual(["pass", "pass"]);
		expect(completed.rounds[0]?.turns[0]?.requestAgentIds).toEqual(["reviewer"]);
		expect(
			executor.contexts.slice(2).every((context) => context.prompt.includes("Requested follow-up from: reviewer")),
		).toBe(true);
		expect(workflows.listDefinitions()).toEqual([]);
		expect(workflows.getRun(completed.workflowRunIds[0]!)).toMatchObject({
			definitionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
			definitionSnapshot: { id: "room-design-review-1", nodes: [{ id: "member-0" }, { id: "member-1" }] },
		});
		expect(completed.taskIds).toHaveLength(4);
		expect(completed.taskIds.map((taskId) => tasks.getTask(taskId)?.contract.room)).toEqual([
			{ id: definition.id, runId: started.id, round: 1, memberIndex: 0 },
			{ id: definition.id, runId: started.id, round: 1, memberIndex: 1 },
			{ id: definition.id, runId: started.id, round: 2, memberIndex: 0 },
			{ id: definition.id, runId: started.id, round: 2, memberIndex: 1 },
		]);
		const messages = await tasks.listMessages(definition.conversationId);
		expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(messages.filter((message) => message.kind === "room-turn")).toHaveLength(4);

		const restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getRun(started.id)).toMatchObject({ status: "completed", taskIds: completed.taskIds });
		expect(restored.getRun(started.id)?.rounds[0]?.turns[0]?.requestAgentIds).toEqual(["reviewer"]);
		completed.rounds[0]?.turns[0]?.requestAgentIds?.push("outsider");
		expect(rooms.getRun(started.id)?.rounds[0]?.turns[0]?.requestAgentIds).toEqual(["reviewer"]);
		await rooms.dispose();
		await restored.dispose();
		await tasks.dispose();
	});

	test("completes reply plus pass in one round when no follow-up is requested", async () => {
		const { tasks, workflows, rooms } = await setup("one-round");
		await saveRoom(rooms, { maxRounds: 1 });
		const completed = await rooms.waitForCompletion((await rooms.start("design-review", "Review the design")).id);
		expect(completed).toMatchObject({
			status: "completed",
			messageCount: 3,
			rounds: [
				{
					status: "completed",
					turns: [
						{ status: "reply", requestAgentIds: [] },
						{ status: "pass", requestAgentIds: [] },
					],
				},
			],
		});
		expect(completed.rounds).toHaveLength(1);
		expect(completed.taskIds).toHaveLength(2);
		expect(completed.workflowRunIds).toHaveLength(1);
		expect(completed.finishedAt).toEqual(expect.any(Number));
		expect(completed.error).toBeUndefined();
		expect(completed.result).toContain("Initial evidence");
		expect(
			workflows.getRun(completed.workflowRunIds[0]!)?.nodeResults.every((node) => node.status === "completed"),
		).toBe(true);
		await rooms.dispose();
		await tasks.dispose();
	});

	test.each([undefined, null, "reviewer", [42], ["outsider"], ["reviewer", "reviewer"]])(
		"rejects missing or invalid continuation requests: %j",
		async (requestAgentIds) => {
			const { tasks, rooms } = await setup("one-round", new RoomExecutor("one-round", { requestAgentIds }));
			await saveRoom(rooms);
			const failed = await rooms.waitForCompletion((await rooms.start("design-review", "Review the design")).id);
			expect(failed.status).toBe("failed");
			expect(failed.rounds).toHaveLength(1);
			expect(failed.rounds[0]?.turns.every((turn) => turn.status === "failed")).toBe(true);
			expect(failed.taskIds).toHaveLength(2);
			await rooms.dispose();
			await tasks.dispose();
		},
	);

	test("honors an explicit request even when every member passes", async () => {
		const { tasks, rooms } = await setup(
			"one-round",
			new RoomExecutor("one-round", {
				outcome: "pass",
				requestAgentIds: ["researcher"],
			}),
		);
		await saveRoom(rooms, { maxRounds: 1 });
		const bounded = await rooms.waitForCompletion((await rooms.start("design-review", "Review the design")).id);
		expect(bounded.status).toBe("bounded");
		expect(bounded.error).toBe("Room round limit is reached");
		expect(bounded.rounds).toHaveLength(1);
		expect(bounded.rounds[0]?.turns.map((turn) => turn.status)).toEqual(["pass", "pass"]);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("pauses with a typed user question and resumes without duplicating prior turns", async () => {
		const { tasks, rooms } = await setup("needs-user");
		await saveRoom(rooms);
		const started = await rooms.start("design-review", "Review the design");
		const waiting = await rooms.waitForCompletion(started.id);
		expect(waiting).toMatchObject({ status: "needs-user", userQuestion: expect.stringContaining("option A or B") });
		expect(waiting.rounds).toHaveLength(1);

		await rooms.resume(started.id, "Use option A");
		const completed = await rooms.waitForCompletion(started.id);
		expect(completed.status).toBe("completed");
		expect(completed.rounds).toHaveLength(2);
		const definition = rooms.getDefinition("design-review")!;
		const messages = await tasks.listMessages(definition.conversationId);
		expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
		expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("terminates with preserved evidence when explicit continuation reaches the round bound", async () => {
		const { tasks, rooms } = await setup("reply");
		await saveRoom(rooms, { maxRounds: 1 });
		const started = await rooms.start("design-review", "Review the design");
		const completed = await rooms.waitForCompletion(started.id);
		expect(completed).toMatchObject({
			status: "bounded",
			error: "Room round limit is reached",
			rounds: [{ status: "completed", turns: [{ status: "reply" }, { status: "reply" }] }],
		});
		expect(completed.result).toContain("researcher contribution");
		expect(completed.rounds).toHaveLength(1);
		expect(completed.taskIds).toHaveLength(2);
		expect(completed.rounds[0]?.turns[0]?.requestAgentIds).toEqual(["reviewer"]);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("cancels active member tasks and retains their workflow references", async () => {
		const executor = new ControlledRoomExecutor();
		const { tasks, rooms } = await setup("reply", executor);
		await saveRoom(rooms);
		const started = await rooms.start("design-review", "Review the design");
		for (let attempt = 0; attempt < 100 && executor.contexts.length < 2; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(executor.contexts).toHaveLength(2);
		const cancelled = await rooms.cancel(started.id);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.taskIds).toHaveLength(2);
		expect(cancelled.taskIds.map((taskId) => tasks.getTask(taskId)?.status)).toEqual(["cancelled", "cancelled"]);
		expect(new Set(cancelled.taskIds).size).toBe(cancelled.taskIds.length);
		await rooms.dispose();
		await tasks.dispose();
	});

	test("recovers persisted partial workflow evidence once and ignores corrupt records", async () => {
		const { root, registry, tasks, workflows, rooms } = await setup("converge");
		const definition = await saveRoom(rooms);
		const completed = await rooms.waitForCompletion((await rooms.start(definition.id, "Review recovery")).id);
		expect(workflows.getRun(completed.workflowRunIds[0]!)?.nodeResults).toHaveLength(2);
		const recoveryRun = {
			...completed,
			id: "recovery-run",
			status: "running",
			finishedAt: undefined,
			rounds: [],
			taskIds: [],
			messageCount: 1,
			totalTokens: 0,
			costUsd: 0,
			currentWorkflowRunId: completed.workflowRunIds[0],
			result: undefined,
			error: undefined,
		};
		const recoveryDir = join(root, "rooms", "runs", recoveryRun.id);
		await mkdir(recoveryDir, { recursive: true });
		await writeFile(join(recoveryDir, "run.json"), `${JSON.stringify(recoveryRun, null, 2)}\n`, "utf8");
		await writeFile(join(root, "rooms", "definitions", "corrupt.json"), "{", "utf8");
		const corruptRunDir = join(root, "rooms", "runs", "corrupt");
		await mkdir(corruptRunDir, { recursive: true });
		await writeFile(join(corruptRunDir, "run.json"), "{", "utf8");

		const restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getRun(recoveryRun.id)).toMatchObject({
			status: "failed",
			rounds: [{ workflowRunId: completed.workflowRunIds[0], turns: [{}, {}] }],
			taskIds: expect.arrayContaining(completed.taskIds.slice(0, 2)),
		});
		expect(restored.getRun("corrupt")).toBeUndefined();
		expect(restored.listDefinitions()).toHaveLength(1);
		const messagesAfterRecovery = await tasks.listMessages(definition.conversationId);
		const restartedAgain = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restartedAgain.initialize();
		expect(await tasks.listMessages(definition.conversationId)).toHaveLength(messagesAfterRecovery.length);
		await rooms.dispose();
		await restored.dispose();
		await restartedAgain.dispose();
		await tasks.dispose();
	});

	test("exposes authenticated room creation, execution, inspection, and cancellation routes", async () => {
		const { registry, tasks, workflows, rooms } = await setup("reply");
		const options: Parameters<typeof createServePage> = ["secret-token", registry];
		options[10] = tasks;
		options[11] = workflows;
		options[31] = rooms;
		const server = createServer(createServePage(...options));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const origin = `http://127.0.0.1:${address.port}`;
		try {
			expect((await fetch(`${origin}/agent-rooms.json`)).status).toBe(403);
			const created = await fetch(`${origin}/agent-rooms?token=secret-token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "http-review",
					name: "HTTP review",
					purpose: "Exercise the room API",
					members: [
						{ agentId: "researcher", role: "Research" },
						{ agentId: "reviewer", role: "Review" },
					],
					limits: { maxRounds: 1 },
				}),
			});
			expect(created.status).toBe(201);
			const started = await fetch(`${origin}/agent-rooms/http-review/run?token=secret-token`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ goal: "Review the API" }),
			});
			expect(started.status).toBe(202);
			const run = (await started.json()) as { id: string };
			await rooms.waitForCompletion(run.id);
			const inspected = await fetch(`${origin}/agent-room-runs/${run.id}?token=secret-token`);
			expect(inspected.status).toBe(200);
			expect(await inspected.json()).toMatchObject({ status: "bounded", rounds: [{ turns: [{}, {}] }] });
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rooms.dispose();
			await tasks.dispose();
		}
	});
});
