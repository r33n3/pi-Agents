import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { createAgentRegistryTools } from "../src/core/serve/agent-registry-tools.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import {
	type AgentBuildUserMessage,
	ConversationBuildCoordinator,
} from "../src/core/serve/conversation-build-coordinator.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";
import { RunSkillPromotionService } from "../src/core/serve/run-skill-promotion-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class IdleExecution implements AgentExecution {
	readonly result = new Promise<AgentExecutionResult>(() => {});

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

class IdleExecutor implements AgentExecutor {
	start(_context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve(new IdleExecution());
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class CompletedExecution implements AgentExecution {
	readonly result = Promise.resolve<AgentExecutionResult>({
		output: "Completed with verified evidence",
		transcript: [],
	});

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

class CompletedExecutor implements AgentExecutor {
	start(_context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve(new CompletedExecution());
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(executor: AgentExecutor = new IdleExecutor()): Promise<{
	root: string;
	registry: AgentRegistry;
	lifecycle: AgentBuildLifecycleService;
	runs: AgentRunManager;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-tool-lifecycle-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	await runs.initialize();
	const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
	await lifecycle.initialize();
	return { root, registry, lifecycle, runs };
}

describe("configure_agent lifecycle tool", () => {
	test("defaults a minimal draft to the session workspace and reports the assumption", async () => {
		const { root, registry, lifecycle } = await setup();
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		const cwd = join(root, "research");
		const result = await tool.execute("minimal", { name: "researcher" }, undefined, undefined, {
			cwd,
		} as ExtensionContext);
		expect(await lifecycle.get(result.details!.buildId)).toMatchObject({
			projectRoot: cwd,
			configuration: { projectRoot: cwd, permissionPolicy: "read-only" },
			stage: "draft",
		});
		expect(result.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining(`Workspace: ${cwd} (defaulted`) }),
		]);
		expect(await registry.list()).toEqual([]);
	});

	test("preserves a staged workspace across sessions and honors an explicit replacement", async () => {
		const { root, registry, lifecycle } = await setup();
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		const firstRoot = join(root, "first");
		const context = { cwd: join(root, "second") } as ExtensionContext;
		await tool.execute("create", { name: "researcher", projectRoot: firstRoot }, undefined, undefined, context);
		const updated = await tool.execute(
			"edit",
			{ name: "researcher", description: "Review sources" },
			undefined,
			undefined,
			context,
		);
		expect((await lifecycle.get(updated.details!.buildId)).configuration?.projectRoot).toBe(firstRoot);
		const replacement = join(root, "third");
		await tool.execute("move", { name: "researcher", projectRoot: replacement }, undefined, undefined, context);
		expect((await lifecycle.get(updated.details!.buildId)).configuration?.projectRoot).toBe(replacement);
		expect(await lifecycle.list()).toHaveLength(1);
	});

	test("rejects a missing workspace without writing a draft when context has no directory", async () => {
		const { registry, lifecycle } = await setup();
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		await expect(
			tool.execute("missing", { name: "researcher" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("projectRoot is required");
		expect(await lifecycle.list()).toEqual([]);
		expect(await registry.list()).toEqual([]);
	});

	test("stages configuration and automation intent without deploying or scheduling", async () => {
		const { root, registry, lifecycle } = await setup();
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		const result = await tool.execute(
			"configure-1",
			{
				name: "daily-mail-agent",
				description: "Summarize the previous day",
				systemPrompt: "Read yesterday's mail and create a report.",
				projectRoot: join(root, "mail"),
				tools: "read,list,google_workspace_email_search,google_workspace_email_read",
				model: "anthropic/claude-haiku-4-5",
				scheduleTask: "Review the previous calendar day",
				scheduleCadence: "daily 09:00",
				scheduleTimezone: "America/Chicago",
				scheduleConfirmed: true,
				scheduleMode: "replace",
				criteria: [
					{
						id: "mail-report-created",
						label: "Mail report created",
						description: "The proof writes the requested report",
						category: "goal-obligation",
						expectation: "required-improvement",
						evaluator: { type: "workspace-mutation", toolNames: ["write", "edit"], minimumSuccesses: 1 },
					},
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.details).toMatchObject({ stage: "draft" });
		expect(await registry.list()).toEqual([]);
		const [build] = await lifecycle.list();
		expect(build).toMatchObject({
			stage: "draft",
			name: "daily-mail-agent",
			configuration: {
				model: { provider: "anthropic", id: "claude-haiku-4-5" },
				tools: ["read", "list", "google_workspace_email_search", "google_workspace_email_read"],
			},
			automationIntent: {
				task: "Review the previous calendar day",
				cadence: "daily 09:00",
				timezone: "America/Chicago",
				confirmed: true,
			},
			criteria: [expect.objectContaining({ id: "mail-report-created" })],
		});
	});

	test("accepts a new agent when the model repeats its name as the id", async () => {
		const { root, registry, lifecycle } = await setup();
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		const result = await tool.execute(
			"configure-repeated-id",
			{
				id: "clean-slate-mail-test",
				name: "clean-slate-mail-test",
				description: "Summarize the previous day",
				projectRoot: join(root, "mail"),
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(result.details).toMatchObject({ stage: "draft" });
		expect(await registry.list()).toEqual([]);
		expect(await lifecycle.list()).toEqual([
			expect.objectContaining({
				stage: "draft",
				name: "clean-slate-mail-test",
			}),
		]);
	});

	test("stages an existing-agent revision without changing the deployed definition", async () => {
		const { root, registry, lifecycle } = await setup();
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Review one boundary",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const [tool] = createAgentRegistryTools(registry, lifecycle);
		await tool.execute(
			"configure-2",
			{
				id: "reviewer",
				name: "Reviewer",
				description: "Review two boundaries",
			},
			undefined,
			undefined,
			{ cwd: join(root, "other-session") } as ExtensionContext,
		);

		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, description: "Review one boundary" });
		expect(await lifecycle.list()).toEqual([
			expect.objectContaining({
				stage: "draft",
				agentId: "reviewer",
				agentRevision: 1,
				configuration: expect.objectContaining({
					description: "Review two boundaries",
					projectRoot: join(root, "workspace"),
				}),
			}),
		]);
	});

	test("lets chat test and publish an unpublished candidate only after explicit confirmation", async () => {
		const { root, registry, lifecycle, runs } = await setup(new CompletedExecutor());
		const [configure, manage] = createAgentRegistryTools(registry, lifecycle);
		const configured = await configure.execute(
			"configure-chat",
			{
				name: "chat-published-agent",
				description: "Complete one confirmed task",
				projectRoot: join(root, "chat-agent"),
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await expect(
			manage.execute(
				"proof-unconfirmed",
				{ buildId: configured.details!.buildId, action: "run-proof", confirmed: false },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("confirm");
		const proof = await manage.execute(
			"proof-confirmed",
			{
				buildId: configured.details!.buildId,
				action: "run-proof",
				confirmed: true,
				prompt: "Complete the confirmed task once",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(proof.details).toMatchObject({ stage: "testing" });
		expect(await registry.list()).toEqual([]);
		const proofBuild = await lifecycle.get(configured.details!.buildId);
		await runs.waitForCompletion(proofBuild.proof!.runId);
		await lifecycle.get(proofBuild.id);
		await manage.execute(
			"accept-proof",
			{ buildId: proofBuild.id, action: "accept-proof", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await manage.execute(
			"publish-confirmed",
			{ buildId: proofBuild.id, action: "publish", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await registry.get("chat-published-agent")).toMatchObject({ revision: 1 });
	});

	test("lets chat publish and enable its retained confirmed schedule without skill export", async () => {
		// This synthetic package has no connection to a user's stored agent or schedule.
		const root = await mkdtemp(join(tmpdir(), "pi-agent-tool-complete-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
		const runs = new AgentRunManager(registry, new CompletedExecutor(), join(root, "runs"));
		await runs.initialize();
		const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
		await lifecycle.initialize();
		const routines = new RoutineRegistry(join(root, "routines"), undefined, async (definition) => {
			if (definition.target.kind === "agent") await lifecycle.assertAutomationAllowed(definition.target.agentId);
		});
		const promotion = new RunSkillPromotionService(runs, join(root, "skills"), lifecycle);
		let routineRefreshes = 0;
		const [configure, manage] = createAgentRegistryTools(registry, lifecycle, {
			promotion,
			routines,
			refreshRoutines: () => {
				routineRefreshes += 1;
				return Promise.resolve();
			},
		});
		const configured = await configure.execute(
			"configure-full-chat",
			{
				name: "exampletown-chat-agent",
				description: "Create a grounded Exampletown, Example State brief",
				projectRoot: join(root, "exampletown"),
				scheduleTask: "Create today's Exampletown, Example State brief",
				scheduleCadence: "daily 07:00",
				scheduleConfirmed: true,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const buildId = configured.details!.buildId;
		await manage.execute(
			"proof",
			{ buildId, action: "run-proof", confirmed: true, prompt: "Create today's Exampletown, Example State brief" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const proof = await lifecycle.get(buildId);
		await runs.waitForCompletion(proof.proof!.runId);
		await lifecycle.get(buildId);
		await manage.execute(
			"accept",
			{ buildId, action: "accept-proof", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const scheduled = await manage.execute(
			"publish-and-schedule",
			{ buildId, action: "publish-and-schedule", confirmed: true, timezone: "America/Chicago" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(scheduled.details).toMatchObject({ stage: "automated" });
		expect(routineRefreshes).toBe(1);
		expect(await routines.list()).toEqual([
			expect.objectContaining({
				enabled: true,
				cron: "0 7 * * *",
				timezone: "America/Chicago",
				target: { kind: "agent", agentId: "exampletown-chat-agent" },
			}),
		]);
		const initialRoutine = (await routines.list())[0]!;
		await configure.execute(
			"additional-intent",
			{
				id: "exampletown-chat-agent",
				name: "exampletown-chat-agent",
				scheduleTask: "Create an evening brief",
				scheduleCadence: "daily 18:00",
				scheduleTimezone: "America/Chicago",
				scheduleConfirmed: true,
				scheduleMode: "additional",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect((await lifecycle.get(buildId)).stage).toBe("automated");
		await manage.execute(
			"additional-schedule",
			{ buildId, action: "schedule", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await routines.list()).toHaveLength(2);
		expect((await routines.list()).find((routine) => routine.id === initialRoutine.id)).toEqual(initialRoutine);
	});

	test("binds chat confirmation to one exact proposal and rejects a bare yes when several are pending", async () => {
		const { root, registry, lifecycle, runs } = await setup(new CompletedExecutor());
		let userMessage: AgentBuildUserMessage | undefined;
		const conversationBuilds = new ConversationBuildCoordinator(
			join(root, "conversation"),
			lifecycle,
			() => userMessage,
		);
		await conversationBuilds.initialize();
		const [configure, manage, inspect] = createAgentRegistryTools(registry, lifecycle, {
			conversationBuilds,
			sessionId: "session-exact-approval",
		});
		const first = await configure.execute(
			"configure-first",
			{ name: "first-candidate", description: "Complete the first task", projectRoot: join(root, "first") },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const second = await configure.execute(
			"configure-second",
			{ name: "second-candidate", description: "Complete the second task", projectRoot: join(root, "second") },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const firstProposal = await manage.execute(
			"propose-first",
			{
				buildId: first.details!.buildId,
				action: "run-proof",
				confirmed: false,
				prompt: "Complete the first task",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		// Live UI regression: proposal IDs must reach model-visible content, not only UI details.
		expect(firstProposal.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining(firstProposal.details!.proposalId!) }),
		]);
		await expect(
			manage.execute(
				"missing-proposal-id",
				{
					buildId: first.details!.buildId,
					action: "run-proof",
					confirmed: true,
					prompt: "Complete the first task",
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("proposalId is required");
		const retained = await conversationBuilds.inspect(first.details!.buildId);
		expect(retained.proposals).toHaveLength(1);
		expect(retained.proposals[0]).toMatchObject({ id: firstProposal.details!.proposalId, state: "pending" });
		const inspected = await inspect.execute(
			"recover-proposal",
			{ buildId: first.details!.buildId },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(inspected.content).toEqual([
			expect.objectContaining({ text: expect.stringContaining(firstProposal.details!.proposalId!) }),
		]);
		await manage.execute(
			"propose-second",
			{
				buildId: second.details!.buildId,
				action: "run-proof",
				confirmed: false,
				prompt: "Complete the second task",
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const confirmation = {
			buildId: first.details!.buildId,
			action: "run-proof" as const,
			confirmed: true,
			proposalId: firstProposal.details!.proposalId,
			prompt: "Complete the first task",
		};
		userMessage = { id: "ambiguous", text: "yes", createdAt: Date.now() + 1 };
		await expect(
			manage.execute(
				"confirm-ambiguous",
				{ ...confirmation, confirmationText: "yes" },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow();
		userMessage = {
			id: "approval-1",
			text: `approve ${firstProposal.details!.proposalId}`,
			createdAt: Date.now() + 1,
		};
		const result = await manage.execute(
			"confirm-exact",
			{ ...confirmation, confirmationText: "Yes, test first-candidate" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(result.details).toMatchObject({ stage: "testing", proposalState: "completed" });
		await runs.waitForCompletion((await lifecycle.get(first.details!.buildId)).proof!.runId);
	});
});
