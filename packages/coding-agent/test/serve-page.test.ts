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
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { EverydayConfigurationRegistry } from "../src/core/serve/everyday-configuration-registry.ts";
import { ExternalConnectionManager } from "../src/core/serve/external-connection-manager.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";
import { ServeAttachmentStore } from "../src/core/serve/serve-attachment-store.ts";
import { createServePage } from "../src/core/serve/serve-page.ts";

describe("createServePage", () => {
	let server: Server;
	let origin: string;
	let root: string;
	let attachmentStore: ServeAttachmentStore;
	let browser: BrowserSessionManager;
	let capabilityBroker: CapabilityBroker;
	let everydayConfigurations: EverydayConfigurationRegistry;
	let providerEnvironment: ProviderEnvironmentStore;

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

		async elementAt(): Promise<undefined> {
			return undefined;
		}

		async focusedElement(): Promise<undefined> {
			return undefined;
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
					provider: "openai",
					authentication: "api-key",
					billing: "usage-based",
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
		const environment: NodeJS.ProcessEnv = {};
		capabilityBroker = new CapabilityBroker(join(root, "capabilities"), {
			activeToolNames: () => ["fixture_search"],
			environmentValue: (name) => environment[name],
			definitions: [
				{
					id: "web.search",
					version: 1,
					name: "Web search",
					description: "Fixture search",
					category: "web",
					effect: "read",
					defaultApproval: "never",
				},
			],
			manifests: [
				{
					id: "fixture-search",
					name: "Fixture Search",
					source: "fixture-search@1.0.0",
					version: "1.0.0",
					permissions: ["network read"],
					authentication: {
						kind: "environment",
						fields: [{ env: "FIXTURE_TOKEN", label: "Fixture token", required: true, secret: true }],
					},
					bindings: [
						{
							capabilityId: "web.search",
							capabilityVersion: 1,
							toolName: "fixture_search",
							executors: ["session"],
						},
					],
				},
			],
		});
		await capabilityBroker.initialize();
		providerEnvironment = new ProviderEnvironmentStore(
			root,
			(providerId) => capabilityBroker.authenticationManifest(providerId),
			environment,
		);
		everydayConfigurations = new EverydayConfigurationRegistry(join(root, "everyday"));
		await everydayConfigurations.initialize();
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
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				capabilityBroker,
				undefined,
				undefined,
				undefined,
				everydayConfigurations,
				providerEnvironment,
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
		expect(html).toContain('class="rail-heading"');
		expect(html).toContain('aria-label="Connect another Pi session"');
		expect(html).toContain('id="open-settings"');
		expect(html).toContain('title="Settings" aria-label="Open Settings"');
		expect(html).toContain('id="settings-workspace"');
		expect(html).toContain('aria-label="Settings workspace"');
		expect(html).toContain('data-settings-section="models"');
		expect(html).toContain('data-settings-section="connections"');
		expect(html).toContain('data-settings-section="capabilities"');
		expect(html).toContain('data-settings-section="plugins"');
		expect(html).toContain('data-settings-section="security"');
		expect(html).toContain('id="settings-connection-advanced"');
		expect(html).toContain('class="pi-watermark"');
		expect(html).toContain('id="left-resizer"');
		expect(html).toContain('id="composer-action"');
		expect(html).toContain('id="session-path"');
		expect(html).toContain('id="session-path-form"');
		expect(html).toContain('id="session-path-input"');
		expect(html).toContain('id="session-path-cancel"');
		expect(html).not.toContain('aria-label="Open Pi sessions"></div><span id="session-path"');
		expect(html).toContain(".composer-meta #session-path");
		expect(html).toContain('id="session-stats"');
		expect(html).toContain(".context-meter");
		expect(html).toContain(".message{min-width:0;overflow-wrap:anywhere}");
		expect(html).toContain(".session-stat-input");
		expect(html).toContain(".session-stat-output");
		expect(html).toContain(".session-stat-cost");
		expect(html).toContain(".file-picker-input");
		expect(html).toContain('id="mobile-panel-left"');
		expect(html).toContain('id="mobile-panel-right"');
		expect(html).toContain('for="mobile-panel-left"');
		expect(html).toContain('for="mobile-panel-right"');
		expect(html).toContain("#mobile-panel-left:checked~.rail");
		expect(html).toContain("#mobile-panel-right:checked~.details");
		expect(html).toContain(".rail #open-settings{position:absolute");
		expect(html).toContain(".rail{padding-bottom:72px}");
		expect(html).toContain(".rail #open-settings{z-index:10}");
		expect(html).toContain(".delegation-panel-host>.card{max-height:min(32dvh,280px)}");
		expect(html).toContain(".external-connection-entry{display:flex;width:100%;min-width:0");
		expect(html).toContain(".rail .rail-heading{position:static;z-index:3}");
		expect(html).toContain("bottom:calc(14px + env(safe-area-inset-bottom))");
		expect(html).toContain("@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse)");
		expect(html).toContain("#prompt{max-height:112px}");
		expect(html).toContain(".thinking-activity");
		expect(html).toContain('id="attachment-button"');
		expect(html).toContain('data-tab="browser"');
		expect(html).toContain('data-tab="agents-workspace"');
		expect(html).toContain('data-tab="agent-builder"');
		expect(html).toContain('[data-tab="agent-builder"]{display:none}');
		expect(html).toContain(".builder-guide-heading");
		expect(html).toContain(".agent-workspace-actions{justify-content:flex-start}");
		expect(html).toContain("border:0;border-radius:0;background:transparent");
		expect(html).toContain('.browser-workflow-action-state[data-status="running"]');
		expect(html).toContain('.browser-workflow-actions button[aria-busy="true"]');
		expect(html).toContain(".browser-profile-description");
		expect(html).toContain('class="rail-heading agent-activity-heading"');
		expect(html).toContain('id="agent-activity-list"');
		expect(html).toContain('id="rail-section-resizer"');
		expect(html).toContain('id="delegation-panel-host"');
		expect(html).toContain('class="card agent-run-history"');
		expect(html).not.toContain('id="selected-agent-chat-form"');
		expect(html).toContain('data-builder-tab="builder-profile-panel"');
		expect(html).toContain("Save and deploy");
		expect(html).not.toContain('id="builder-chat-panel"');
		expect(html).not.toContain('id="builder-chat-form"');
		expect(html).toContain('id="external-connection-list"');
		expect(html).toContain('id="external-run-form"');
		expect(html).toContain('id="capability-approval-list"');
		expect(html).toContain('id="inbound-route-form"');
		expect(html).toContain('id="site-monitor-form"');
		expect(html).toContain('id="finance-watchlist-form"');
		expect(html).not.toContain('id="preview-type-form"');
		expect(html).not.toContain('class="brand"');

		const bundle = await fetch(`${origin}/browser-client.js?token=secret-token`);
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("content-type")).toContain("text/javascript");
		const bundleText = await bundle.text();
		expect(bundleText.length).toBeGreaterThan(1000);
		expect(bundleText).toContain("Advanced configuration");
		expect(bundleText).toContain('closest(".agent-menu")');
		expect(bundleText).toContain("Run active workflow");
		expect(bundleText).toContain("browser-workflow-action-state");
		expect(bundleText).toContain("Delete recorded workflow");
		expect(bundleText).toContain("Signed-in profiles");
		expect(bundleText).toContain("tool-activity-summary");
		expect(bundleText).toContain("Web services");
		expect(bundleText).toContain("Configured \\xB7 review required");
		expect(bundleText).toContain("tool-activity-state");
		expect(bundleText).toContain("tokens remaining");
		expect(bundleText).toContain("Estimated session cost in US dollars");
		expect(bundleText).toContain("showPicker");
		expect(bundleText).toContain("browser-session-tabs");
		expect(bundleText).toContain("Active browsers");
		expect(bundleText).toContain("browserPopout");
		expect(bundleText).toContain("Pop out browser");
		expect(bundleText).toContain("agent-session-tab");
		expect(bundleText).toContain("Active agent conversation");
		expect(bundleText).toContain("builder-session-tab");
		expect(bundleText).toContain("Continue configuring this agent");
		expect(bundleText).toContain("Configure and deploy a local agent");
		expect(bundleText).toContain("builder-settings-stack");
		expect(bundleText).toContain("Choose the model and reasoning depth.");
		expect(bundleText).toContain("Grant only resources that are ready in Settings.");
		expect(bundleText).toContain("Runtime");
		expect(bundleText).toContain("Delegation");
		expect(bundleText).toContain("Capabilities");
		expect(bundleText).toContain("#settings/");
		expect(bundleText).toContain("Setup required");
		expect(bundleText).toContain("OAuth configured \\xB7 account not connected");
		expect(bundleText).toContain("Account not connected");
		expect(bundleText).toContain("Access not granted");
		expect(bundleText).toContain("Financial data");
		expect(bundleText).toContain("Google access");
		expect(bundleText).toContain("to request");
		expect(bundleText).toContain("supported");
		expect(bundleText).toContain("Needs attention");
		expect(bundleText).toContain("agent-capability-summary");
		expect(bundleText).toContain("capability-grant");
		expect(bundleText).toContain("subagent-card");
		expect(bundleText).toContain("subagent-session-tab");
		expect(bundleText).toContain("Inspect agent run");
		expect(bundleText).toContain("Subagent inspector is read-only");
		expect(bundleText).toContain("Agent Builder applied a draft");
		expect(bundleText).toContain("[AGENT_DRAFT]");
		expect(bundleText).toContain("Complete the delegation task, working directory, and model");
		expect(bundleText).toContain("Select a model supported by this delegation connection");
		expect(bundleText).toContain("Delegated run output");
		expect(bundleText).toContain("Send result to Pi");
		expect(bundleText).toContain("Inspect run");
		expect(bundleText).toContain("pi-serve-external-run-tabs-v2");
		expect(bundleText).toContain("pi-serve-external-model:");
		expect(bundleText).not.toContain('pi-serve-external-run-tabs"');
		expect(bundleText).toContain("Browser session ended. Start or select another managed browser.");
		expect(bundleText).not.toContain("No active browser");
		expect(bundleText).not.toContain("Record a walkthrough, then send it to Pi for review.");
		expect(bundleText).not.toContain("Ask Pi or an agent to open a permitted URL.");
		expect(bundleText).not.toContain("Could not load browser diagnostics");
		expect(bundleText).toContain("Send to Pi");
	});

	test("serves the authenticated Plaid Link host without exposing it anonymously", async () => {
		expect((await fetch(`${origin}/capability-plaid/link?linkToken=link-sandbox`)).status).toBe(403);
		const page = await fetch(
			`${origin}/capability-plaid/link?token=secret-token&linkToken=${encodeURIComponent("link-sandbox")}`,
		);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("https://cdn.plaid.com");
		const html = await page.text();
		expect(html).toContain('data-link-token="link-sandbox"');
		expect(html).toContain("/plaid-link-client.js?token=secret-token");
		expect((await fetch(`${origin}/plaid-link-client.js?token=secret-token`)).status).toBe(200);
	});

	test("creates and removes everyday configurations through authenticated controls", async () => {
		const monitor = await fetch(`${origin}/everyday-configurations/monitors?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "release-notes",
				name: "Release notes",
				url: "https://example.com/news",
				enabled: true,
			}),
		});
		expect(monitor.status).toBe(201);
		const watchlist = await fetch(`${origin}/everyday-configurations/watchlists?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "markets", name: "Markets", symbols: ["msft", "AAPL"], enabled: true }),
		});
		expect(watchlist.status).toBe(201);
		const listed = await fetch(`${origin}/everyday-configurations.json?token=secret-token`);
		expect(await listed.json()).toMatchObject({
			monitors: [{ id: "release-notes" }],
			watchlists: [{ id: "markets", symbols: ["AAPL", "MSFT"] }],
		});
		expect(
			(
				await fetch(`${origin}/everyday-configurations/monitors/release-notes?token=secret-token`, {
					method: "DELETE",
				})
			).status,
		).toBe(200);
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

	test("requires review before enabling a capability provider over HTTP", async () => {
		const enableBeforeReview = await fetch(
			`${origin}/capability-providers/fixture-search/enable?token=secret-token`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ approved: true }),
			},
		);
		expect(enableBeforeReview.status).toBe(400);
		const configured = await fetch(`${origin}/capability-providers/fixture-search/configuration?token=secret-token`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ values: { FIXTURE_TOKEN: "secret-value" } }),
		});
		expect(await configured.json()).toMatchObject({
			providerId: "fixture-search",
			configured: true,
			fields: [{ env: "FIXTURE_TOKEN", configured: true }],
		});
		expect(
			JSON.stringify(
				await (
					await fetch(`${origin}/capability-providers/fixture-search/configuration?token=secret-token`)
				).json(),
			),
		).not.toContain("secret-value");
		const review = await fetch(`${origin}/capability-providers/fixture-search/review?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		expect(await review.json()).toMatchObject({ trust: "reviewed" });
		const enabled = await fetch(`${origin}/capability-providers/fixture-search/enable?token=secret-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ approved: true }),
		});
		expect(await enabled.json()).toMatchObject({ trust: "enabled", enabled: true });
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
		await browser.close(created.id);
		const closedStatus = await fetch(`${origin}/browser/status?token=secret-token`);
		expect(await closedStatus.json()).toMatchObject({ sessionCount: 0 });
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
