import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserArtifactStore } from "../src/core/serve/browser-artifact-store.ts";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";

class FakeBrowserContext implements BrowserDriverContext {
	closed = false;
	navigations: string[] = [];
	pointerClicks: Array<{ x: number; y: number }> = [];

	async setNavigationPolicy(): Promise<void> {}

	async navigate(url: string): Promise<{ url: string; title: string }> {
		this.navigations.push(url);
		return { url, title: "Fixture page" };
	}

	async goBack(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/back", title: "Fixture page" };
	}

	async goForward(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/forward", title: "Fixture page" };
	}

	async reload(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/", title: "Fixture page" };
	}

	async pointerClick(x: number, y: number): Promise<void> {
		this.pointerClicks.push({ x, y });
	}

	async typeText(): Promise<void> {}

	async scroll(): Promise<void> {}

	async snapshot(): Promise<{ url: string; title: string; elements: Array<{ role: string; name: string }> }> {
		return { url: "http://localhost:4173/", title: "Fixture page", elements: [{ role: "button", name: "Save" }] };
	}

	async click(): Promise<void> {}

	async fill(): Promise<void> {}

	async press(): Promise<void> {}

	async screenshot(): Promise<Uint8Array> {
		return new Uint8Array([137, 80, 78, 71]);
	}

	async subscribeFrames(): Promise<() => Promise<void>> {
		return async () => {};
	}

	diagnostics() {
		return { console: [], networkFailures: [] };
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeBrowserDriver implements BrowserDriver {
	readonly contexts: FakeBrowserContext[] = [];
	disposed = false;

	async createContext(): Promise<BrowserDriverContext> {
		const context = new FakeBrowserContext();
		this.contexts.push(context);
		return context;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

describe("BrowserSessionManager", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	test("keeps browser state bound to its explicit owner workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));

		const session = await manager.create({
			owner: { kind: "agent-run", id: "run-123" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		expect(session.workspace).toEqual({ id: "project-main", root });
		expect(manager.list({ kind: "agent-run", id: "run-123" })).toHaveLength(1);

		const navigated = await manager.navigate(session.id, "http://localhost:4173/");
		expect(navigated).toMatchObject({ status: "ready", url: "http://localhost:4173/", title: "Fixture page" });
		expect(driver.contexts[0]?.navigations).toEqual(["http://localhost:4173/"]);

		await manager.closeOwner({ kind: "agent-run", id: "run-123" });
		expect(driver.contexts[0]?.closed).toBe(true);
		await manager.dispose();
		expect(driver.disposed).toBe(true);
	});

	test("rejects navigation outside the session policy", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(new FakeBrowserDriver(), new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-123" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});

		await expect(manager.navigate(session.id, "https://example.com/")).rejects.toThrow("does not allow");
		await manager.dispose();
	});

	test("releases a session slot after close", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(new FakeBrowserDriver(), new BrowserProfileStore(root), 1);
		const input = {
			owner: { kind: "pi-session" as const, id: "session-123" },
			workspace: { id: "project-main", root },
			access: "loopback" as const,
		};
		const first = await manager.create(input);
		await expect(manager.create(input)).rejects.toThrow("limit reached");

		await manager.close(first.id);
		await expect(manager.create(input)).resolves.toMatchObject({ status: "ready" });
		await manager.dispose();
	});

	test("pauses agent mutations while a user controls the browser", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-123" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		await manager.navigate(session.id, "http://localhost:4173/first");
		await manager.navigate(session.id, "http://localhost:4173/second");
		expect(manager.get(session.id)).toMatchObject({ canGoBack: true, canGoForward: false, controlOwner: "agent" });

		manager.setControl(session.id, "user");
		await expect(manager.navigate(session.id, "http://localhost:4173/blocked")).rejects.toThrow("controlled by user");
		await manager.pointerClick(session.id, 100, 120);
		expect(driver.contexts[0]?.pointerClicks).toEqual([{ x: 100, y: 120 }]);
		await manager.goBack(session.id, "user");
		expect(manager.get(session.id)).toMatchObject({ canGoBack: false, canGoForward: true });

		manager.setControl(session.id, "agent");
		await manager.goForward(session.id);
		expect(manager.get(session.id)).toMatchObject({ canGoForward: false, controlOwner: "agent" });
		await manager.dispose();
	});

	test("persists explicit screenshots for delegated runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(
			new FakeBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			new BrowserArtifactStore(root),
		);
		const session = await manager.create({
			owner: { kind: "agent-run", id: "run-123" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const captured = await manager.captureScreenshotArtifact(session.id);
		expect(captured.artifact).toMatchObject({ owner: { kind: "agent-run", id: "run-123" }, kind: "screenshot" });
		expect(await manager.listArtifacts(session.id)).toHaveLength(1);
		await manager.dispose();
	});
});
