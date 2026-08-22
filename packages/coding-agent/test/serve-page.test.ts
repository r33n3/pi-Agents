import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoutineScheduler } from "../src/core/serve/agent-routine-scheduler.ts";
import { BrowserConsoleService } from "../src/core/serve/browser-console-service.ts";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";
import { ExternalConnectionManager } from "../src/core/serve/external-connection-manager.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";
import { ServeAttachmentStore } from "../src/core/serve/serve-attachment-store.ts";
import { createServePage } from "../src/core/serve/serve-page.ts";

describe("createServePage", () => {
	let server: Server;
	let origin: string;
	let root: string;
	let attachmentStore: ServeAttachmentStore;
	let browser: BrowserSessionManager;

	class BrowserContext implements BrowserDriverContext {
		async setNavigationPolicy(): Promise<void> {}

		async navigate(url: string): Promise<{ url: string; title: string }> {
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
			return { url: "http://localhost:4173/", title: "Fixture", elements: [] };
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

		async close(): Promise<void> {}
	}

	class FixtureBrowserDriver implements BrowserDriver {
		async createContext(): Promise<BrowserDriverContext> {
			return new BrowserContext();
		}

		async dispose(): Promise<void> {}
	}

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
		const routines = new RoutineRegistry(join(root, "routines"));
		const routineScheduler = new AgentRoutineScheduler(routines, {
			start: (definition) =>
				Promise.resolve({
					runId: `run-${definition.id}`,
					completion: Promise.resolve({}),
					cancel: () => Promise.resolve(),
				}),
		});
		await routineScheduler.refresh();
		attachmentStore = new ServeAttachmentStore();
		browser = new BrowserSessionManager(new FixtureBrowserDriver(), new BrowserProfileStore(root));
		server = createServer(
			createServePage(
				"secret-token",
				registry,
				undefined,
				routineScheduler,
				externalConnections,
				routines,
				undefined,
				attachmentStore,
				undefined,
				new BrowserConsoleService(browser, () => ({ installed: false, executablePath: "managed-chromium" })),
			),
		);
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
		await attachmentStore.dispose();
		await browser.dispose();
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
		expect(page.headers.get("content-security-policy")).toContain("img-src 'self' data: blob:");
		const html = await page.text();
		expect(html).toContain('id="sessions"');
		expect(html).toContain('id="connection-form"');
		expect(html).toContain('class="pi-watermark"');
		expect(html).toContain('id="left-resizer"');
		expect(html).toContain('id="composer-action"');
		expect(html).toContain('id="session-path"');
		expect(html).toContain('id="session-stats"');
		expect(html).toContain(".thinking-activity");
		expect(html).toContain('id="attachment-button"');
		expect(html).toContain('data-tab="browser"');
		expect(html).toContain('data-tab="agents-workspace"');
		expect(html).toContain('data-tab="agent-builder"');
		expect(html).toContain('data-builder-tab="builder-chat-panel"');
		expect(html).toContain('id="external-connection-list"');
		expect(html).toContain('id="external-run-form"');
		expect(html).not.toContain('id="preview-type-form"');
		expect(html).not.toContain('class="brand"');

		const bundle = await fetch(`${origin}/browser-client.js?token=secret-token`);
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("content-type")).toContain("text/javascript");
		const bundleText = await bundle.text();
		expect(bundleText.length).toBeGreaterThan(1000);
		expect(bundleText).toContain("tool-activity-summary");
		expect(bundleText).toContain("tool-activity-state");
		expect(bundleText).toContain("browser-session-tabs");
		expect(bundleText).toContain("Active browsers");
		expect(bundleText).toContain("browserPopout");
		expect(bundleText).toContain("Pop out browser");
		expect(bundleText).not.toContain("No active browser");
		expect(bundleText).not.toContain("Record a walkthrough, then send it to Pi for review.");
		expect(bundleText).not.toContain("Ask Pi or an agent to open a permitted URL.");
		expect(bundleText).not.toContain("Could not load browser diagnostics");
		expect(bundleText).toContain("Send to Pi");
	});

	test("uploads, previews, renames, and removes attachments", async () => {
		const uploaded = await fetch(`${origin}/attachments?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: "session-1",
				name: "notes.txt",
				mimeType: "text/plain",
				data: Buffer.from("hello").toString("base64"),
			}),
		});
		expect(uploaded.status).toBe(201);
		const attachment = (await uploaded.json()) as { id: string };
		const preview = await fetch(`${origin}/attachments/${attachment.id}?token=secret-token`);
		expect(preview.status).toBe(200);
		expect(await preview.text()).toBe("hello");

		const renamed = await fetch(`${origin}/attachments/${attachment.id}?token=secret-token`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "renamed.md" }),
		});
		expect(await renamed.json()).toMatchObject({ name: "renamed.md" });
		expect(
			(await fetch(`${origin}/attachments/${attachment.id}?token=secret-token`, { method: "DELETE" })).status,
		).toBe(200);
	});

	test("lists external connections", async () => {
		const response = await fetch(`${origin}/external-connections.json?token=secret-token`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			connections: [{ id: "openai", defaultModel: { provider: "openai", id: "gpt-5.6-luna" } }],
		});
	});

	test("lists managed browser state through the capability-token boundary", async () => {
		const created = await browser.create({
			owner: { kind: "pi-session", id: "session-1" },
			workspace: { id: "project", root },
			access: "loopback",
		});
		const status = await fetch(`${origin}/browser/status?token=secret-token`);
		expect(await status.json()).toMatchObject({ browser: "chromium", installed: false, sessionCount: 1 });
		const sessions = await fetch(
			`${origin}/browser/sessions?token=secret-token&ownerKind=pi-session&ownerId=session-1`,
		);
		expect(await sessions.json()).toMatchObject({ sessions: [{ id: created.id, owner: { id: "session-1" } }] });
		const screenshot = await fetch(`${origin}/browser/sessions/${created.id}/screenshot?token=secret-token`);
		expect(screenshot.headers.get("content-type")).toContain("image/png");
		expect([...new Uint8Array(await screenshot.arrayBuffer())]).toEqual([137, 80, 78, 71]);
		const control = await fetch(`${origin}/browser/sessions/${created.id}/control?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ controlOwner: "user" }),
		});
		expect(await control.json()).toMatchObject({ controlOwner: "user" });
		const diagnostics = await fetch(`${origin}/browser/sessions/${created.id}/diagnostics?token=secret-token`);
		expect(await diagnostics.json()).toEqual({ console: [], networkFailures: [] });
		const navigated = await fetch(`${origin}/browser/sessions/${created.id}/navigate?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url: "http://localhost:4173/preview" }),
		});
		expect(await navigated.json()).toMatchObject({ id: created.id, url: "http://localhost:4173/preview" });
		const denied = await fetch(`${origin}/browser/sessions/${created.id}/navigate?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url: "https://example.com/" }),
		});
		expect(denied.status).toBe(409);
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

	test("creates, runs, and deletes standalone routines", async () => {
		const created = await fetch(`${origin}/routines?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Review changes",
				prompt: "Review the repository",
				enabled: false,
				cron: "0 9 * * 1-5",
				timezone: "America/Chicago",
				maxDurationMinutes: 60,
				target: { kind: "skill", skillName: "code-review" },
			}),
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({ id: "review-changes", target: { kind: "skill" } });

		const started = await fetch(`${origin}/routines/review-changes/run?token=secret-token`, { method: "POST" });
		expect(started.status).toBe(202);
		expect(await started.json()).toMatchObject({ lastRunId: "run-review-changes" });

		const listed = await fetch(`${origin}/routines.json?token=secret-token`);
		expect(await listed.json()).toMatchObject({ routines: [{ id: "review-changes", enabled: false }] });

		const deleted = await fetch(`${origin}/routines/review-changes?token=secret-token`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(await deleted.json()).toEqual({ deleted: true });
	});
});
