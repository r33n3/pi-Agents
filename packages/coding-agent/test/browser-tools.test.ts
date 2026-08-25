import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";
import { createBrowserTools } from "../src/core/serve/browser-tools.ts";
import { BrowserWorkflowCaptureStore } from "../src/core/serve/browser-workflow-capture.ts";
import { BrowserWorkflowCompiler } from "../src/core/serve/browser-workflow-compiler.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";
import { WorkspacePreviewServer } from "../src/core/serve/workspace-preview-server.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixtureBrowserContext implements BrowserDriverContext {
	clicks: number[] = [];
	fills: Array<{ index: number; text: string }> = [];
	navigations: string[] = [];

	async setNavigationPolicy(): Promise<void> {}

	async navigate(url: string): Promise<{ url: string; title: string }> {
		this.navigations.push(url);
		return { url, title: "Fixture" };
	}

	async goBack(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/back", title: "Fixture" };
	}

	async goForward(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/forward", title: "Fixture" };
	}

	async reload(): Promise<{ url: string; title: string }> {
		return { url: "http://localhost:4173/", title: "Fixture" };
	}

	async pointerClick(): Promise<void> {}

	async typeText(): Promise<void> {}

	async scroll(): Promise<void> {}

	async snapshot(): Promise<{ url: string; title: string; elements: Array<{ role: string; name: string }> }> {
		return {
			url: "http://localhost:4173/",
			title: "Fixture",
			elements: [
				{ role: "textbox", name: "Search" },
				{ role: "button", name: "Submit" },
			],
		};
	}

	async elementAt(): Promise<{ role: string; name: string }> {
		return { role: "button", name: "Submit" };
	}

	async focusedElement(): Promise<{ role: string; name: string }> {
		return { role: "textbox", name: "Search" };
	}

	async click(index: number): Promise<void> {
		this.clicks.push(index);
	}

	async fill(index: number, text: string): Promise<void> {
		this.fills.push({ index, text });
	}

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

	async close(): Promise<void> {}
}

class FixtureBrowserDriver implements BrowserDriver {
	readonly contexts: FixtureBrowserContext[] = [];

	get context(): FixtureBrowserContext {
		const context = this.contexts[0];
		if (!context) throw new Error("Fixture browser context was not created");
		return context;
	}

	async createContext(): Promise<BrowserDriverContext> {
		const context = new FixtureBrowserContext();
		this.contexts.push(context);
		return context;
	}

	async dispose(): Promise<void> {}
}

