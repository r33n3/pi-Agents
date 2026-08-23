import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { A2A_PROTOCOL_VERSION, A2aAdapter, A2aError } from "../src/core/serve/a2a-adapter.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";
import { BrowserWorkflowRunner } from "../src/core/serve/browser-workflow-runner.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class ImmediateExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;

	constructor(output: string) {
		this.result = Promise.resolve({ output, transcript: [] });
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

class ImmediateExecutor implements AgentExecutor {
	start(context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve(new ImmediateExecution(`${context.definition.name}: ${context.prompt}`));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class WorkflowNodeBrowserContext implements BrowserDriverContext {
	url = "about:blank";
	async setNavigationPolicy(): Promise<void> {}
	async navigate(url: string) {
		this.url = url;
		return { url, title: "Ready" };
	}
	async goBack() {
		return { url: this.url, title: "Ready" };
	}
	async goForward() {
		return { url: this.url, title: "Ready" };
	}
	async reload() {
		return { url: this.url, title: "Ready" };
	}
	async pointerClick(): Promise<void> {}
	async typeText(): Promise<void> {}
	async scroll(): Promise<void> {}
	async snapshot() {
		return { url: this.url, title: "Ready", elements: [] };
	}
	async elementAt(): Promise<undefined> {
		return undefined;
	}
	async focusedElement(): Promise<undefined> {
		return undefined;
	}
	async click(): Promise<void> {}
	async fill(): Promise<void> {}
	async select(): Promise<void> {}
	async scrollIntoView(): Promise<void> {}
	async press(): Promise<void> {}
	async screenshot() {
		return new Uint8Array([137, 80, 78, 71]);
	}
	async subscribeFrames() {
		return async () => {};
	}
	diagnostics() {
		return { console: [], networkFailures: [] };
	}
	downloads() {
		return [];
	}
	async close(): Promise<void> {}
}

class WorkflowNodeBrowserDriver implements BrowserDriver {
	async createContext(): Promise<BrowserDriverContext> {
		return new WorkflowNodeBrowserContext();
	}
	async dispose(): Promise<void> {}
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-services-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const [id, a2a] of [
		["researcher", true],
		["reviewer", false],
	] as const) {
		await registry.save({
			id,
			name: id,
			description: `${id} agent`,
			projectRoot: join(root, id),
			tools: ["read"],
			memory: "none",
			persona: "Evidence based",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			a2a: { enabled: a2a },
		});
	}
	const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
	await runs.initialize();
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	await tasks.initialize();
	return { root, registry, tasks };
}

describe("agent workflows and A2A", () => {
	test("persists and restores a bounded parallel workflow", async () => {
		const { root, registry, tasks } = await setup();
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		await workflows.save({
			id: "research-review",
			name: "Research review",
			pattern: "parallel",
			nodes: [
				{ id: "research", agentId: "researcher", prompt: "Research" },
				{ id: "review", agentId: "reviewer", prompt: "Review" },
			],
			edges: [],
			maxConcurrency: 2,
			maxDelegationDepth: 2,
			failurePolicy: "stop",
		});
		const run = await workflows.start("research-review", "Assess the design");
		await expect(workflows.waitForCompletion(run.id)).resolves.toMatchObject({
			status: "completed",
			taskIds: expect.arrayContaining([expect.any(String), expect.any(String)]),
		});

		const restored = new WorkflowService(join(root, "workflows"), registry, tasks);
		await restored.initialize();
		expect(restored.getDefinition("research-review")).toMatchObject({ pattern: "parallel", maxConcurrency: 2 });
		expect(restored.getRun(run.id)).toMatchObject({ status: "completed" });
		await tasks.dispose();
	});

	test("exposes only opted-in agents through A2A v1.0", async () => {
		const { registry, tasks } = await setup();
		const adapter = new A2aAdapter(registry, tasks);
		expect(adapter.validateVersion(A2A_PROTOCOL_VERSION)).toBeUndefined();
		await expect(adapter.agentCard("researcher", "http://127.0.0.1:4173")).resolves.toMatchObject({
			name: "researcher",
			supportedInterfaces: [{ protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
		});
		await expect(adapter.agentCard("reviewer", "http://127.0.0.1:4173")).rejects.toMatchObject({
			reason: "AGENT_NOT_FOUND",
		});
		const submitted = await adapter.sendMessage("researcher", {
			message: { parts: [{ text: "Find the evidence" }] },
		});
		const completed = await tasks.waitForCompletion(submitted.task.id);
		await expect(adapter.getTask("researcher", completed.id)).resolves.toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
			artifacts: [{ parts: [{ text: expect.stringContaining("Find the evidence") }] }],
		});
		expect(() => adapter.validateVersion("0.3")).toThrow(A2aError);
		await expect(adapter.listTasks("reviewer")).rejects.toMatchObject({ reason: "AGENT_NOT_FOUND" });
		await tasks.dispose();
	});

	test("runs an exact canonical browser workflow version as a larger workflow node", async () => {
		const { root, registry, tasks } = await setup();
		const browserRegistry = new BrowserWorkflowRegistry(join(root, "browser-workflows"));
		await browserRegistry.initialize();
		const draft = await browserRegistry.saveDraft({
			name: "Open fixture",
			description: "Open the local fixture",
			entry: {
				urlTemplate: "http://127.0.0.1:4173/fixture",
				allowedOrigins: ["http://127.0.0.1:4173"],
				ready: [{ kind: "page-ready" }],
			},
			parameters: [],
			steps: [],
			completion: [{ kind: "page-ready" }],
			requirements: {
				profile: "none",
				access: "loopback",
				viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
			},
			policy: { deadlineMs: 10_000, approval: "inherit" },
			source: { kind: "manual" },
		});
		const compiled = await browserRegistry.setStatus(draft.id, draft.version, "compiled");
		await browserRegistry.markValidated(compiled.id, compiled.version, {
			id: "validation-node",
			digest: compiled.digest,
			completedAt: Date.now(),
		});
		await browserRegistry.activate(compiled.id, compiled.version);
		const browserManager = new BrowserSessionManager(new WorkflowNodeBrowserDriver(), new BrowserProfileStore(root));
		const browserRunner = new BrowserWorkflowRunner(browserRegistry, browserManager, join(root, "browser-runs"));
		await browserRunner.initialize();
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks, {
			runner: browserRunner,
			owner: { kind: "pi-session", id: "workflow-owner" },
			workspace: { id: "project", root },
		});
		await workflows.initialize();
		await workflows.save({
			id: "browser-check",
			name: "Browser check",
			pattern: "sequential",
			nodes: [
				{
					id: "open",
					kind: "browser-workflow",
					workflowId: compiled.id,
					workflowVersion: compiled.version,
					parameters: {},
				},
			],
			edges: [],
			maxConcurrency: 1,
			maxDelegationDepth: 1,
			failurePolicy: "stop",
		});
		const started = await workflows.start("browser-check", "Check the fixture");
		await expect(workflows.waitForCompletion(started.id)).resolves.toMatchObject({
			status: "completed",
			browserRunIds: [expect.any(String)],
		});
		await browserManager.dispose();
		await tasks.dispose();
	});
});
