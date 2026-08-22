import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { A2A_MEDIA_TYPE, A2aAdapter } from "../src/core/serve/a2a-adapter.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { createServePage } from "../src/core/serve/serve-page.ts";

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
		return Promise.resolve(new ImmediateExecution(`A2A result: ${context.prompt}`));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

describe("serve A2A HTTP+JSON boundary", () => {
	let root: string;
	let server: Server;
	let origin: string;
	let tasks: AgentTaskService;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-serve-a2a-"));
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
		await registry.save({
			id: "researcher",
			name: "Researcher",
			description: "Finds evidence",
			tools: ["read"],
			memory: "none",
			persona: "Evidence based",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			a2a: { enabled: true },
		});
		const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
		await runs.initialize();
		tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
		await tasks.initialize();
		server = createServer(
			createServePage(
				"secret-token",
				registry,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				tasks,
				undefined,
				undefined,
				new A2aAdapter(registry, tasks),
			),
		);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected an IP listener");
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await tasks.dispose();
		await rm(root, { recursive: true, force: true });
	});

	test("enforces auth, version, media type, and maps a completed task", async () => {
		const path = "/a2a/agents/researcher";
		expect((await fetch(`${origin}${path}/.well-known/agent-card.json`)).status).toBe(403);

		const card = await fetch(`${origin}${path}/.well-known/agent-card.json`, {
			headers: { authorization: "Bearer secret-token" },
		});
		expect(card.status).toBe(200);
		expect(card.headers.get("content-type")).toContain(A2A_MEDIA_TYPE);
		expect(await card.json()).toMatchObject({
			supportedInterfaces: [{ protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }],
		});

		const withoutVersion = await fetch(`${origin}${path}/message:send`, {
			method: "POST",
			headers: { authorization: "Bearer secret-token", "content-type": A2A_MEDIA_TYPE },
			body: JSON.stringify({ message: { parts: [{ text: "Find evidence" }] } }),
		});
		expect(withoutVersion.status).toBe(400);
		expect(await withoutVersion.json()).toMatchObject({ error: { details: [{ reason: "VERSION_NOT_SUPPORTED" }] } });

		const wrongMediaType = await fetch(`${origin}${path}/message:send`, {
			method: "POST",
			headers: {
				authorization: "Bearer secret-token",
				"a2a-version": "1.0",
				"content-type": "application/json",
			},
			body: JSON.stringify({ message: { parts: [{ text: "Find evidence" }] } }),
		});
		expect(wrongMediaType.status).toBe(415);

		const submitted = await fetch(`${origin}${path}/message:send`, {
			method: "POST",
			headers: {
				authorization: "Bearer secret-token",
				"a2a-version": "1.0",
				"content-type": A2A_MEDIA_TYPE,
			},
			body: JSON.stringify({ message: { parts: [{ text: "Find evidence" }] } }),
		});
		expect(submitted.status).toBe(200);
		const body = (await submitted.json()) as { task: { id: string } };
		await tasks.waitForCompletion(body.task.id);

		const completed = await fetch(`${origin}${path}/tasks/${body.task.id}`, {
			headers: { authorization: "Bearer secret-token", "a2a-version": "1.0" },
		});
		expect(completed.headers.get("content-type")).toContain(A2A_MEDIA_TYPE);
		expect(await completed.json()).toMatchObject({
			status: { state: "TASK_STATE_COMPLETED" },
			artifacts: [{ parts: [{ text: "A2A result: Find evidence" }] }],
		});
	});
});
