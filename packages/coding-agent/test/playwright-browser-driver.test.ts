import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import { BrowserSessionManager } from "../src/core/serve/browser-session-manager.ts";
import { PlaywrightBrowserDriver } from "../src/core/serve/playwright-browser-driver.ts";

describe("PlaywrightBrowserDriver", () => {
	let server: Server;
	let origin: string;
	let root: string;
	let manager: BrowserSessionManager;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-playwright-browser-"));
		server = createServer((_request, response) => {
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(
					'<!doctype html><title>Browser fixture</title><input aria-label="Search"><button>Save</button><img src="https://example.com/blocked.png" alt=""><script>console.error("fixture console")</script>',
				);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP fixture listener");
		origin = `http://127.0.0.1:${address.port}`;
		manager = new BrowserSessionManager(new PlaywrightBrowserDriver(), new BrowserProfileStore(root));
	});

	afterEach(async () => {
		await manager.dispose();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(root, { recursive: true, force: true });
	});

	test("navigates, acts semantically, captures diagnostics, and screenshots a loopback page", async () => {
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-1" },
			workspace: { id: "fixture", root },
			access: "loopback",
		});
		const navigated = await manager.navigate(session.id, origin);
		expect(navigated).toMatchObject({ status: "ready", title: "Browser fixture" });

		const snapshot = await manager.snapshot(session.id);
		expect(snapshot.elements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ref: "e1", role: "input", name: "Search" }),
				expect.objectContaining({ ref: "e2", role: "button", name: "Save" }),
			]),
		);
		await manager.fill(session.id, snapshot.revision, "e1", "pi");
		expect((await manager.screenshot(session.id)).byteLength).toBeGreaterThan(100);
		expect(manager.diagnostics(session.id).console).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "error", text: "fixture console" })]),
		);
		expect(manager.diagnostics(session.id).networkFailures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: expect.stringContaining("Blocked by browser access policy") }),
			]),
		);

		let resolveFrame: ((frame: Uint8Array) => void) | undefined;
		const frame = new Promise<Uint8Array>((resolve) => {
			resolveFrame = resolve;
		});
		const unsubscribe = await manager.subscribeFrames(session.id, (next) => resolveFrame?.(next.jpeg));
		await manager.reload(session.id);
		const jpeg = await Promise.race([
			frame,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("No screencast frame")), 5_000)),
		]);
		expect([...jpeg.subarray(0, 2)]).toEqual([255, 216]);
		await unsubscribe();
	});
});
