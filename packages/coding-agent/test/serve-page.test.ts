import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { ExternalConnectionManager } from "../src/core/serve/external-connection-manager.ts";
import { createServePage } from "../src/core/serve/serve-page.ts";

describe("createServePage", () => {
	let server: Server;
	let origin: string;
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-serve-page-"));
		const registry = new AgentRegistry(root);
		await registry.initialize();
		const externalConnections = new ExternalConnectionManager(
			[
				{
					id: "openai",
					name: "OpenAI Agent",
					description: "Separate SDK agent",
					inputLabel: "Task",
					available: true,
					defaultModel: { provider: "openai", id: "gpt-5.6-luna" },
					models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
				},
			],
			() => Promise.reject(new Error("not used")),
			join(root, "external-runs"),
			root,
		);
		await externalConnections.initialize();
		server = createServer(createServePage("secret-token", registry, undefined, undefined, externalConnections));
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
		await rm(root, { recursive: true, force: true });
	});

	test("rejects missing and incorrect capability tokens", async () => {
		expect((await fetch(origin)).status).toBe(403);
		expect((await fetch(`${origin}/?token=wrong`)).status).toBe(403);
	});

	test("serves the console and browser bundle to an authorized caller", async () => {
		const page = await fetch(`${origin}/?token=secret-token`);
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("no-store");
		expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
		expect(page.headers.get("content-security-policy")).toContain("connect-src 'self' ws: wss:");
		const html = await page.text();
		expect(html).toContain('data-rail-tab="sessions"');
		expect(html).toContain('id="connection-form"');
		expect(html).toContain('class="pi-watermark"');
		expect(html).toContain('id="left-resizer"');
		expect(html).toContain('id="composer-action"');
		expect(html).toContain('data-builder-tab="builder-chat-panel"');
		expect(html).toContain('id="external-connection-list"');
		expect(html).toContain('id="external-run-form"');
		expect(html).not.toContain('class="brand"');

		const bundle = await fetch(`${origin}/browser-client.js?token=secret-token`);
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("content-type")).toContain("text/javascript");
		expect((await bundle.text()).length).toBeGreaterThan(1000);
	});

	test("lists external connections", async () => {
		const response = await fetch(`${origin}/external-connections.json?token=secret-token`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			connections: [{ id: "openai", defaultModel: { provider: "openai", id: "gpt-5.6-luna" } }],
		});
	});

	test("rejects writes and unknown paths", async () => {
		expect((await fetch(`${origin}/?token=secret-token`, { method: "POST" })).status).toBe(405);
		expect((await fetch(`${origin}/missing?token=secret-token`)).status).toBe(404);
	});

	test("creates and lists validated agent definitions", async () => {
		const created = await fetch(`${origin}/agents?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Research Agent",
				description: "Researches a question",
				tools: ["read"],
				memory: "notes",
				persona: "Careful",
				executor: "harness",
				permissionPolicy: "workspace-write",
				schedules: [],
			}),
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({ id: "research-agent" });

		const listed = await fetch(`${origin}/agents.json?token=secret-token`);
		expect(await listed.json()).toMatchObject({ agents: [{ id: "research-agent" }] });
	});
});
