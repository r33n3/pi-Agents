import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserArtifactStore } from "../src/core/serve/browser-artifact-store.ts";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	type BrowserRuntimeKind,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";
import { BrowserWorkflowCaptureStore } from "../src/core/serve/browser-workflow-capture.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";

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

	async elementAt(): Promise<{ role: string; name: string }> {
		return { role: "button", name: "Save" };
	}

	async focusedElement(): Promise<{ role: string; name: string }> {
		return { role: "textbox", name: "Name" };
	}

	async click(): Promise<void> {}

	async fill(): Promise<void> {}
	async select(): Promise<void> {}
	async scrollIntoView(): Promise<void> {}

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
	downloads() {
		return [];
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeBrowserDriver implements BrowserDriver {
	readonly contexts: FakeBrowserContext[] = [];
	readonly runtimes: BrowserRuntimeKind[] = [];
	disposed = false;

	async createContext(input: { runtime: BrowserRuntimeKind }): Promise<BrowserDriverContext> {
		const context = new FakeBrowserContext();
		this.contexts.push(context);
		this.runtimes.push(input.runtime);
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

	test("binds each session to the selected browser runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "agent-run", id: "chrome-run" },
			workspace: { id: "project-main", root },
			access: "loopback",
			runtime: "installed-chrome",
		});
		expect(session.runtime).toBe("installed-chrome");
		expect(driver.runtimes).toEqual(["installed-chrome"]);
		await manager.dispose();
	});

	test("interrupts an active recording when its browser session closes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const captureStore = new BrowserWorkflowCaptureStore(join(root, "captures"));
		await captureStore.initialize();
		const manager = new BrowserSessionManager(
			new FakeBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			undefined,
			captureStore,
		);
		const session = await manager.create({
			owner: { kind: "pi-session", id: "capture-close" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const capture = await manager.startCapture(session.id);
		await manager.close(session.id);
		expect(captureStore.get(capture.id)?.status).toBe("interrupted");
		await manager.dispose();
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

	test("leases named profiles to one live session and releases the lease on close", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(new FakeBrowserDriver(), new BrowserProfileStore(root));
		const input = {
			owner: { kind: "pi-session" as const, id: "session-123" },
			workspace: { id: "project-main", root },
			access: "loopback" as const,
			profile: { kind: "named" as const, id: "signed-in" },
		};
		const first = await manager.create(input);
		await expect(manager.create(input)).rejects.toThrow("already in use");

		await manager.close(first.id);
		await expect(manager.create(input)).resolves.toMatchObject({ profile: { kind: "named", id: "signed-in" } });
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

		await manager.setControl(session.id, "user");
		await expect(manager.navigate(session.id, "http://localhost:4173/blocked")).rejects.toThrow("controlled by user");
		await manager.pointerClick(session.id, 100, 120);
		expect(driver.contexts[0]?.pointerClicks).toEqual([{ x: 100, y: 120 }]);
		await manager.goBack(session.id, "user");
		expect(manager.get(session.id)).toMatchObject({ canGoBack: false, canGoForward: true });
		const userSnapshot = await manager.snapshot(session.id);

		await manager.setControl(session.id, "agent");
		await expect(manager.goForward(session.id)).rejects.toThrow("request a fresh snapshot");
		await expect(manager.press(session.id, "Enter")).rejects.toThrow("request a fresh snapshot");
		await expect(manager.click(session.id, userSnapshot.revision, "e1")).rejects.toThrow("request a fresh snapshot");
		await manager.snapshot(session.id);
		await manager.goForward(session.id);
		expect(manager.get(session.id)).toMatchObject({ canGoForward: false, controlOwner: "agent" });
		await manager.dispose();
	});

	test("serializes takeover behind an active mutation and refuses later agent actions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		let releaseNavigation: (() => void) | undefined;
		let navigationStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			navigationStarted = resolve;
		});
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-race" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const context = driver.contexts[0]!;
		context.navigate = async (url) => {
			navigationStarted?.();
			await new Promise<void>((resolve) => {
				releaseNavigation = resolve;
			});
			return { url, title: "Fixture page" };
		};

		const navigation = manager.navigate(session.id, "http://localhost:4173/slow");
		await started;
		const takeover = manager.setControl(session.id, "user");
		const staleAgentAction = manager.navigate(session.id, "http://localhost:4173/stale");
		releaseNavigation?.();

		await expect(navigation).resolves.toMatchObject({ url: "http://localhost:4173/slow" });
		await expect(takeover).resolves.toMatchObject({ controlOwner: "user" });
		await expect(staleAgentAction).rejects.toThrow("controlled by user");
		await manager.dispose();
	});

	test("invalidates semantic snapshots before driver mutations that fail", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-stale" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const first = await manager.snapshot(session.id);
		const context = driver.contexts[0]!;
		context.click = async () => {
			throw new Error("click failed after dispatch");
		};
		await expect(manager.click(session.id, first.revision, "e1")).rejects.toThrow("click failed after dispatch");
		await expect(manager.click(session.id, first.revision, "e1")).rejects.toThrow("snapshot is stale");

		const second = await manager.snapshot(session.id);
		context.navigate = async () => {
			throw new Error("navigation failed after dispatch");
		};
		await expect(manager.navigate(session.id, "http://localhost:4173/failed")).rejects.toThrow(
			"navigation failed after dispatch",
		);
		await expect(manager.click(session.id, second.revision, "e1")).rejects.toThrow("snapshot is stale");

		const third = await manager.snapshot(session.id);
		context.snapshot = async () => {
			throw new Error("snapshot failed");
		};
		await expect(manager.snapshot(session.id)).rejects.toThrow("snapshot failed");
		await expect(manager.click(session.id, third.revision, "e1")).rejects.toThrow("snapshot is stale");
		await manager.dispose();
	});

	test("keeps semantic snapshot revisions monotonic after keyboard mutations", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(new FakeBrowserDriver(), new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "session-revisions" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const first = await manager.snapshot(session.id);
		await manager.press(session.id, "Enter");
		const second = await manager.snapshot(session.id);
		expect(second.revision).toBe(first.revision + 1);
		await expect(manager.click(session.id, first.revision, "e1")).rejects.toThrow("snapshot is stale");
		await manager.dispose();
	});

	test("orders capture start and stop with browser mutations", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const captureStore = new BrowserWorkflowCaptureStore(join(root, "captures"));
		await captureStore.initialize();
		const manager = new BrowserSessionManager(
			new FakeBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			undefined,
			captureStore,
		);
		const session = await manager.create({
			owner: { kind: "pi-session", id: "capture-order" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		await manager.startCapture(session.id);
		const navigation = manager.navigate(session.id, "http://localhost:4173/recorded");
		const stopped = manager.stopCapture(session.id);
		await navigation;
		expect((await stopped).steps.map((step) => step.action.kind)).toEqual(["navigate"]);

		await manager.startCapture(session.id);
		const stoppedBeforeNavigation = manager.stopCapture(session.id);
		const laterNavigation = manager.navigate(session.id, "http://localhost:4173/not-recorded");
		expect((await stoppedBeforeNavigation).steps).toEqual([]);
		await laterNavigation;
		await manager.dispose();
	});

	test("does not start a capture after session close has been queued", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const captureStore = new BrowserWorkflowCaptureStore(join(root, "captures"));
		await captureStore.initialize();
		const manager = new BrowserSessionManager(
			new FakeBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			undefined,
			captureStore,
		);
		const session = await manager.create({
			owner: { kind: "pi-session", id: "capture-close-race" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const closing = manager.close(session.id);
		const starting = manager.startCapture(session.id);
		await closing;
		await expect(starting).rejects.toThrow("is closed");
		expect(manager.getCapture(session.id)).toBeUndefined();
		await manager.dispose();
	});

	test("releases named profiles and invalidates observations when context close fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const input = {
			owner: { kind: "pi-session" as const, id: "close-failure" },
			workspace: { id: "project-main", root },
			access: "loopback" as const,
			profile: { kind: "named" as const, id: "signed-in" },
		};
		const session = await manager.create(input);
		await manager.snapshot(session.id);
		driver.contexts[0]!.close = async () => {
			throw new Error("context close failed");
		};
		await expect(manager.close(session.id)).rejects.toThrow("context close failed");
		await expect(manager.snapshot(session.id)).rejects.toThrow("is closed");
		await expect(manager.screenshot(session.id)).rejects.toThrow("is closed");
		await expect(manager.subscribeFrames(session.id, () => {})).rejects.toThrow("is closed");
		await expect(manager.create(input)).resolves.toMatchObject({ profile: { kind: "named", id: "signed-in" } });
		await expect(manager.dispose()).rejects.toThrow("context close failed");
	});

	test("serializes screenshots before close", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		let releaseScreenshot: (() => void) | undefined;
		let screenshotStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			screenshotStarted = resolve;
		});
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const session = await manager.create({
			owner: { kind: "pi-session", id: "screenshot-close" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		const context = driver.contexts[0]!;
		context.screenshot = async () => {
			screenshotStarted?.();
			await new Promise<void>((resolve) => {
				releaseScreenshot = resolve;
			});
			return new Uint8Array([137, 80, 78, 71]);
		};
		const screenshot = manager.screenshot(session.id);
		await started;
		const closing = manager.close(session.id);
		expect(context.closed).toBe(false);
		releaseScreenshot?.();
		await expect(screenshot).resolves.toEqual(new Uint8Array([137, 80, 78, 71]));
		await closing;
		expect(context.closed).toBe(true);
		await manager.dispose();
	});

	test("does not publish a session when dispose races context creation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		let releaseCreate: (() => void) | undefined;
		let createStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			createStarted = resolve;
		});
		const driver = new FakeBrowserDriver();
		driver.createContext = async (input) => {
			createStarted?.();
			await new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			const context = new FakeBrowserContext();
			driver.contexts.push(context);
			driver.runtimes.push(input.runtime);
			return context;
		};
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const creating = manager.create({
			owner: { kind: "pi-session", id: "create-dispose" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		await started;
		const disposing = manager.dispose();
		releaseCreate?.();
		await expect(creating).rejects.toThrow("disposed");
		await disposing;
		expect(driver.contexts[0]?.closed).toBe(true);
		expect(driver.disposed).toBe(true);
		expect(manager.list()).toEqual([]);
	});

	test("applies the session limit to concurrent creates", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const manager = new BrowserSessionManager(new FakeBrowserDriver(), new BrowserProfileStore(root), 1);
		const input = {
			owner: { kind: "pi-session" as const, id: "concurrent-create" },
			workspace: { id: "project-main", root },
			access: "loopback" as const,
		};
		const results = await Promise.allSettled([manager.create(input), manager.create(input)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		await manager.dispose();
	});

	test("persists denied navigation without calling the browser driver", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const audit = new ServeAuditStore(join(root, "audit"));
		await audit.initialize();
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(
			driver,
			new BrowserProfileStore(root),
			4,
			undefined,
			undefined,
			new GovernedActionService(audit),
		);
		const session = await manager.create({
			owner: { kind: "pi-session", id: "governed-denied" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		await expect(manager.navigate(session.id, "https://example.com/?token=private#secret-fragment")).rejects.toThrow(
			"does not allow",
		);
		expect(driver.contexts[0]?.navigations).toEqual([]);
		const events = await audit.read();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "decision",
			decision: "deny",
			action: {
				family: "browser.navigate",
				target: { actor: "agent", url: "https://example.com/?token=redacted" },
			},
		});
		expect(JSON.stringify(events)).not.toContain("private");
		expect(JSON.stringify(events)).not.toContain("secret-fragment");
		await manager.dispose();
	});

	test("persists an allowed decision before driver dispatch and records its outcome", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const audit = new ServeAuditStore(join(root, "audit"));
		await audit.initialize();
		const driver = new FakeBrowserDriver();
		const manager = new BrowserSessionManager(
			driver,
			new BrowserProfileStore(root),
			4,
			undefined,
			undefined,
			new GovernedActionService(audit),
		);
		const session = await manager.create({
			owner: { kind: "agent-run", id: "governed-allowed" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		let decisionWasDurableBeforeDispatch = false;
		driver.contexts[0]!.navigate = async (url) => {
			decisionWasDurableBeforeDispatch = (await audit.read()).some(
				(event) =>
					event.kind === "decision" && event.decision === "allow" && event.action.family === "browser.navigate",
			);
			return { url, title: "Fixture page" };
		};
		await manager.navigate(session.id, "http://127.0.0.1:4173/path");
		expect(decisionWasDurableBeforeDispatch).toBe(true);
		const events = await audit.read();
		expect(events.map((event) => event.kind)).toEqual(["decision", "outcome"]);
		expect(events[0]).toMatchObject({
			kind: "decision",
			decision: "allow",
			identities: { actorId: "agent", agentId: "governed-allowed", sessionId: session.id },
			action: { family: "browser.navigate", target: { url: "http://127.0.0.1:4173/path" } },
		});
		expect(events[1]).toMatchObject({ kind: "outcome", outcome: "succeeded" });
		expect(events[1]?.correlationId).toBe(events[0]?.correlationId);
		await manager.dispose();
	});

	test("persists takeover and handback decisions and outcomes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-manager-"));
		roots.push(root);
		const audit = new ServeAuditStore(join(root, "audit"));
		await audit.initialize();
		const manager = new BrowserSessionManager(
			new FakeBrowserDriver(),
			new BrowserProfileStore(root),
			4,
			undefined,
			undefined,
			new GovernedActionService(audit),
		);
		const session = await manager.create({
			owner: { kind: "pi-session", id: "governed-control" },
			workspace: { id: "project-main", root },
			access: "loopback",
		});
		await manager.setControl(session.id, "user");
		await manager.setControl(session.id, "agent");
		const events = await audit.read();
		expect(events.map((event) => [event.kind, "decision" in event ? event.decision : event.outcome])).toEqual([
			["decision", "allow"],
			["outcome", "succeeded"],
			["decision", "allow"],
			["outcome", "succeeded"],
		]);
		expect(events.filter((event) => event.kind === "decision").map((event) => event.action)).toMatchObject([
			{ family: "browser.set-control", target: { actor: "user", controlOwner: "user" } },
			{ family: "browser.set-control", target: { actor: "user", controlOwner: "agent" } },
		]);
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
