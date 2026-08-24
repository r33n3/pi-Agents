import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentExecutionContext } from "../src/core/serve/agent-executor.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";

const workerPath = fileURLToPath(new URL("./fixtures/agent-worker-fixture.mjs", import.meta.url));

function context(prompt: string): AgentExecutionContext {
	return {
		runId: "run-1",
		workspace: process.cwd(),
		prompt,
		definition: {
			id: "researcher",
			revision: 2,
			source: "managed",
			name: "Researcher",
			description: "Researches",
			tools: ["read"],
			capabilities: [],
			memory: "none",
			persona: "Careful",
			projectRoot: process.cwd(),
			workspace: process.cwd(),
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			browserWorkflows: [],
			delegateAgentIds: [],
			a2a: { enabled: false },
		},
	};
}

describe("ChildProcessAgentExecutor", () => {
	let serveRoot: string;

	beforeEach(async () => {
		serveRoot = await mkdtemp(join(tmpdir(), "pi-agent-worker-result-"));
	});

	afterEach(async () => {
		await rm(serveRoot, { recursive: true, force: true });
	});

	test("returns progress and results over IPC", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityToolNames: () => [],
			workerPath,
		});
		const execution = await executor.start(context("done"));
		const events: string[] = [];
		execution.subscribe((event) => events.push(event));
		await expect(execution.result).resolves.toMatchObject({ output: "done", transcript: [] });
		expect(events).toContain("started");
		await execution.dispose();
		await executor.dispose();
	});

	test("returns a large transcript through the durable result artifact", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityToolNames: () => [],
			workerPath,
		});
		const execution = await executor.start(context("large"));
		const result = await execution.result;
		expect(result.output).toBe("large");
		expect(JSON.stringify(result.transcript).length).toBeGreaterThan(2_000_000);
		await execution.dispose();
		await executor.dispose();
	});

	test("aborts an unresponsive child", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityToolNames: () => [],
			workerPath,
		});
		const execution = await executor.start(context("slow"));
		await execution.abort();
		await expect(execution.result).rejects.toThrow("aborted");
		await execution.dispose();
		await executor.dispose();
	});

	test("kills the process tree after the graceful abort window", async () => {
		const previous = process.env.PI_TEST_IGNORE_AGENT_ABORT;
		process.env.PI_TEST_IGNORE_AGENT_ABORT = "1";
		try {
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityToolNames: () => [],
				workerPath,
			});
			const execution = await executor.start(context("slow"));
			await execution.abort();
			await expect(execution.result).rejects.toThrow("exited before returning a result");
			await execution.dispose();
			await executor.dispose();
		} finally {
			if (previous === undefined) delete process.env.PI_TEST_IGNORE_AGENT_ABORT;
			else process.env.PI_TEST_IGNORE_AGENT_ABORT = previous;
		}
	});
});
