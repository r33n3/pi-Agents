import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
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
