import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import { BrowserSessionManager } from "../src/core/serve/browser-session-manager.ts";
import { BrowserWorkflowCaptureStore } from "../src/core/serve/browser-workflow-capture.ts";
import { PlaywrightBrowserDriver } from "../src/core/serve/playwright-browser-driver.ts";

describe("PlaywrightBrowserDriver", () => {
	let server: Server;
	let origin: string;
	let root: string;
	let manager: BrowserSessionManager;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-playwright-browser-"));
		server = createServer((request, response) => {
			if (request.url === "/download") {
				response
					.writeHead(200, {
						"content-type": "text/plain",
						"content-disposition": 'attachment; filename="report.txt"',
					})
					.end("report");
				return;
			}
			if (request.url === "/frame") {
				response
					.writeHead(200, { "content-type": "text/html; charset=utf-8" })
					.end("<button>Frame action</button>");
				return;
			}
			if (request.url === "/popup") {
				response
					.writeHead(200, { "content-type": "text/html; charset=utf-8" })
					.end("<!doctype html><title>Popup fixture</title><button>Popup action</button>");
				return;
			}
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(
					'<!doctype html><title>Browser fixture</title><style>#search{position:fixed;left:20px;top:20px;width:200px;height:40px}</style><input id="search" aria-label="Search"><button>Save</button><a href="/download" download>Download report</a><button onclick="window.open(\'/popup\')">Open popup</button><iframe name="fixture-frame" src="/frame"></iframe><img src="https://example.com/blocked.png" alt=""><script>console.error("fixture console")</script>',
				);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP fixture listener");
		origin = `http://127.0.0.1:${address.port}`;
		const captureStore = new BrowserWorkflowCaptureStore(join(root, "captures"));
		await captureStore.initialize();
		manager = new BrowserSessionManager(
			new PlaywrightBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			undefined,
			captureStore,
		);
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

	test("tracks semantic iframe targets, downloads, and popup pages", async () => {
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-frames" },
			workspace: { id: "fixture", root },
			access: "loopback",
		});
		await manager.navigate(session.id, origin);
		let snapshot = await manager.snapshot(session.id);
		const frameAction = snapshot.elements.find((element) => element.name === "Frame action");
		expect(frameAction?.frame).toEqual([expect.objectContaining({ name: "fixture-frame", url: `${origin}/frame` })]);
		await manager.click(session.id, snapshot.revision, frameAction!.ref);

		snapshot = await manager.snapshot(session.id);
		const download = snapshot.elements.find((element) => element.name === "Download report");
		await manager.click(session.id, snapshot.revision, download!.ref);
		await expect.poll(() => manager.downloads(session.id)).toEqual([expect.objectContaining({ name: "report.txt" })]);

		snapshot = await manager.snapshot(session.id);
		const popup = snapshot.elements.find((element) => element.name === "Open popup");
		await manager.click(session.id, snapshot.revision, popup!.ref);
		await expect.poll(async () => (await manager.snapshot(session.id)).title).toBe("Popup fixture");
	});

	test("captures semantic targets for shared-control clicks and typing", async () => {
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-recording" },
			workspace: { id: "fixture", root },
			access: "loopback",
		});
		await manager.navigate(session.id, origin);
		await manager.startCapture(session.id);
		await manager.setControl(session.id, "user");
		await manager.pointerClick(session.id, 100, 40);
		await manager.typeText(session.id, "pi browser recording");
		const capture = await manager.stopCapture(session.id);

		expect(capture.steps).toHaveLength(2);
		expect(capture.steps[0]?.action).toMatchObject({
			kind: "click",
			target: { tag: "input", name: "Search" },
		});
		expect(capture.steps[1]?.action).toMatchObject({
			kind: "type",
			target: { tag: "input", name: "Search" },
			sensitive: false,
		});
	});
});
