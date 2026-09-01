import type { Model } from "@earendil-works/pi-ai";
import { PiClient } from "@earendil-works/pi-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBrowserWebSocketTransport } from "../src/core/serve/browser/websocket-transport.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("saved-agent browser helper settings", () => {
	let harness: Harness;
	let host: ServeHost;
	let client: PiClient;
	let agentUrl: URL;
	let model: Model<"openai-responses">;
	beforeEach(async () => {
		harness = await createHarness();
		const evidence = { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" } as const;
		model = {
			...harness.getModel(),
			api: "openai-responses",
			reasoning: true,
			controls: {
				reasoningEffort: { values: ["low", "high"], evidence },
				processingTier: { values: ["default", "fast"], evidence },
			},
		};
		const alternate = { ...model, id: "alternate", controls: {} };
		vi.spyOn(harness.session.modelRuntime, "getModel").mockImplementation((provider, id) =>
			provider === model.provider
				? id === model.id
					? model
					: id === alternate.id
						? alternate
						: undefined
				: undefined,
		);
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([model, alternate]);
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
		const served = await host.start();
		agentUrl = new URL(served.url);
		agentUrl.pathname = "/agents";
		const response = await fetch(agentUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "synthetic-native",
				name: "Synthetic native",
				description: "No prompts or paid calls",
				persona: "Fixture",
				projectRoot: harness.tempDir,
				tools: [],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
				model: { provider: model.provider, id: model.id },
				modelControls: { reasoningEffort: "high", processingTier: "default" },
			}),
		});
		expect(response.status, await response.text()).toBe(201);
		const socket = new URL(served.url);
		socket.protocol = "ws:";
		socket.pathname = "/pi";
		client = await PiClient.connect({ transportFactory: createBrowserWebSocketTransport(socket.href) });
	});
	afterEach(async () => {
		await client?.dispose();
		await host?.close();
		vi.restoreAllMocks();
		harness.cleanup();
	});
	test("inherits saved settings and honors explicit defaults or a legacy replacement without editing the package", async () => {
		const inherited = await client.createSession({ name: "agent:synthetic-native" });
		expect(inherited.snapshot!.modelControls).toEqual({ reasoningEffort: "high", processingTier: "default" });
		const defaults = await client.createSession({ name: "agent:synthetic-native", modelControls: {} });
		expect(defaults.snapshot!.modelControls).toEqual({});
		const legacy = await client.createSession({ name: "agent:synthetic-native", thinkingLevel: "low" });
		expect(legacy.snapshot!.modelControls).toBeUndefined();
		expect(legacy.snapshot!.thinkingLevel).toBe("low");
		const cleared = await client.createSession({ name: "agent:synthetic-native", modelControls: null });
		expect(cleared.snapshot!.modelControls).toBeUndefined();
		agentUrl.pathname = "/agents/synthetic-native";
		const response = await fetch(agentUrl);
		expect(await response.json()).toMatchObject({
			revision: 1,
			modelControls: { reasoningEffort: "high", processingTier: "default" },
		});
	});
	test("rejects incompatible helper creation and accepts an explicit atomic model/settings replacement", async () => {
		const sessionsBefore = await client.listSessions();
		await expect(
			client.createSession({ name: "agent:synthetic-native", model: { provider: model.provider, id: "alternate" } }),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(await client.listSessions()).toHaveLength(sessionsBefore.length);
		const replaced = await client.createSession({
			name: "agent:synthetic-native",
			model: { provider: model.provider, id: "alternate" },
			modelControls: {},
		});
		expect(replaced.snapshot).toMatchObject({
			model: { provider: model.provider, id: "alternate" },
			modelControls: {},
		});
	});
});
