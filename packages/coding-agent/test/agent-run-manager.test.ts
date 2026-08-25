import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeferredExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	resolve: (result: AgentExecutionResult) => void = () => {};
	reject: (error: Error) => void = () => {};
	aborted = false;

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

async function setup(): Promise<{
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
	});
	const executor = new FakeExecutor();
	return { root, registry, executor, runs: new AgentRunManager(registry, executor, join(root, "artifacts")) };
}

describe("AgentRunManager", () => {
	test("allows only one active run per agent and persists artifacts", async () => {
		const { root, registry, executor, runs } = await setup();
		const run = await runs.start("research", "Investigate this");
		await expect(runs.start("research", "Run concurrently")).rejects.toThrow("already has an active run");

		executor.executions[0].resolve({ output: "Result", transcript: [] });
		await expect.poll(() => runs.get(run.id)?.status).toBe("succeeded");
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

	test("aborts and waits for cleanup", async () => {
		const { executor, runs } = await setup();
		const run = await runs.start("research", "Long task");
		await expect(runs.abort(run.id)).resolves.toMatchObject({ status: "aborted" });
		expect(executor.executions[0].aborted).toBe(true);
		await expect.poll(() => runs.get(run.id)?.finishedAt).toBeTypeOf("number");
	});

	test("prevents different agents from mutating the same project concurrently", async () => {
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
		await expect(runs.start("review", "Review")).rejects.toThrow("already has an active run");
		executor.executions[0]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(active.id);
		const review = await runs.start("review", "Review after release");
		expect(review).toMatchObject({ agentId: "review" });
		executor.executions[1]!.resolve({ output: "Done", transcript: [] });
		await runs.waitForCompletion(review.id);
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
