import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { createServePage } from "../src/core/serve/serve-page.ts";

const roots: string[] = [];
const servers: Server[] = [];
const services: AgentTaskService[] = [];

afterEach(async () => {
	await Promise.all(services.splice(0).map((service) => service.dispose()));
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => {
						if (error) reject(error);
						else resolve();
					}),
				),
		),
	);
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
		return Promise.resolve(new ImmediateExecution(`# Result\n\n${context.prompt}`));
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

describe("serve durable work and artifact routes", () => {
	test("requires authentication and serves Attention and artifact content with safe headers", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-work-http-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
		await registry.save({
			id: "reporter",
			name: "Reporter",
			description: "Creates reports",
			projectRoot: join(root, "workspace"),
			tools: ["read"],
			capabilities: [],
			memory: "none",
			persona: "Concise",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new ImmediateExecutor(), join(root, "runs"));
		await runs.initialize();
		const tasks = new AgentTaskService(registry, runs, join(root, "serve"));
		services.push(tasks);
		await tasks.initialize();
		const submitted = await tasks.submit({
			agentId: "reporter",
			prompt: "Create an authenticated report",
			source: "routine",
			expectedDeliverable: { kind: "markdown", title: "HTTP report" },
		});
		await tasks.waitForCompletion(submitted.id);

		const server = createServer(
			createServePage(
				"secret-token",
				registry,
				runs,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				tasks,
			),
		);
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const origin = `http://127.0.0.1:${address.port}`;

		expect((await fetch(`${origin}/attention.json`)).status).toBe(403);
		const attention = await fetch(`${origin}/attention.json?token=secret-token`);
		expect(attention.status).toBe(200);
		expect(await attention.json()).toMatchObject({ items: [{ taskId: submitted.id, kind: "completed" }] });

		const artifacts = await fetch(`${origin}/artifacts.json?token=secret-token`);
		expect(artifacts.status).toBe(200);
		const artifactPayload = (await artifacts.json()) as { artifacts: Array<{ id: string }> };
		const artifactId = artifactPayload.artifacts[0]!.id;
		const content = await fetch(`${origin}/artifacts/${artifactId}/content?token=secret-token`);
		expect(content.status).toBe(200);
		expect(content.headers.get("content-type")).toContain("text/markdown");
		expect(content.headers.get("x-content-type-options")).toBe("nosniff");
		expect(content.headers.get("content-disposition")).toContain("attachment");
		expect(await content.text()).toContain("Create an authenticated report");

		const preview = await fetch(`${origin}/artifacts/${artifactId}/preview?token=secret-token`);
		expect(preview.status).toBe(200);
		expect(preview.headers.get("content-security-policy")).toContain("sandbox");
	});
});
