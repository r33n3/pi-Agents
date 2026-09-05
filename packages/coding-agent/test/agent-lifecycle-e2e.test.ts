import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import { AgentCollaborationService } from "../src/core/serve/agent-collaboration-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { createAgentRegistryTools } from "../src/core/serve/agent-registry-tools.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRoutineScheduler, type RoutineDispatcher } from "../src/core/serve/agent-routine-scheduler.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import type { RoutineDefinition } from "../src/core/serve/routine-registry.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";
import { RunSkillPromotionService } from "../src/core/serve/run-skill-promotion-service.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

const roots: string[] = [];
const extensionContext = {} as ExtensionContext;

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class LifecycleExecutor implements AgentExecutor {
	readonly #held = new Map<string, (result: AgentExecutionResult) => void>();
	#delegationHeld = false;

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		let resolveHeld: ((result: AgentExecutionResult) => void) | undefined;
		const holdForDelegation = !this.#delegationHeld && context.prompt.includes("Hold for delegation");
		this.#delegationHeld ||= holdForDelegation;
		const result = holdForDelegation
			? new Promise<AgentExecutionResult>((resolve) => {
					resolveHeld = resolve;
				})
			: Promise.resolve(completedResult());
		if (resolveHeld) this.#held.set(context.runId, resolveHeld);
		return Promise.resolve({
			result,
			subscribe: () => () => {},
			abort: () => {
				this.complete(context.runId, "Aborted");
				return Promise.resolve();
			},
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	complete(runId: string, message = "Delegation completed"): void {
		this.#held.get(runId)?.(completedResult(message));
		this.#held.delete(runId);
	}

	dispose(): Promise<void> {
		for (const runId of this.#held.keys()) this.complete(runId, "Disposed");
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

function completedResult(message = "Verified lifecycle result"): AgentExecutionResult {
	return {
		output: JSON.stringify({ outcome: "pass", message, requestAgentIds: [] }),
		transcript: [],
	};
}

function routineDispatcher(tasks: AgentTaskService, startedTaskIds: string[]): RoutineDispatcher {
	return {
		async start(definition: RoutineDefinition) {
			if (definition.target.kind !== "agent") throw new Error("The lifecycle fixture expects an agent routine");
			const task = await tasks.submit({
				agentId: definition.target.agentId,
				prompt: definition.prompt,
				source: "routine",
				model: definition.model,
				routine: { id: definition.id, revision: definition.revision, scheduledFor: 1_788_321_600_000 },
			});
			startedTaskIds.push(task.id);
			return {
				runId: task.id,
				completion: tasks.waitForCompletion(task.id).then((completed) => ({
					error: completed.status === "completed" ? undefined : (completed.error ?? completed.status),
				})),
				cancel: async () => {
					await tasks.cancel(task.id);
				},
			};
		},
	};
}

describe("isolated agent lifecycle release gate", () => {
	test("crosses build, proof, promotion, work, collaboration, improvement, and restart boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-lifecycle-e2e-"));
		roots.push(root);
		const registryRoot = join(root, "registry");
		const runRoot = join(root, "runs");
		const serveRoot = join(root, "serve");
		const lifecycleRoot = join(root, "lifecycle");
		const routineRoot = join(root, "routines");
		const workflowRoot = join(root, "workflows");
		const roomRoot = join(root, "rooms");
		const workspace = join(root, "workspace");
		const executor = new LifecycleExecutor();
		const registry = new AgentRegistry(registryRoot, { defaultWorkspace: workspace });
		await registry.save({
			id: "release-reviewer",
			name: "Release Reviewer",
			description: "Reviews synthetic lifecycle evidence",
			projectRoot: join(root, "reviewer-workspace"),
			tools: ["read"],
			memory: "none",
			persona: "Return concise evidence",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, executor, runRoot);
		await runs.initialize();
		const lifecycle = new AgentBuildLifecycleService(lifecycleRoot, registry, runs);
		await lifecycle.initialize();
		const routines = new RoutineRegistry(routineRoot, undefined, async (definition) => {
			if (definition.target.kind === "agent") await lifecycle.assertAutomationAllowed(definition.target.agentId);
		});
		const promotion = new RunSkillPromotionService(runs, join(root, "skills"), lifecycle);
		const [configure, manage] = createAgentRegistryTools(registry, lifecycle, { promotion, routines });

		const configured = await configure.execute(
			"configure-release-agent",
			{
				name: "release-lifecycle-agent",
				description: "Complete and review one synthetic release task",
				projectRoot: workspace,
				tools: ["read"],
				permissionPolicy: "read-only",
				delegateAgentIds: ["release-reviewer"],
				scheduleTask: "Run the synthetic release check",
				scheduleCadence: "daily 07:00",
				scheduleTimezone: "America/Chicago",
				scheduleConfirmed: true,
			},
			undefined,
			undefined,
			extensionContext,
		);
		const buildId = configured.details!.buildId;
		await expect(
			manage.execute(
				"publish-without-confirmation",
				{ buildId, action: "publish", confirmed: false },
				undefined,
				undefined,
				extensionContext,
			),
		).rejects.toThrow("confirm");
		await manage.execute(
			"proof-confirmed",
			{ buildId, action: "run-proof", confirmed: true, prompt: "Run one isolated release proof" },
			undefined,
			undefined,
			extensionContext,
		);
		let build = await lifecycle.get(buildId);
		await runs.waitForCompletion(build.proof!.runId);
		await lifecycle.get(buildId);
		await manage.execute(
			"accept-confirmed",
			{ buildId, action: "accept-proof", confirmed: true },
			undefined,
			undefined,
			extensionContext,
		);
		await manage.execute(
			"publish-confirmed",
			{ buildId, action: "publish", confirmed: true },
			undefined,
			undefined,
			extensionContext,
		);
		await manage.execute(
			"promote-confirmed",
			{ buildId, action: "promote", confirmed: true, skillName: "release-lifecycle-agent" },
			undefined,
			undefined,
			extensionContext,
		);
		await manage.execute(
			"schedule-confirmed",
			{ buildId, action: "schedule", confirmed: true, timezone: "America/Chicago" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(await registry.get("release-lifecycle-agent")).toMatchObject({ revision: 1 });

		const tasks = new AgentTaskService(registry, runs, serveRoot);
		await tasks.initialize();
		const collaboration = new AgentCollaborationService(join(root, "collaboration"), registry, runs, tasks, {
			assertLiveSession: (sessionId) => {
				if (sessionId !== "release-session") throw new Error("Unexpected session authority");
			},
		});
		await collaboration.initialize();
		const sender = { kind: "user" as const, id: "local-user" as const, sessionId: "release-session" };
		const directRequest = {
			idempotencyKey: "release-direct-once",
			recipientAgentId: "release-lifecycle-agent",
			goal: "Deliver one durable inbox task",
			contextRefs: [],
		};
		const direct = await collaboration.submit(sender, directRequest);
		expect((await collaboration.submit(sender, directRequest)).taskId).toBe(direct.taskId);
		expect((await tasks.waitForCompletion(direct.taskId)).status).toBe("completed");
		const inbox = await tasks.ensureAgentInbox("release-lifecycle-agent");
		expect((await tasks.listMessages(inbox.id)).filter((message) => message.kind === "delivery")).toHaveLength(1);

		const source = await tasks.submit({
			agentId: "release-lifecycle-agent",
			prompt: "Hold for delegation",
			source: "chat",
		});
		const sourceAttemptId = tasks.getTask(source.id)?.attemptIds[0];
		expect(sourceAttemptId).toBeTypeOf("string");
		const delegated = await collaboration.submit(
			{
				kind: "agent",
				agentId: "release-lifecycle-agent",
				taskId: source.id,
				attemptId: sourceAttemptId!,
			},
			{
				idempotencyKey: "release-review-once",
				recipientAgentId: "release-reviewer",
				goal: "Review the synthetic release evidence",
				contextRefs: [],
			},
		);
		expect((await tasks.waitForCompletion(delegated.taskId)).status).toBe("completed");
		executor.complete(sourceAttemptId!);
		expect((await tasks.waitForCompletion(source.id)).status).toBe("completed");

		const scheduledTaskIds: string[] = [];
		const scheduler = new AgentRoutineScheduler(routines, routineDispatcher(tasks, scheduledTaskIds));
		await scheduler.refresh(1_788_321_600_000);
		const [routine] = await routines.list();
		await scheduler.runNow(routine!.id, 1_788_321_600_001);
		expect(scheduledTaskIds).toHaveLength(1);
		expect((await tasks.waitForCompletion(scheduledTaskIds[0]!)).contract.routine).toMatchObject({
			id: routine!.id,
			revision: routine!.revision,
		});

		const workflows = new WorkflowService(workflowRoot, registry, tasks);
		await workflows.initialize();
		const rooms = new AgentRoomService(roomRoot, registry, tasks, workflows);
		await rooms.initialize();
		const room = await rooms.save({
			id: "release-review-room",
			name: "Release review room",
			purpose: "Compare independent synthetic lifecycle evidence",
			members: [
				{ agentId: "release-lifecycle-agent", role: "Present evidence" },
				{ agentId: "release-reviewer", role: "Review evidence" },
			],
			limits: { maxRounds: 1 },
		});
		const roomRun = await rooms.waitForCompletion((await rooms.start(room.id, "Review the release gate")).id);
		expect(roomRun).toMatchObject({ status: "completed", messageCount: 3 });
		expect(roomRun.rounds[0]?.turns.map((turn) => turn.agentId)).toEqual([
			"release-lifecycle-agent",
			"release-reviewer",
		]);

		await lifecycle.recordFeedback(buildId, {
			rating: 2,
			summary: "Make the agent describe its release evidence more precisely.",
		});
		await configure.execute(
			"refine-release-agent",
			{
				id: "release-lifecycle-agent",
				name: "release-lifecycle-agent",
				description: "Complete, cite, and review one synthetic release task",
				projectRoot: workspace,
				tools: ["read"],
				permissionPolicy: "read-only",
				delegateAgentIds: ["release-reviewer"],
			},
			undefined,
			undefined,
			extensionContext,
		);
		expect(await registry.get("release-lifecycle-agent")).toMatchObject({
			revision: 1,
			description: "Complete and review one synthetic release task",
		});
		await manage.execute(
			"refined-proof",
			{ buildId, action: "run-proof", confirmed: true, prompt: "Run the refined isolated release proof" },
			undefined,
			undefined,
			extensionContext,
		);
		build = await lifecycle.get(buildId);
		await runs.waitForCompletion(build.proof!.runId);
		await lifecycle.get(buildId);
		await manage.execute(
			"accept-refined-proof",
			{ buildId, action: "accept-proof", confirmed: true },
			undefined,
			undefined,
			extensionContext,
		);
		await manage.execute(
			"promote-refined-proof",
			{ buildId, action: "promote", confirmed: true, skillName: "release-lifecycle-agent-v2" },
			undefined,
			undefined,
			extensionContext,
		);
		await manage.execute(
			"activate-refined-proof",
			{ buildId, action: "activate", confirmed: true },
			undefined,
			undefined,
			extensionContext,
		);
		expect(await registry.get("release-lifecycle-agent")).toMatchObject({
			revision: 2,
			description: "Complete, cite, and review one synthetic release task",
		});

		await rooms.dispose();
		await scheduler.dispose();
		await tasks.dispose();
		await runs.dispose();

		const restoredRegistry = new AgentRegistry(registryRoot, { defaultWorkspace: workspace });
		const restoredRuns = new AgentRunManager(restoredRegistry, new LifecycleExecutor(), runRoot);
		await restoredRuns.initialize();
		const restoredLifecycle = new AgentBuildLifecycleService(lifecycleRoot, restoredRegistry, restoredRuns);
		await restoredLifecycle.initialize();
		const restoredTasks = new AgentTaskService(restoredRegistry, restoredRuns, serveRoot);
		await restoredTasks.initialize();
		const restoredCollaboration = new AgentCollaborationService(
			join(root, "collaboration"),
			restoredRegistry,
			restoredRuns,
			restoredTasks,
		);
		await restoredCollaboration.initialize();
		const restoredWorkflows = new WorkflowService(workflowRoot, restoredRegistry, restoredTasks);
		await restoredWorkflows.initialize();
		const restoredRooms = new AgentRoomService(roomRoot, restoredRegistry, restoredTasks, restoredWorkflows);
		await restoredRooms.initialize();

		expect(await restoredRegistry.get("release-lifecycle-agent")).toMatchObject({ revision: 2 });
		expect(await restoredLifecycle.get(buildId)).toMatchObject({
			stage: "proven",
			agentRevision: 2,
			feedback: [expect.objectContaining({ rating: 2 })],
			routineIds: [routine!.id],
		});
		expect((await restoredTasks.ensureAgentInbox("release-lifecycle-agent")).id).toBe(inbox.id);
		expect(restoredCollaboration.get(direct.deliveryId)).toMatchObject({
			taskId: direct.taskId,
			status: "completed",
		});
		expect(restoredRooms.getRun(roomRun.id)).toMatchObject({ status: "completed", taskIds: roomRun.taskIds });
		expect(await new RoutineRegistry(routineRoot).list()).toEqual([
			expect.objectContaining({ id: routine!.id, target: { kind: "agent", agentId: "release-lifecycle-agent" } }),
		]);

		await restoredRooms.dispose();
		await restoredTasks.dispose();
		await restoredRuns.dispose();
	});
});
