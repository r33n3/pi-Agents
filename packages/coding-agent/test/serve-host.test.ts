import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
});
