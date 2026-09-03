import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelControls } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentDefinition } from "../src/core/serve/agent-registry.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";

// Real worker + SDK + adapter, but only a loopback HTTP fixture. Never uses provider credentials or paid APIs.
describe("isolated agent worker native settings", () => {
	let root: string;
	let server: Server;
	let executor: ChildProcessAgentExecutor;
	let definition: AgentDefinition;
	const requests: Record<string, unknown>[] = [];
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-worker-native-controls-"));
		requests.length = 0;
		server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				requests.push(JSON.parse(body) as Record<string, unknown>);
				response.writeHead(400, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ error: { message: "synthetic request recorded", type: "invalid_request_error" } }),
				);
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
		const agentDir = join(root, "agent");
		const workspace = join(root, "workspace");
		await mkdir(agentDir);
		await mkdir(workspace);
		const evidence = { kind: "user-override", reference: "loopback fixture", checkedAt: "2026-08-31" };
		await writeFile(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						apiKey: "synthetic-only",
						models: [
							{
								id: "native",
								name: "Loopback fixture",
								api: "openai-responses",
								baseUrl: `http://127.0.0.1:${address.port}/v1`,
								reasoning: true,
								input: ["text"],
								maxTokens: 256,
								contextWindow: 32768,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								controls: {
									reasoningEffort: { values: ["low", "high"], evidence },
									processingTier: { values: ["default", "fast"], evidence },
								},
							},
						],
					},
				},
			}),
		);
		executor = new ChildProcessAgentExecutor({
			agentDir,
			serveRoot: join(root, "serve"),
			capabilityTools: () => [],
			environment: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
			timeoutMs: 20_000,
		});
		definition = {
			id: "synthetic-worker",
			name: "Synthetic worker",
			description: "Record one loopback request",
			revision: 1,
			source: "managed",
			model: { provider: "fixture", id: "native" },
			projectRoot: workspace,
			workspace,
			tools: [],
			capabilities: [],
			memory: "none",
			persona: "Test only",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			browserWorkflows: [],
			delegateAgentIds: [],
			a2a: { enabled: false },
		};
	});
	afterEach(async () => {
		await executor?.dispose();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});
	test.each([
		{ reasoningEffort: "low", processingTier: "default" },
		{ reasoningEffort: "high", processingTier: "fast" },
		{},
	] satisfies ModelControls[])(
		"forwards exact saved settings through the worker: %j",
		async (controls) => {
			definition.modelControls = controls;
			const execution = await executor.start({
				definition,
				runId: "fixture",
				workspace: definition.workspace,
				prompt: "fixture",
			});
			await expect(execution.result).rejects.toThrow("synthetic request recorded");
			expect(requests).toHaveLength(1);
			expect(requests[0].service_tier).toBe(controls.processingTier);
			expect((requests[0].reasoning as { effort?: string } | undefined)?.effort).toBe(controls.reasoningEffort);
			await execution.dispose();
		},
		30_000,
	);
	test("rejects unsupported saved controls without an HTTP request", async () => {
		definition.modelControls = { reasoningEffort: "invented" };
		const execution = await executor.start({
			definition,
			runId: "fixture",
			workspace: definition.workspace,
			prompt: "fixture",
		});
		await expect(execution.result).rejects.toThrow("Unsupported reasoningEffort");
		expect(requests).toEqual([]);
		await execution.dispose();
	}, 30_000);
});
