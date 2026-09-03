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
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ResultExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;

	constructor(result: Promise<AgentExecutionResult>) {
		this.result = result;
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

class SequenceExecutor implements AgentExecutor {
	#attempt = 0;
	readonly #failFirst: boolean;

	constructor(failFirst = false) {
		this.#failFirst = failFirst;
	}

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		this.#attempt += 1;
		if (this.#failFirst && this.#attempt === 1) {
			return Promise.resolve(
				new ResultExecution(
					new Promise((_, reject) => setTimeout(() => reject(new Error("temporary provider failure")), 10)),
				),
			);
		}
		return Promise.resolve(
			new ResultExecution(Promise.resolve({ output: `Result ${this.#attempt}: ${context.prompt}`, transcript: [] })),
		);
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class HangingExecutor implements AgentExecutor {
	start(): Promise<AgentExecution> {
		return Promise.resolve(new ResultExecution(new Promise(() => {})));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class SecretErrorExecutor implements AgentExecutor {
	start(): Promise<AgentExecution> {
		return Promise.resolve(
			new ResultExecution(
				new Promise((_, reject) =>
					setTimeout(
						() =>
							reject(
								new Error("Authorization: Bearer secret-value API_KEY=private C:\\Users\\example\\private.txt"),
							),
						10,
					),
				),
			),
		);
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(executor: AgentExecutor = new SequenceExecutor()) {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-tasks-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	await registry.save({
		id: "reporter",
		name: "Reporter",
		description: "Creates reports",
		projectRoot: join(root, "workspace"),
		tools: ["read"],
		capabilities: [
			{
				capabilityId: "email.read",
				capabilityVersion: 1,
				providerId: "google-workspace",
				connectionId: "personal",
			},
		],
		memory: "none",
		persona: "Evidence based",
		executor: "harness",
		permissionPolicy: "read-only",
		schedules: [],
	});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"), 4, {
		resolveCapabilityBindings: (definition) =>
			definition.capabilities.map((grant) => ({
				capabilityId: grant.capabilityId,
				capabilityVersion: grant.capabilityVersion,
				providerId: grant.providerId ?? "test-provider",
				providerDigest: "test-provider-digest",
				connectionId: grant.connectionId,
			})),
	});
	await runs.initialize();
	const tasks = new AgentTaskService(registry, runs, join(root, "serve"));
	await tasks.initialize();
	return { root, registry, runs, tasks };
}

describe("AgentTaskService durable work", () => {
	test("snapshots its contract, sequences events, and creates a durable routine artifact and Attention item", async () => {
		const { root, tasks } = await setup();
		const submitted = await tasks.submit({
			agentId: "reporter",
			prompt: "Create the morning report",
			source: "routine",
			routine: { id: "morning", revision: 3, scheduledFor: 1_787_950_800_000 },
			expectedDeliverable: { kind: "markdown", title: "Morning report" },
		});
		const completed = await tasks.waitForCompletion(submitted.id);
		expect(completed).toMatchObject({
			status: "completed",
			contract: {
				agentRevision: 1,
				permissionMode: "manual",
				providerAccountRefs: ["personal"],
				routine: { id: "morning", revision: 3 },
			},
			artifactIds: [expect.any(String)],
		});
		expect(tasks.listAttention("open")).toMatchObject([{ taskId: submitted.id, kind: "completed", status: "open" }]);
		const artifact = tasks.listArtifacts({ taskId: submitted.id })[0];
		expect(artifact).toMatchObject({ title: "Morning report", taskId: submitted.id, kind: "markdown" });
		expect(new TextDecoder().decode((await tasks.readArtifactContent(artifact!.id))?.data)).toContain(
			"Create the morning report",
		);
		const events = (await readFile(join(root, "serve", "tasks", "reporter", submitted.id, "events.jsonl"), "utf8"))
			.trim()
			.split(/\r?\n/)
			.map((line) => JSON.parse(line) as { sequence: number });
		expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));

		await tasks.dispose();
		const reopenedRuns = new AgentRunManager(
			new AgentRegistry(join(root, "registry"), { defaultWorkspace: root }),
			new SequenceExecutor(),
			join(root, "runs"),
			4,
			{
				resolveCapabilityBindings: (definition) =>
					definition.capabilities.map((grant) => ({
						capabilityId: grant.capabilityId,
						capabilityVersion: grant.capabilityVersion,
						providerId: grant.providerId ?? "test-provider",
						providerDigest: "test-provider-digest",
						connectionId: grant.connectionId,
					})),
			},
		);
		await reopenedRuns.initialize();
		const reopened = new AgentTaskService(
			new AgentRegistry(join(root, "registry"), { defaultWorkspace: root }),
			reopenedRuns,
			join(root, "serve"),
		);
		await reopened.initialize();
		expect(reopened.getTask(submitted.id)?.artifactIds).toEqual(completed.artifactIds);
		expect(reopened.listAttention("open")).toHaveLength(1);
		expect(reopened.listArtifacts()).toHaveLength(1);
		await reopened.dispose();
	});

	test("retries the same task with a new attempt and resolves its failure Attention item", async () => {
		const { tasks } = await setup(new SequenceExecutor(true));
		const submitted = await tasks.submit({ agentId: "reporter", prompt: "Try provider", source: "chat" });
		const failed = await tasks.waitForCompletion(submitted.id);
		expect(failed).toMatchObject({ status: "failed", attemptIds: [expect.any(String)] });
		expect(tasks.listAttention("open")).toMatchObject([{ taskId: submitted.id, kind: "failure" }]);

		const retried = await tasks.retry(submitted.id);
		expect(retried.id).toBe(submitted.id);
		const completed = await tasks.waitForCompletion(submitted.id);
		expect(completed.status).toBe("completed");
		expect(completed.attemptIds).toHaveLength(2);
		expect(tasks.listAttention("open")).toEqual([]);
		await tasks.dispose();
	});

	test("redacts and bounds persisted Attention summaries", async () => {
		const { tasks } = await setup(new SecretErrorExecutor());
		const submitted = await tasks.submit({ agentId: "reporter", prompt: "Fail safely", source: "chat" });
		await tasks.waitForCompletion(submitted.id);
		const summary = tasks.listAttention("open")[0]!.summary;
		expect(summary).toContain("[redacted]");
		expect(summary).toContain("[path]");
		expect(summary).not.toContain("secret-value");
		expect(summary).not.toContain("private.txt");
		expect(summary.length).toBeLessThanOrEqual(240);
		await tasks.dispose();
	});

	test("refreshes an artifact through a new governed task and appends a version", async () => {
		const { tasks } = await setup();
		const submitted = await tasks.submit({
			agentId: "reporter",
			prompt: "Create refreshable report",
			source: "routine",
			expectedDeliverable: { kind: "markdown", title: "Refreshable report" },
		});
		await tasks.waitForCompletion(submitted.id);
		const original = tasks.listArtifacts({ taskId: submitted.id })[0]!;
		const refresh = await tasks.refreshArtifact(original.id);
		await tasks.waitForCompletion(refresh.id);
		const updated = tasks.getArtifact(original.id);
		expect(updated?.id).toBe(original.id);
		expect(updated?.versionIds).toHaveLength(2);
		expect(tasks.getTask(refresh.id)?.artifactIds).toEqual([original.id]);
		await tasks.dispose();
	});

	test("marks an unreconciled active attempt interrupted after a serve restart", async () => {
		const { root, tasks } = await setup(new HangingExecutor());
		const submitted = await tasks.submit({ agentId: "reporter", prompt: "Long task", source: "chat" });
		await expect.poll(() => tasks.getTask(submitted.id)?.status, { timeout: 2_000 }).toBe("running");

		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
		const runs = new AgentRunManager(registry, new SequenceExecutor(), join(root, "reopened-runs"));
		await runs.initialize();
		const reopened = new AgentTaskService(registry, runs, join(root, "serve"));
		await reopened.initialize();
		expect(reopened.getTask(submitted.id)?.status).toBe("interrupted");
		expect(reopened.listAttention("open")).toMatchObject([{ taskId: submitted.id, kind: "failure" }]);

		await reopened.dispose();
	});
});
