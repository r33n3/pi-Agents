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

async function setup(): Promise<{
	root: string;
	registry: AgentRegistry;
	lifecycle: AgentBuildLifecycleService;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-tool-lifecycle-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
	const runs = new AgentRunManager(registry, new IdleExecutor(), join(root, "runs"));
	await runs.initialize();
	const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
	await lifecycle.initialize();
	return { root, registry, lifecycle };
}

describe("configure_agent lifecycle tool", () => {
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
				projectRoot: join(root, "workspace"),
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, description: "Review one boundary" });
		expect(await lifecycle.list()).toEqual([
			expect.objectContaining({
				stage: "draft",
				agentId: "reviewer",
				agentRevision: 1,
				configuration: expect.objectContaining({ description: "Review two boundaries" }),
			}),
		]);
	});

	test("lets chat publish and start a proof only after explicit confirmation", async () => {
		const { root, registry, lifecycle } = await setup();
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
				"publish-unconfirmed",
				{ buildId: configured.details!.buildId, action: "publish", confirmed: false },
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("confirm");
		await manage.execute(
			"publish-confirmed",
			{ buildId: configured.details!.buildId, action: "publish", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await registry.get("chat-published-agent")).toMatchObject({ revision: 1 });
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
	});

	test("lets chat promote a proven build and enable only its retained confirmed schedule", async () => {
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
				name: "ozark-chat-agent",
				description: "Create a grounded Ozark, Missouri brief",
				projectRoot: join(root, "ozark"),
				scheduleTask: "Create today's Ozark, Missouri brief",
				scheduleCadence: "daily 07:00",
				scheduleConfirmed: true,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const buildId = configured.details!.buildId;
		await manage.execute(
			"publish",
			{ buildId, action: "publish", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		await manage.execute(
			"proof",
			{ buildId, action: "run-proof", confirmed: true, prompt: "Create today's Ozark, Missouri brief" },
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
		await manage.execute(
			"promote",
			{ buildId, action: "promote", confirmed: true },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const scheduled = await manage.execute(
			"schedule",
			{ buildId, action: "schedule", confirmed: true, timezone: "America/Chicago" },
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
				target: { kind: "agent", agentId: "ozark-chat-agent" },
			}),
		]);
	});
});