describe("browser tools", () => {
	test("requires fresh owner-bound semantic references for page actions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		roots.push(root);
		const driver = new FixtureBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const tools = new Map(
			createBrowserTools(manager, {
				owner: { kind: "agent-run", id: "run-123" },
				workspace: { id: "project", root },
				access: "loopback",
			}).map((tool) => [tool.name, tool]),
		);
		const execute = async (name: string, parameters: Record<string, unknown>) =>
			await tools.get(name)!.execute("call", parameters, undefined, undefined, {} as never);

		await execute("browser_open", { url: "http://localhost:4173/" });
		const snapshot = await execute("browser_snapshot", {});
		expect(snapshot.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("e2\tbutton\tSubmit") });

		await execute("browser_fill", { revision: 1, ref: "e1", text: "pi" });
		expect(driver.context.fills).toEqual([{ index: 0, text: "pi" }]);
		await expect(execute("browser_click", { revision: 1, ref: "e2" })).rejects.toThrow("snapshot is stale");

		await execute("browser_snapshot", {});
		await execute("browser_click", { revision: 2, ref: "e2" });
		expect(driver.context.clicks).toEqual([1]);
		await manager.dispose();
	});

	test("serves a workspace HTML file over loopback for managed preview", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		roots.push(root);
		const htmlPath = join(root, "index.html");
		await writeFile(htmlPath, "<!doctype html><title>Local preview</title>", "utf8");
		const driver = new FixtureBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const preview = new WorkspacePreviewServer();
		const tool = createBrowserTools(manager, {
			owner: { kind: "pi-session", id: "session-123" },
			workspace: { id: "project", root },
			access: "loopback",
			workspacePreview: preview,
		})[0];
		try {
			await tool.execute("call", { url: htmlPath }, undefined, undefined, {} as never);
			const previewUrl = driver.context.navigations[0];
			expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
			expect(await (await fetch(previewUrl)).text()).toContain("Local preview");
		} finally {
			await manager.dispose();
			await preview.close();
		}
	});

	test("uses separate immutable sessions for local and public review", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		roots.push(root);
		const driver = new FixtureBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const tools = new Map(
			createBrowserTools(manager, {
				owner: { kind: "pi-session", id: "session-review" },
				workspace: { id: "project", root },
				access: ["loopback", "public-web"],
			}).map((tool) => [tool.name, tool]),
		);
		const open = async (url: string, access?: string) =>
			await tools.get("browser_open")!.execute("call", { url, access }, undefined, undefined, {} as never);

		await open("http://localhost:4173/");
		await open("https://example.com/");
		await open("http://localhost:4173/again");

		expect(manager.list({ kind: "pi-session", id: "session-review" }).map((session) => session.access)).toEqual([
			"loopback",
			"public-web",
		]);
		expect(driver.contexts).toHaveLength(2);
		expect(driver.contexts[0]?.navigations).toEqual(["http://localhost:4173/", "http://localhost:4173/again"]);
		expect(driver.contexts[1]?.navigations).toEqual(["https://example.com/"]);
		await expect(open("https://example.com/", "private-network")).rejects.toThrow("not granted");
		await manager.dispose();
	});

	test("does not let an agent exceed its configured browser access", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		roots.push(root);
		const driver = new FixtureBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const open = createBrowserTools(manager, {
			owner: { kind: "agent-run", id: "public-reviewer" },
			workspace: { id: "project", root },
			access: "public-web",
		})[0]!;

		await open.execute("call", { url: "https://example.com/" }, undefined, undefined, {} as never);
		await expect(
			open.execute("call", { url: "http://127.0.0.1:4173/" }, undefined, undefined, {} as never),
		).rejects.toThrow("loopback access");
		expect(manager.list({ kind: "agent-run", id: "public-reviewer" })).toHaveLength(1);
		await manager.dispose();
	});

	test("records new user actions and compiles a new workflow without replay", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-tools-"));
		roots.push(root);
		const captureStore = new BrowserWorkflowCaptureStore(join(root, "captures"));
		await captureStore.initialize();
		const registry = new BrowserWorkflowRegistry(join(root, "workflows"));
		await registry.initialize();
		const compiler = new BrowserWorkflowCompiler(registry);
		const driver = new FixtureBrowserDriver();
		const owner = { kind: "pi-session" as const, id: "session-record" };
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root), 4, undefined, captureStore);
		const tools = new Map(
			createBrowserTools(manager, {
				owner,
				workspace: { id: "project", root },
				access: ["loopback", "public-web"],
				workflowCompiler: compiler,
			}).map((tool) => [tool.name, tool]),
		);
		const execute = async (name: string, parameters: Record<string, unknown>) =>
			await tools.get(name)!.execute("call", parameters, undefined, undefined, {} as never);

		await execute("browser_open", { url: "http://localhost:4173/" });
		await execute("browser_record_start", {});
		const session = manager.list(owner)[0]!;
		await manager.setControl(session.id, "user");
		await manager.pointerClick(session.id, 10, 10);
		const stopped = await execute("browser_record_stop", { sessionId: session.id });
		const content = stopped.content[0];
		if (content?.type !== "text") throw new Error("Expected browser recording text result");
		const result = JSON.parse(content.text) as {
			workflowId: string;
			version: number;
			status: string;
			access: string;
			steps: Array<{ action: string }>;
		};

		expect(result).toMatchObject({ version: 1, status: "compiled", access: "loopback" });
		expect(result.workflowId).toBe("fixture");
		expect(result.steps).toEqual([{ id: "step-1", action: "click" }]);
		expect(registry.list()).toHaveLength(1);
		await manager.dispose();
	});
});
