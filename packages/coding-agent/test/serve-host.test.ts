import { existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import * as publicWeb from "../src/core/serve/public-web-fetch.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("ServeHost", () => {
	let harness: Harness;
	let host: ServeHost | undefined;

	beforeEach(async () => {
		harness = await createHarness();
	});

	afterEach(async () => {
		await host?.close();
		harness.cleanup();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	test("owns listener startup and idempotent shutdown", async () => {
		host = new ServeHost({
			agentDir: harness.tempDir,
			session: harness.session,
			host: "127.0.0.1",
			port: 0,
		});

		const result = await host.start();
		const url = new URL(result.url);
		expect(result.port).toBeGreaterThan(0);
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.port).toBe(String(result.port));
		expect(url.searchParams.get("token")).toBeTruthy();
		expect(result.diagnostics).toEqual([{ type: "info", message: `Pi web control: ${result.url}` }]);

		const response = await fetch(result.url);
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("<!doctype html>");
		expect(harness.session.getActiveToolNames()).toContain("browser_open");
		expect(harness.session.getActiveToolNames()).toContain("browser_record_start");
		expect(harness.session.getActiveToolNames()).toContain("browser_record_stop");

		await host.close();
		await expect(host.close()).resolves.toBeUndefined();
		await expect(fetch(result.url, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
	});

	test("rejects a second start attempt", async () => {
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0 });
		await host.start();

		await expect(host.start()).rejects.toThrow("Serve host has already been started");
	});
	test("chat registers a validated tool and publishes it to the team catalog without assigning it", async () => {
		vi.spyOn(publicWeb, "fetchPublicText").mockResolvedValue({
			url: "https://example.com/fares",
			contentType: "text/plain",
			text: "Fare: 123 USD",
			fetchedAt: "2026-09-08T12:00:00Z",
		});
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0 });
		const { url } = await host.start();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("data_tools", {
					action: "register",
					recipe: {
						id: "fare",
						name: "Published fare",
						description: "Extract a published fare",
						source: "page_read",
						defaults: { url: "https://example.com/fares" },
						inputs: [],
						recordsPointer: "",
						fields: [{ name: "price", pointer: "/text", prefix: "Fare: ", suffix: " USD", type: "number" }],
						minRecords: 1,
						maxRecords: 1,
					},
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("data_tools", { action: "run", tool: "saved_data_fare_v1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Saved and tested the reusable fare reader."),
		]);
		await harness.session.prompt("Create a reusable reader for the published fare and test it.");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(2);
		expect(results.every((message) => !message.isError)).toBe(true);
		expect(JSON.stringify(results)).toContain("123");
		const endpoint = new URL(url);
		endpoint.pathname = "/agent-rooms.json";
		const catalog = (await (await fetch(endpoint)).json()) as { tools: Array<{ id: string }> };
		expect(catalog.tools).toContainEqual(expect.objectContaining({ id: "saved_data_fare_v1" }));
		expect(catalog.tools).toContainEqual(expect.objectContaining({ id: "data_tools" }));
	});

	test("reuses shared account grants in the team catalog without moving agent work or copying connections", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "fixture-client");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "fixture-secret");
		const settingsDir = join(harness.tempDir, "shared-settings");
		const connections = new CapabilityConnectionRegistry(join(settingsDir, "serve", "capabilities", "connections"));
		await connections.save({
			id: "google-workspace-primary",
			providerId: "google-workspace",
			accountLabel: "Existing account",
			secretRef: "managed:google-workspace",
			scopes: ["https://www.googleapis.com/auth/gmail.compose"],
			capabilityIds: ["email.draft"],
			status: "active",
		});
		const broker = new CapabilityBroker(join(settingsDir, "serve", "capabilities"), {
			activeToolNames: () => ["google_workspace_email_draft"],
			providerConnectionAvailable: () => true,
			connectionResolver: (id) => connections.find(id),
			environmentValue: (name) => process.env[name],
		});
		await broker.initialize();
		await broker.reviewProvider("google-workspace", true);
		await broker.enableProvider("google-workspace", true);
		host = new ServeHost({
			agentDir: harness.tempDir,
			capabilitySettingsDir: settingsDir,
			session: harness.session,
			port: 0,
		});
		const { url } = await host.start();
		const endpoint = new URL(url);
		endpoint.pathname = "/agent-rooms.json";
		const response = await fetch(endpoint);
		expect(response.status).toBe(200);
		const catalog = (await response.json()) as { tools: Array<{ id: string; name: string }> };
		expect(catalog.tools).toContainEqual(
			expect.objectContaining({
				id: "google-workspace:email.draft:google-workspace-primary",
				name: expect.stringContaining("Existing account"),
			}),
		);
		expect(catalog.tools.some((tool) => tool.id.includes("email.send"))).toBe(false);
		expect(existsSync(join(harness.tempDir, "serve", "capabilities", "connections"))).toBe(false);
		expect(existsSync(join(harness.tempDir, "serve", "rooms"))).toBe(true);
		const contender = new ServeHost({
			agentDir: join(harness.tempDir, "other-work"),
			capabilitySettingsDir: settingsDir,
			session: harness.session,
			port: 0,
		});
		await expect(contender.start()).rejects.toThrow("is already owned by another Pi serve host");
		expect((await fetch(url)).status).toBe(200);
	});

	test("dispatches Hermes directly with exact arguments and no host inference", async () => {
		const calls: unknown[] = [];
		const tool: ToolDefinition = {
			name: "hermes_agent",
			label: "Hermes",
			description: "Synthetic local backend",
			parameters: Type.Object({ goal: Type.String(), cwd: Type.String(), model: Type.String() }),
			async execute(_id, parameters) {
				calls.push(parameters);
				return { content: [{ type: "text", text: "Direct backend result" }], details: {} };
			},
		};
		harness.session.registerCustomTools([tool]);
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0 });
		const { url } = await host.start();
		const endpoint = new URL("/external-runs", url);
		endpoint.search = new URL(url).search;
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				connectionId: "hermes",
				prompt: "Return this goal unchanged",
				cwd: harness.tempDir,
				model: { provider: "custom", id: "qwen3.6:latest" },
			}),
		});
		expect(response.status).toBe(202);
		const run = (await response.json()) as { id: string };
		endpoint.pathname = `/external-runs/${run.id}/result`;
		await expect.poll(async () => (await fetch(endpoint)).status).toBe(200);
		expect(await (await fetch(endpoint)).text()).toContain("Direct backend result");
		expect(calls).toEqual([
			{ goal: "Return this goal unchanged", cwd: harness.tempDir, model: "custom/qwen3.6:latest" },
		]);
		expect(harness.session.messages).toEqual([]);
	});

	test("excludes another host from the same serve directory without disturbing the owner", async () => {
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0 });
		const first = await host.start();
		const contender = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0 });

		await expect(contender.start()).rejects.toThrow("is already owned by another Pi serve host");
		expect((await fetch(first.url)).status).toBe(200);
	});

	test("uses and validates a caller-supplied serve token", async () => {
		const token = "stable_background_serve_token_1234567890";
		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0, token });
		const result = await host.start();
		expect(new URL(result.url).searchParams.get("token")).toBe(token);
		await host.close();

		host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, port: 0, token: "short" });
		await expect(host.start()).rejects.toThrow("PI_SERVE_TOKEN must be 32-128 URL-safe characters");
	});
});
