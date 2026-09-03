import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, test } from "vitest";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionEvent,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { type AgentRunConfigurationOptions, AgentRunManager } from "../src/core/serve/agent-run-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeferredExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	resolve: (result: AgentExecutionResult) => void = () => {};
	reject: (error: Error) => void = () => {};
	aborted = false;
	listener: ((event: AgentExecutionEvent) => void) | undefined;

	constructor() {
		this.result = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	subscribe(listener: (event: AgentExecutionEvent) => void): () => void {
		this.listener = listener;
		return () => {
			if (this.listener === listener) this.listener = undefined;
		};
	}

	emit(event: AgentExecutionEvent): void {
		this.listener?.(event);
	}

	abort(): Promise<void> {
		this.aborted = true;
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
		const execution = new DeferredExecution();
		this.contexts.push(context);
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

async function setup(
	budget?: { maxTokens?: number; maxCostUsd?: number },
	configuration: AgentRunConfigurationOptions = {},
): Promise<{
	root: string;
	registry: AgentRegistry;
	executor: FakeExecutor;
	runs: AgentRunManager;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-runs-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"));
	await registry.save({
		id: "research",
		name: "Research",
		description: "Researches",
		tools: ["read"],
		memory: "none",
		persona: "Careful",
		executor: "harness",
		permissionPolicy: "read-only",
		schedules: [],
		budget,
	});
	const executor = new FakeExecutor();
	return {
		root,
		registry,
		executor,
		runs: new AgentRunManager(registry, executor, join(root, "artifacts"), 4, configuration),
	};
}

describe("AgentRunManager", () => {
	test("allows only one active run per agent and persists artifacts", async () => {
		const { root, registry, executor, runs } = await setup();
		const run = await runs.start("research", "Investigate this");
		expect(runs.isActive(run.id)).toBe(true);
		await expect(runs.start("research", "Run concurrently")).rejects.toThrow("already has an active run");
		const snapshot = JSON.parse(
			await readFile(join(root, "artifacts", "research", run.id, "run-snapshot.json"), "utf8"),
		) as Record<string, unknown>;
		expect(snapshot).toMatchObject({
			version: 1,
			runId: run.id,
			configuration: {
				version: 1,
				agentId: "research",
				agentRevision: 1,
				workspace: registry.workspacePath((await registry.get("research"))!),
				capabilityBindings: [],
			},
			digest: run.snapshotDigest,
		});
		expect(Object.isFrozen(executor.contexts[0]!.definition)).toBe(true);
		expect(() => {
			executor.contexts[0]!.definition.persona = "Changed after admission";
		}).toThrow();

		executor.executions[0].resolve({ output: "Result", transcript: [] });
		// In-memory status changes before cleanup and persistence finish; restart only after completion.
		await expect(runs.waitForCompletion(run.id)).resolves.toMatchObject({ status: "succeeded" });
		expect(runs.isActive(run.id)).toBe(false);
		expect(await readFile(join(root, "artifacts", "research", run.id, "result.md"), "utf8")).toBe("Result\n");
		await expect(runs.readResult(run.id)).resolves.toBe("Result\n");

		const restored = new AgentRunManager(registry, new FakeExecutor(), join(root, "artifacts"));
		await restored.initialize();
		expect(restored.get(run.id)).toMatchObject({
			status: "succeeded",
			agentRevision: 1,
			artifactDirectory: run.artifactDirectory,
		});
	});

	test("captures the effective model and resolved provider bindings once", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-run-snapshot-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"));
		await registry.save({
			id: "mail",
			name: "Mail",
			description: "Reads mail",
			tools: ["read"],
			capabilities: [
				{
					capabilityId: "communication.email.read",
					capabilityVersion: 1,
					providerId: "google-workspace",
					connectionId: "primary",
				},
			],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const executor = new FakeExecutor();
		const runs = new AgentRunManager(registry, executor, join(root, "artifacts"), 4, {
			defaultModel: { provider: "openai", id: "gpt-test" },
			resolveCapabilityBindings: (definition) =>
				definition.capabilities.map((grant) => ({
					capabilityId: grant.capabilityId,
					capabilityVersion: grant.capabilityVersion,
					providerId: grant.providerId!,
					providerDigest: "provider-digest",
					connectionId: grant.connectionId,
				})),
		});
		const run = await runs.start("mail", "Read messages");
		const snapshot = JSON.parse(await readFile(join(run.artifactDirectory, "run-snapshot.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(snapshot).toMatchObject({
			configuration: {
				effectiveModel: { provider: "openai", id: "gpt-test" },
				definition: { model: { provider: "openai", id: "gpt-test" } },
				capabilityBindings: [
					{
						capabilityId: "communication.email.read",
						capabilityVersion: 1,
						providerId: "google-workspace",
						providerDigest: "provider-digest",
						connectionId: "primary",
					},
				],
			},
		});
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(run.id);
	});

	test("rejects a persisted run whose configuration snapshot no longer matches its digest", async () => {
		const { root, registry, executor, runs } = await setup();
		const run = await runs.start("research", "Investigate this");
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(run.id);
		const snapshotPath = join(run.artifactDirectory, "run-snapshot.json");
		const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as {
			configuration: { definition: { persona: string } };
		};
		snapshot.configuration.definition.persona = "Tampered";
		await writeFile(snapshotPath, `${JSON.stringify(snapshot)}\n`, "utf8");

		const restored = new AgentRunManager(registry, new FakeExecutor(), join(root, "artifacts"));
		await restored.initialize();
		expect(restored.get(run.id)).toBeUndefined();
	});

	test("aborts and waits for cleanup", async () => {
		const { executor, runs } = await setup();
		const run = await runs.start("research", "Long task");
		await expect(runs.abort(run.id)).resolves.toMatchObject({ status: "aborted" });
		expect(runs.isActive(run.id)).toBe(false);
		expect(() => runs.assertActive(run.id)).toThrow(`Agent run ${run.id} is not active`);
		expect(executor.executions[0].aborted).toBe(true);
		await expect.poll(() => runs.get(run.id)?.finishedAt).toBeTypeOf("number");
	});

	test("revokes outstanding approvals when a run becomes terminal", async () => {
		const revoked: Array<{ runId: string; reason: string }> = [];
		const { executor, runs } = await setup(undefined, {
			revokeRunApprovals: (runId, reason) => {
				revoked.push({ runId, reason });
				return Promise.resolve();
			},
		});
		const run = await runs.start("research", "Bounded task");
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await expect(runs.waitForCompletion(run.id)).resolves.toMatchObject({ status: "succeeded" });
		expect(revoked).toEqual([{ runId: run.id, reason: `Agent run ${run.id} succeeded` }]);
	});

	test("fails a completed execution whose measured usage exceeds its package budget", async () => {
		const { executor, runs } = await setup({ maxTokens: 5, maxCostUsd: 0.01 });
		const run = await runs.start("research", "Bounded task");
		const transcript: AgentMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "Too large" }],
				api: "openai-responses",
				provider: "openai",
				model: "fixture",
				usage: {
					input: 10,
					output: 6,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 16,
					cost: { input: 0, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.02 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];
		executor.executions[0]!.resolve({ output: "Too large", transcript });
		await expect(runs.waitForCompletion(run.id)).resolves.toMatchObject({
			status: "failed",
			error: "Agent output token budget exceeded: 6 > 5",
			usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16, costUsd: 0.02 },
		});
	});

	test("persists worker phase and activity while a run is active", async () => {
		const { root, executor, runs } = await setup();
		const run = await runs.start("research", "Long task");
		executor.executions[0].emit({
			kind: "progress",
			phase: "waiting-for-model",
			message: "Waiting for model response",
			timestamp: 1234,
		});
		await expect.poll(() => runs.get(run.id)?.phase).toBe("waiting-for-model");
		expect(runs.get(run.id)).toMatchObject({
			progressMessage: "Waiting for model response",
			lastActivityAt: 1234,
		});
		executor.executions[0].resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(run.id);
		const persisted = JSON.parse(
			await readFile(join(root, "artifacts", "research", run.id, "run.json"), "utf8"),
		) as Record<string, unknown>;
		expect(persisted).toMatchObject({ phase: "waiting-for-model", lastActivityAt: 1234 });
	});

	test("allows read-only agents to inspect the same project concurrently", async () => {
		const { registry, executor, runs } = await setup();
		await registry.save({
			id: "review",
			name: "Review",
			description: "Reviews",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const active = await runs.start("research", "Research");
		const review = await runs.start("review", "Review concurrently");
		expect(review).toMatchObject({ agentId: "review", status: "running" });
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		executor.executions[1]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(active.id);
		await runs.waitForCompletion(review.id);
	});

	test("runs a temporary specialist without adding it to the agent catalog", async () => {
		const { root, registry, executor, runs } = await setup();
		const before = await registry.list();
		const run = await runs.startTemporarySpecialist("research", "Inspect one bounded concern");

		expect(run.agentId).toMatch(/^temporary-[0-9a-f-]+$/);
		expect(run.temporarySourceAgentId).toBe("research");
		expect(executor.contexts[0]).toMatchObject({
			definition: {
				id: run.agentId,
				name: "Research specialist",
				permissionPolicy: "read-only",
			},
		});
		expect(await registry.list()).toEqual(before);

		executor.executions[0]!.resolve({ output: "Specialist result", transcript: [] });
		await expect(runs.waitForCompletion(run.id)).resolves.toMatchObject({
			status: "succeeded",
			temporarySourceAgentId: "research",
		});
		await expect(readFile(join(root, "artifacts", run.agentId, run.id, "result.md"), "utf8")).resolves.toBe(
			"Specialist result\n",
		);
		expect(await registry.list()).toEqual(before);
	});

	test("serializes a workspace writer against other agents in the same project", async () => {
		const { registry, executor, runs } = await setup();
		await registry.save({
			id: "writer",
			name: "Writer",
			description: "Writes",
			tools: ["read", "write"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "workspace-write",
			schedules: [],
		});
		const active = await runs.start("research", "Research");
		await expect(runs.start("writer", "Write")).rejects.toThrow("already has an active run");
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(active.id);
		const write = await runs.start("writer", "Write after release");
		executor.executions[1]!.resolve({ output: "Written", transcript: [] });
		await runs.waitForCompletion(write.id);
	});

	test("runs agents in separate projects concurrently and stopping one does not affect the other", async () => {
		const { root, registry, executor, runs } = await setup();
		await registry.save({
			id: "review",
			name: "Review",
			description: "Reviews",
			projectRoot: join(root, "review-workspace"),
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const research = await runs.start("research", "Research");
		const review = await runs.start("review", "Review");
		expect(executor.contexts.map((entry) => entry.workspace)).toEqual([
			registry.workspacePath((await registry.get("research"))!),
			registry.workspacePath((await registry.get("review"))!),
		]);
		await runs.abort(research.id);
		expect(runs.get(research.id)?.status).toBe("aborted");
		expect(runs.get(review.id)?.status).toBe("running");
		expect(executor.executions[1].aborted).toBe(false);
		executor.executions[1].resolve({ output: "Reviewed", transcript: [] });
		await expect(runs.waitForCompletion(review.id)).resolves.toMatchObject({ status: "succeeded" });
	});

	test("dispose aborts every active worker and waits for lease cleanup", async () => {
		const { root, registry, executor, runs } = await setup();
		await registry.save({
			id: "review",
			name: "Review",
			description: "Reviews",
			projectRoot: join(root, "review-workspace"),
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const first = await runs.start("research", "Research");
		const second = await runs.start("review", "Review");
		await runs.dispose();
		expect(executor.executions.every((execution) => execution.aborted)).toBe(true);
		expect(runs.get(first.id)?.status).toBe("aborted");
		expect(runs.get(second.id)?.status).toBe("aborted");
		await expect(runs.start("research", "After disposal")).rejects.toThrow("Operation queue is closed");
	});

	test("leases named browser profiles across different projects", async () => {
		const { root, registry, executor, runs } = await setup();
		const browser = {
			access: "public-web" as const,
			runtime: "managed-chromium" as const,
			profile: { kind: "named" as const, id: "shared" },
		};
		await registry.save({
			id: "browser-one",
			name: "Browser one",
			description: "Browses",
			projectRoot: join(root, "one"),
			tools: ["browser"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			browser,
		});
		await registry.save({
			id: "browser-two",
			name: "Browser two",
			description: "Browses",
			projectRoot: join(root, "two"),
			tools: ["browser"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			browser,
		});
		const first = await runs.start("browser-one", "Browse");
		await expect(runs.start("browser-two", "Browse too")).rejects.toThrow("browser-profile:shared");
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(first.id);
	});
});
