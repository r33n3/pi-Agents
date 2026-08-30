import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeferredExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	resolve: (result: AgentExecutionResult) => void = () => {};

	constructor() {
		this.result = new Promise((resolve) => {
			this.resolve = resolve;
		});
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

class DeferredExecutor implements AgentExecutor {
	readonly executions: DeferredExecution[] = [];

	start(_context: AgentExecutionContext): Promise<AgentExecution> {
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

async function setup(): Promise<{
	root: string;
	registry: AgentRegistry;
	runs: AgentRunManager;
	executor: DeferredExecutor;
	lifecycle: AgentBuildLifecycleService;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-build-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
	const executor = new DeferredExecutor();
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	await runs.initialize();
	const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
	await lifecycle.initialize();
	return { root, registry, runs, executor, lifecycle };
}

async function saveReviewer(registry: AgentRegistry): Promise<void> {
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
}

describe("AgentBuildLifecycleService", () => {
	test("persists a named draft and rejects a collision with a deployed agent", async () => {
		const { root, registry, lifecycle } = await setup();
		const draft = await lifecycle.createDraft({
			name: "Daily mail",
			objective: "Summarize the previous day",
			projectRoot: join(root, "workspace"),
		});
		expect(draft).toMatchObject({ stage: "draft", name: "Daily mail" });

		const restored = new AgentBuildLifecycleService(
			join(root, "lifecycle"),
			registry,
			new AgentRunManager(registry, new DeferredExecutor(), join(root, "runs")),
		);
		await restored.initialize();
		await expect(restored.get(draft.id)).resolves.toMatchObject({ name: "Daily mail", stage: "draft" });

		await saveReviewer(registry);
		await expect(
			lifecycle.createDraft({
				name: "Reviewer",
				objective: "Duplicate",
				projectRoot: join(root, "workspace"),
			}),
		).rejects.toThrow("already exists");
	});

	test("requires explicit proof review and invalidates evidence when the agent revision changes", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		const draft = await lifecycle.createDraft({
			name: "Reviewer",
			objective: "Review one boundary",
			projectRoot: join(root, "workspace"),
		});
		await saveReviewer(registry);
		const linked = await lifecycle.linkAgent(draft.id, "reviewer");
		expect(linked.stage).toBe("ready-to-test");

		const testing = await lifecycle.startProof(linked.id, "Review this boundary once");
		await expect(lifecycle.startProof(linked.id, "Start twice")).rejects.toThrow("active proof");
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(testing.proof!.runId);
		await expect(lifecycle.get(linked.id)).resolves.toMatchObject({ stage: "proof-ready" });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).rejects.toThrow("Review and accept");

		await expect(lifecycle.reviewProof(linked.id, true)).resolves.toMatchObject({ stage: "proven" });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).resolves.toMatchObject({ id: linked.id });

		await saveReviewer(registry);
		await expect(lifecycle.get(linked.id)).resolves.toMatchObject({ stage: "ready-to-test", agentRevision: 2 });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).rejects.toThrow("not the reviewed proof");
	});

	test("unlocks automation only after the accepted proof is promoted", async () => {
		const { registry, runs, executor, lifecycle } = await setup();
		await saveReviewer(registry);
		const build = await lifecycle.ensureForAgent("reviewer");
		const testing = await lifecycle.startProof(build.id, "Review once");
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(testing.proof!.runId);
		await lifecycle.get(build.id);
		await lifecycle.reviewProof(build.id, true);
		await expect(lifecycle.assertAutomationAllowed("reviewer")).rejects.toThrow("promote it to a skill");

		await lifecycle.markPromoted(testing.proof!.runId, "review-boundary", "C:/skills/review-boundary/SKILL.md");
		await expect(lifecycle.assertAutomationAllowed("reviewer")).resolves.toMatchObject({ stage: "promoted" });
		await expect(lifecycle.markAutomated("reviewer", "review-daily")).resolves.toMatchObject({
			stage: "automated",
			routineIds: ["review-daily"],
		});
	});
});
