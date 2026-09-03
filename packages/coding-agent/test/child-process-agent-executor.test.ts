import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Type from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import type { AgentExecutionContext } from "../src/core/serve/agent-executor.ts";
import { type AgentHostFileSystem, ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";

const workerPath = fileURLToPath(new URL("./fixtures/agent-worker-fixture.mjs", import.meta.url));
const sourceWorkerPath = fileURLToPath(new URL("./fixtures/agent-worker-tsconfig-fixture.ts", import.meta.url));

function context(prompt: string, runId = "run-1", workspace = process.cwd(), writable = false): AgentExecutionContext {
	return {
		runId,
		workspace,
		prompt,
		definition: {
			id: "researcher",
			revision: 2,
			source: "managed",
			name: "Researcher",
			description: "Researches",
			tools: writable ? ["read", "list", "write"] : ["read"],
			capabilities: [],
			memory: "none",
			persona: "Careful",
			model: { provider: "openai", id: "test" },
			projectRoot: workspace,
			workspace,
			executor: "harness",
			permissionPolicy: writable ? "workspace-write" : "read-only",
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
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("done"));
		const events: Array<{ kind: string; message: string }> = [];
		execution.subscribe((event) => events.push(event));
		await expect(execution.result).resolves.toMatchObject({ output: "done", transcript: [] });
		expect(events).toContainEqual(expect.objectContaining({ kind: "progress", message: "started" }));
		await execution.dispose();
		await executor.dispose();
	});

	test("resolves workspace source packages when a TypeScript worker runs outside the repository", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-agent-source-worker-"));
		try {
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath: sourceWorkerPath,
			});
			const execution = await executor.start(context("source", "run-source", workspace));
			await expect(execution.result).resolves.toMatchObject({ output: "workspace imports resolved" });
			await execution.dispose();
			await executor.dispose();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("returns a large transcript through the durable result artifact", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("large"));
		const result = await execution.result;
		expect(result.output).toBe("large");
		expect(JSON.stringify(result.transcript).length).toBeGreaterThan(2_000_000);
		await execution.dispose();
		await executor.dispose();
	});

	test("recovers a durable result when the worker exits before notifying the parent", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("result-without-ipc"));
		await expect(execution.result).resolves.toMatchObject({ output: "recovered", transcript: [] });
		await execution.dispose();
		await executor.dispose();
	});

	test("recovers a durable agent error when the worker exits before notifying the parent", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("error-without-ipc"));
		await expect(execution.result).rejects.toThrow("durable worker failure");
		await execution.dispose();
		await executor.dispose();
	});

	test("does not forward provider configuration through the worker environment", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
			resolveModelApiKey: async (model) =>
				model.provider === "openai" && model.id === "test" ? "ephemeral-provider-value" : undefined,
			environment: {
				PATH: process.env.PATH,
				PATHEXT: process.env.PATHEXT,
				SYSTEMROOT: process.env.SYSTEMROOT,
				OPENAI_API_KEY: "provider-value",
				GOOGLE_OAUTH_ACCESS_TOKEN: "google-token",
				FIRECRAWL_API_KEY: "firecrawl-key",
				FIRECRAWL_BASE_URL: "http://127.0.0.1:3002",
				SEARXNG_BASE_URL: "http://127.0.0.1:8080",
				PI_TEST_UNRELATED_SECRET: "must-not-pass",
			},
		});
		const result = await (await executor.start(context("inspect"))).result;
		const inspected = JSON.parse(result.output) as Record<string, unknown>;
		expect(inspected.provider).toBeUndefined();
		expect(inspected.modelCredentialReceived).toBe(true);
		expect(inspected.googleAccess).toBeUndefined();
		expect(inspected.firecrawlKey).toBeUndefined();
		expect(inspected.firecrawlUrl).toBeUndefined();
		expect(inspected.searxngUrl).toBeUndefined();
		expect(inspected.secret).toBeUndefined();
		await executor.dispose();
	});

	test("runs distinct workers concurrently with isolated working directories and process state", async () => {
		const firstWorkspace = await mkdtemp(join(tmpdir(), "pi-agent-worker-one-"));
		const secondWorkspace = await mkdtemp(join(tmpdir(), "pi-agent-worker-two-"));
		try {
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
			});
			const first = await executor.start(context("inspect", "run-one", firstWorkspace));
			const second = await executor.start(context("inspect", "run-two", secondWorkspace));
			const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
			const firstInspection = JSON.parse(firstResult.output) as { cwd: string; pid: number };
			const secondInspection = JSON.parse(secondResult.output) as { cwd: string; pid: number };
			expect(resolve(firstInspection.cwd)).toBe(resolve(firstWorkspace));
			expect(resolve(secondInspection.cwd)).toBe(resolve(secondWorkspace));
			expect(firstInspection.pid).not.toBe(secondInspection.pid);
			await executor.dispose();
		} finally {
			await Promise.all([
				rm(firstWorkspace, { recursive: true, force: true }),
				rm(secondWorkspace, { recursive: true, force: true }),
			]);
		}
	});

	test("brokers granted capability tools through the parent process", async () => {
		const calls: unknown[] = [];
		const tool: ToolDefinition = {
			name: "test_capability",
			label: "Test capability",
			description: "Runs in the parent process",
			parameters: Type.Object({ value: Type.String() }),
			async execute(_id, input) {
				calls.push(input);
				return { content: [{ type: "text", text: "host result" }], details: undefined };
			},
		};
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [tool],
			workerPath,
		});
		const result = JSON.parse((await (await executor.start(context("capability"))).result).output) as {
			content: Array<{ text: string }>;
		};
		expect(calls).toEqual([{ value: "worker input" }]);
		expect(result.content[0]?.text).toBe("host result");
		await executor.dispose();
	});

	test("stopping one worker does not interrupt another worker", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const stopped = await executor.start(context("slow", "run-stopped"));
		const unaffected = await executor.start(context("medium", "run-unaffected"));
		const stoppedResult = expect(stopped.result).rejects.toThrow("aborted");
		await stopped.abort();
		await stoppedResult;
		await expect(unaffected.result).resolves.toMatchObject({ output: "medium" });
		await executor.dispose();
	});

	test("executes allowed filesystem requests in the host after durable decisions", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-agent-host-files-"));
		try {
			await writeFile(join(workspace, "input.txt"), "host content", "utf8");
			const audit = new ServeAuditStore(join(serveRoot, "audit"));
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
				governedActions: new GovernedActionService(audit),
			});
			const execution = await executor.start(context("filesystem", "run-filesystem", workspace, true));
			const result = JSON.parse((await execution.result).output) as Array<{
				family: string;
				content?: string;
				entries?: Array<{ name: string }>;
				bytesWritten?: number;
			}>;
			expect(result[0]).toMatchObject({ family: "filesystem.read", content: "host content" });
			expect(result[1]?.entries).toContainEqual(expect.objectContaining({ name: "input.txt" }));
			expect(result[2]).toMatchObject({ family: "filesystem.write", bytesWritten: 17 });
			expect(await readFile(join(workspace, "nested", "output.txt"), "utf8")).toBe("written by worker");
			const events = await audit.read();
			for (const decision of events.filter((event) => event.kind === "decision")) {
				const outcomeIndex = events.findIndex(
					(event) => event.kind === "outcome" && event.correlationId === decision.correlationId,
				);
				expect(outcomeIndex).toBeGreaterThan(events.indexOf(decision));
			}
			expect(events).toHaveLength(6);
			expect(JSON.stringify(events)).not.toContain("written by worker");
			await execution.dispose();
			await executor.dispose();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("denies workspace escape before a filesystem effect", async () => {
		const container = await mkdtemp(join(tmpdir(), "pi-agent-host-boundary-"));
		const workspace = join(container, "workspace");
		const escaped = join(container, "escaped.txt");
		await mkdir(workspace);
		try {
			const audit = new ServeAuditStore(join(serveRoot, "audit"));
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
				governedActions: new GovernedActionService(audit),
			});
			const result = JSON.parse(
				(await (await executor.start(context("escape", "run-escape", workspace, true))).result).output,
			) as { code: string; error: string };
			expect(result).toMatchObject({
				code: "ERR_GOVERNED_ACTION_DENIED",
				error: "Requested path is outside the agent workspace",
			});
			await expect(readFile(escaped, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
			await expect(audit.read()).resolves.toMatchObject([
				{ kind: "decision", decision: "deny", policy: "workspace-boundary" },
			]);
			await executor.dispose();
		} finally {
			await rm(container, { recursive: true, force: true });
		}
	});

	test("multiplexes concurrent host filesystem requests", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-agent-host-concurrent-"));
		await writeFile(join(workspace, "input.txt"), "input", "utf8");
		let active = 0;
		let maximumActive = 0;
		let arrived = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitTogether = async <T>(result: T): Promise<T> => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			arrived += 1;
			if (arrived === 3) release();
			await gate;
			active -= 1;
			return result;
		};
		const hostFileSystem: AgentHostFileSystem = {
			read: () => waitTogether("input"),
			list: () => waitTogether([{ kind: "file", name: "input.txt" }]),
			write: () => waitTogether(17),
		};
		try {
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
				governedActions: new GovernedActionService(new ServeAuditStore(join(serveRoot, "audit"))),
				hostFileSystem,
			});
			await (await executor.start(context("filesystem", "run-concurrent", workspace, true))).result;
			expect(maximumActive).toBe(3);
			await executor.dispose();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("aborts a pending host action when its worker is stopped", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-agent-host-abort-"));
		await writeFile(join(workspace, "slow.txt"), "input", "utf8");
		let started: () => void = () => {};
		const actionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let hostActionAborted = false;
		const hostFileSystem = blockingHostFileSystem(
			() => started(),
			() => {
				hostActionAborted = true;
			},
		);
		try {
			const audit = new ServeAuditStore(join(serveRoot, "audit"));
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
				governedActions: new GovernedActionService(audit),
				hostFileSystem,
			});
			const execution = await executor.start(context("host-action-slow", "run-host-abort", workspace));
			const result = expect(execution.result).rejects.toThrow("aborted");
			await actionStarted;
			await execution.abort();
			await result;
			expect(hostActionAborted).toBe(true);
			await expect
				.poll(async () =>
					(await audit.read()).some((event) => event.kind === "outcome" && event.outcome === "cancelled"),
				)
				.toBe(true);
			await executor.dispose();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("cancels host actions and ignores late replies after a child crash", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "pi-agent-host-crash-"));
		await writeFile(join(workspace, "slow.txt"), "input", "utf8");
		let started: () => void = () => {};
		const actionStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let hostActionAborted = false;
		try {
			const audit = new ServeAuditStore(join(serveRoot, "audit"));
			const executor = new ChildProcessAgentExecutor({
				agentDir: process.cwd(),
				serveRoot,
				capabilityTools: () => [],
				workerPath,
				governedActions: new GovernedActionService(audit),
				hostFileSystem: blockingHostFileSystem(
					() => started(),
					() => {
						hostActionAborted = true;
					},
				),
			});
			const execution = await executor.start(context("host-action-crash", "run-host-crash", workspace));
			const result = execution.result.catch((error: unknown) => error);
			await actionStarted;
			const outcome = await result;
			expect(outcome).toBeInstanceOf(Error);
			if (!(outcome instanceof Error)) throw new Error("Expected the crashed worker to reject");
			expect(outcome.message).toContain("exited before returning a result");
			expect(hostActionAborted).toBe(true);
			await expect
				.poll(async () =>
					(await audit.read()).some((event) => event.kind === "outcome" && event.outcome === "cancelled"),
				)
				.toBe(true);
			await execution.dispose();
			await executor.dispose();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	test("aborts an unresponsive child", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("slow"));
		const result = expect(execution.result).rejects.toThrow("aborted");
		await execution.abort();
		await result;
		await execution.dispose();
		await executor.dispose();
	});

	test("times out a worker that heartbeats without making progress", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
			idleTimeoutMs: 30,
			heartbeatTimeoutMs: 200,
		});
		const execution = await executor.start(context("stalled-heartbeat"));
		await expect(execution.result).rejects.toThrow("made no progress");
		await execution.dispose();
		await executor.dispose();
	});

	test("times out a worker whose heartbeat stops", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
			idleTimeoutMs: 1_000,
			heartbeatTimeoutMs: 30,
		});
		const execution = await executor.start(context("silent"));
		await expect(execution.result).rejects.toThrow("heartbeat stopped");
		await execution.dispose();
		await executor.dispose();
	});

	test("kills the process tree after the graceful abort window", async () => {
		const executor = new ChildProcessAgentExecutor({
			agentDir: process.cwd(),
			serveRoot,
			capabilityTools: () => [],
			workerPath,
		});
		const execution = await executor.start(context("ignore-abort"));
		const result = expect(execution.result).rejects.toThrow("exited before returning a result");
		await execution.abort();
		await result;
		await execution.dispose();
		await executor.dispose();
	});
});

function blockingHostFileSystem(onStart: () => void, onAbort: () => void): AgentHostFileSystem {
	return {
		read(_path, signal) {
			onStart();
			return new Promise((_resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						onAbort();
						reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
					},
					{ once: true },
				);
			});
		},
		list: () => Promise.reject(new Error("Unexpected list")),
		write: () => Promise.reject(new Error("Unexpected write")),
	};
}
