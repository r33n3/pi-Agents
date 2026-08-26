import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentExecution, AgentExecutionResult } from "../src/core/serve/agent-executor.ts";
import {
	type ExternalConnectionExecutionRequest,
	ExternalConnectionManager,
} from "../src/core/serve/external-connection-manager.ts";

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

async function setup(): Promise<{
	root: string;
	manager: ExternalConnectionManager;
	executions: DeferredExecution[];
	requests: ExternalConnectionExecutionRequest[];
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-external-runs-"));
	roots.push(root);
	const executions: DeferredExecution[] = [];
	const requests: ExternalConnectionExecutionRequest[] = [];
	const manager = new ExternalConnectionManager(
		[
			{
				id: "openai",
				name: "OpenAI Agent",
				description: "External agent",
				inputLabel: "Task",
				available: true,
				defaultModel: { provider: "openai", id: "gpt-5.6-luna" },
				models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
			},
		],
		(request) => {
			const execution = new DeferredExecution();
			requests.push(request);
			executions.push(execution);
			return Promise.resolve(execution);
		},
		join(root, "artifacts"),
		root,
	);
	await manager.initialize();
	return { root, manager, executions, requests };
}

describe("ExternalConnectionManager", () => {
	test("starts a model-bound delegation and persists its returned data", async () => {
		const { root, manager, executions, requests } = await setup();
		const run = await manager.start({ connectionId: "openai", prompt: "Investigate", cwd: root });
		expect(requests[0]).toMatchObject({
			connection: { id: "openai" },
			model: { provider: "openai", id: "gpt-5.6-luna" },
			prompt: "Investigate",
		});

		executions[0].resolve({ output: "Returned result", transcript: [] });
		await expect.poll(() => manager.getRun(run.id)?.status).toBe("succeeded");
		expect(await readFile(join(root, "artifacts", run.id, "result.md"), "utf8")).toBe("Returned result\n");
		await expect(manager.readResult(run.id)).resolves.toBe("Returned result\n");
	});

	test("rejects unsupported models and aborts active delegations", async () => {
		const { manager, executions } = await setup();
		await expect(
			manager.start({
				connectionId: "openai",
				prompt: "Invalid model",
				model: { provider: "openai", id: "gpt-5.6-sol" },
			}),
		).rejects.toThrow("not supported");

		const run = await manager.start({ connectionId: "openai", prompt: "Long task" });
		await expect(manager.abort(run.id)).resolves.toMatchObject({ status: "aborted" });
		expect(executions[0].aborted).toBe(true);
	});

	test("records authentication protocol responses as failed delegations", async () => {
		const { manager, executions } = await setup();
		const run = await manager.start({ connectionId: "openai", prompt: "Delegate" });

		executions[0].resolve({ output: "HTTP 401: Missing Authentication header", transcript: [] });
		await expect.poll(() => manager.getRun(run.id)?.status).toBe("failed");
		expect(manager.getRun(run.id)?.error).toBe("HTTP 401: Missing Authentication header");
		await expect(manager.readResult(run.id)).resolves.toBeUndefined();
	});
});
