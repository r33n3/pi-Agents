/** Isolated browser fixture: no credentials, provider calls, personal agents, or live Pi state. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMetadata } from "@earendil-works/pi-protocol";
import { PiServer } from "@earendil-works/pi-server";
import { TestServerService } from "@earendil-works/pi-server/testing";
import { AgentBuildLifecycleService } from "../../src/core/serve/agent-build-lifecycle-service.ts";
import type { AgentExecution, AgentExecutor } from "../../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../../src/core/serve/agent-run-manager.ts";
import { RunSkillPromotionService } from "../../src/core/serve/run-skill-promotion-service.ts";
import { createServePage } from "../../src/core/serve/serve-page.ts";
import { WebSocketListener } from "../../src/core/serve/websocket-listener.ts";
import { NATIVE_UI_MODELS } from "./native-ui-models.ts";

class NativeUiService extends TestServerService {
	override async listModels(): Promise<ModelMetadata[]> {
		return NATIVE_UI_MODELS;
	}
}

class SyntheticAgentExecutor implements AgentExecutor {
	start(): Promise<AgentExecution> {
		return Promise.resolve({
			result: Promise.resolve({
				output: "Synthetic proof completed without a provider request.",
				transcript: [],
			}),
			subscribe: () => () => {},
			abort: () => Promise.resolve(),
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return Promise.resolve();
	}
}

const root = await mkdtemp(join(tmpdir(), "pi-native-model-ui-"));
const port = Number(process.argv[2] ?? 4197);
const token = "synthetic-native-ui";
const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
await registry.initialize();
await registry.save({
	id: "synthetic-native",
	name: "Synthetic native reviewer",
	description: "Test-only agent for settings preservation",
	persona: "Review synthetic fixtures only",
	projectRoot: root,
	tools: [],
	memory: "none",
	executor: "harness",
	permissionPolicy: "read-only",
	schedules: [],
	model: { provider: "fixture", id: "native" },
	modelControls: { reasoningEffort: "high", processingTier: "default" },
});
const runs = new AgentRunManager(registry, new SyntheticAgentExecutor(), join(root, "runs"));
await runs.initialize();
const lifecycle = new AgentBuildLifecycleService(root, registry, runs);
await lifecycle.initialize();
await lifecycle.ensureForAgent("synthetic-native");
const promotion = new RunSkillPromotionService(runs, join(root, "skills"), lifecycle);
const service = new NativeUiService();
service.seed("session-1", "Synthetic settings test", root, { provider: "fixture", id: "native" }, "high");
const stored = service.sessions.get("session-1")!;
stored.snapshot = {
	...stored.snapshot,
	transcript: [
		{
			id: "fixture-answer",
			role: "assistant",
			status: "complete",
			stopReason: "stop",
			timestamp: 1,
			model: { provider: "fixture", id: "native" },
			content: [
				{
					type: "text",
					text: "Synthetic response only. Requested Fast; provider reported default. No API calls were made.",
				},
			],
			execution: {
				requested: { reasoningEffort: "high", processingTier: "fast" },
				sent: { reasoningEffort: "high", processingTier: "fast" },
				reported: { processingTier: "default" },
			},
			usage: {
				input: 20,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3, status: "estimated" },
			},
		},
		{
			id: "unknown-answer",
			role: "assistant",
			status: "complete",
			stopReason: "stop",
			timestamp: 2,
			model: { provider: "fixture", id: "legacy" },
			content: [{ type: "text", text: "Second synthetic response has unknown cost." }],
			usage: {
				input: 20,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, status: "unknown" },
			},
		},
	],
};
const pageOptions: Parameters<typeof createServePage> = [token, registry, runs];
pageOptions[27] = promotion;
pageOptions[28] = lifecycle;
const page = createServePage(...pageOptions);
const emptyResponses: Record<string, unknown> = {
	"/agent-conversations.json": { conversations: [] },
	"/agent-teams": { schemaVersion: "pi.agents.team-state.v1", installed: false },
	"/agent-tasks.json": { tasks: [] },
	"/attention.json": { items: [] },
	"/artifacts.json": { artifacts: [] },
	"/external-connections.json": { connections: [] },
};
const listener = new WebSocketListener({
	host: "127.0.0.1",
	port,
	token,
	onHttpRequest: (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.searchParams.get("token") === token) {
			if (request.method === "POST" && url.pathname === "/fixture-stop") {
				response.end("stopping");
				void stop();
				return;
			}
			if (request.method === "GET" && url.pathname in emptyResponses) {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(emptyResponses[url.pathname]));
				return;
			}
		}
		page(request, response);
	},
});
const server = new PiServer(service, { listeners: [listener] });
await server.start();
console.log(`Synthetic UI fixture: http://127.0.0.1:${port}/?token=${token}`);
console.log(`Disposable fixture root: ${root}`);
async function stop(): Promise<void> {
	await server.close();
	await runs.dispose();
	await rm(root, { recursive: true, force: true });
	process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise(() => {});
