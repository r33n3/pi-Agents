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
	readonly context = new FixtureBrowserContext();

	async createContext(): Promise<BrowserDriverContext> {
		return this.context;
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
});
