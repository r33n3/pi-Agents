import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { normalizeDefinition } from "../src/core/serve/agent-registry.ts";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import { BrowserSessionManager } from "../src/core/serve/browser-session-manager.ts";
import { BrowserSetupStore } from "../src/core/serve/browser-setup-store.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";
import { BrowserWorkflowRunner } from "../src/core/serve/browser-workflow-runner.ts";
import { PlaywrightBrowserDriver } from "../src/core/serve/playwright-browser-driver.ts";
import { fetchPublicText } from "../src/core/serve/public-web-fetch.ts";
import { createTeamBrowserTools, type TeamBrowserRuntime } from "../src/core/serve/team-browser-tools.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { WorkspacePreviewServer } from "../src/core/serve/workspace-preview-server.ts";

vi.mock("../src/core/serve/public-web-fetch.ts", () => ({ fetchPublicText: vi.fn() }));
let root: string;
let setup: BrowserSetupStore;
let runtime: TeamBrowserRuntime;
let resources: TeamResources;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-team-browser-"));
	setup = new BrowserSetupStore(root);
	await setup.initialize();
	const workflows = new BrowserWorkflowRegistry(join(root, "workflows"));
	await workflows.initialize();
	const manager = new BrowserSessionManager(new PlaywrightBrowserDriver(), new BrowserProfileStore(root));
	runtime = {
		setup,
		manager,
		workflows,
		runner: new BrowserWorkflowRunner(workflows, manager, join(root, "runs")),
		preview: new WorkspacePreviewServer(),
		presented: vi.fn(),
	};
	resources = new TeamResources(undefined, undefined, undefined, { setup, workflows });
});
afterEach(async () => {
	await runtime.manager.dispose();
	await runtime.preview.close();
	await rm(root, { recursive: true, force: true });
	vi.clearAllMocks();
});

function agent() {
	return normalizeDefinition(
		{
			id: "reporter",
			name: "Reporter",
			description: "Report",
			persona: "Report",
			tools: [],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		},
		root,
	);
}
async function call(tools: ToolDefinition[], name: string, input: unknown = {}) {
	const tool = tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`Missing tool ${name}`);
	return tool.execute("test", input, undefined, undefined, {} as never);
}

test("saved setup survives restart, stays member scoped, and rejects conflicting browser assignments", async () => {
	await setup.save({
		profiles: [{ id: "travel", name: "Travel", access: "public-web", runtime: "managed-chromium" }],
		sites: [],
	});
	const restored = new BrowserSetupStore(root);
	await restored.initialize();
	expect(restored.snapshot()).toEqual(setup.snapshot());
	const seed = resources.seed(agent(), ["browser-profile:travel"]);
	expect(seed.definition.browser?.profile).toEqual({ kind: "named", id: "travel" });
	expect(resources.idsFor(seed.definition)).toEqual(["browser-profile:travel"]);
	expect(resources.seed(agent(), []).definition.browser).toBeUndefined();
	expect(() => resources.seed(agent(), ["browser-profile:travel", "browser:public-web"])).toThrow(
		"one browser profile",
	);
	await expect(
		setup.save({
			profiles: [],
			sites: [{ id: "bad", name: "Bad", url: "http://127.0.0.1/secret", mode: "markdown" }],
		}),
	).rejects.toThrow();
});

test("site preference reads Markdown with provenance and never grants another site's access", async () => {
	await setup.save({ profiles: [], sites: [{ id: "docs", name: "Docs", url: "https://example.com", mode: "llms" }] });
	vi.mocked(fetchPublicText).mockResolvedValue({
		url: "https://example.com/llms.txt",
		contentType: "text/plain",
		fetchedAt: "2026-09-07",
		text: "# Documentation",
	});
	const definition = resources.seed(agent(), ["site:docs"]).definition;
	const tools = createTeamBrowserTools(runtime, definition, root, { kind: "agent-run", id: "reader" });
	const result = await call(tools, "site_read", { siteId: "docs" });
	expect(fetchPublicText).toHaveBeenCalledWith(
		"https://example.com/llms.txt",
		undefined,
		expect.objectContaining({ accept: expect.stringContaining("text/markdown") }),
	);
	expect(JSON.stringify(result)).toContain("Untrusted site reference");
	await expect(call(tools, "site_read", { siteId: "other" })).rejects.toThrow("not assigned");
	expect(tools.some((tool) => tool.name === "browser_open")).toBe(false);
});

test("real browser presents a workspace report without interactive or signed-in access", async () => {
	await writeFile(
		join(root, "report.html"),
		"<!doctype html><title>Hawaii report</title><h1>Flight Finder report</h1>",
	);
	const definition = resources.seed(agent(), ["browser_present"]).definition;
	const tools = createTeamBrowserTools(runtime, definition, root, { kind: "agent-run", id: "report" });
	const result = await call(tools, "browser_present", { path: "report.html" });
	expect(JSON.stringify(result)).toContain("Displayed report.html");
	expect(tools.map((tool) => tool.name)).toEqual(["browser_present"]);
	const session = runtime.manager.list()[0];
	expect(session.profile.kind).toBe("ephemeral");
	expect((await runtime.manager.snapshot(session.id)).text).toContain("Flight Finder report");
	expect(runtime.presented).toHaveBeenCalledWith(session.id);
	await expect(call(tools, "browser_present", { path: "../outside.html" })).rejects.toThrow();
}, 30000);

test("two agents reuse real saved browser cookies sequentially and cannot open the same profile concurrently", async () => {
	const server = createServer((request, response) => {
		response.writeHead(200, {
			"content-type": "text/html",
			...(request.url === "/save" ? { "set-cookie": "travel=hawaii; Path=/; Max-Age=3600" } : {}),
		});
		response.end(
			`<title>Profile proof</title><h1>${request.headers.cookie?.includes("travel=hawaii") ? "Hawaii preference retained" : "First visit"}</h1>`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture port");
		await setup.save({
			profiles: [{ id: "travel", name: "Travel", access: "loopback", runtime: "managed-chromium" }],
			sites: [],
		});
		const definition = resources.seed(agent(), ["browser-profile:travel"]).definition;
		const first = createTeamBrowserTools(runtime, definition, root, { kind: "agent-run", id: "first" });
		const second = createTeamBrowserTools(runtime, definition, root, { kind: "agent-run", id: "second" });
		await call(first, "browser_open", { url: `http://127.0.0.1:${address.port}/save` });
		await expect(call(second, "browser_open", { url: `http://127.0.0.1:${address.port}/read` })).rejects.toThrow(
			"already in use",
		);
		await call(first, "browser_close");
		await call(second, "browser_open", { url: `http://127.0.0.1:${address.port}/read` });
		expect(JSON.stringify(await call(second, "browser_snapshot"))).toContain("Hawaii preference retained");
	} finally {
		await runtime.manager.dispose();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}, 30000);

test("presentation resolves the current named report instead of the model's older file selection", async () => {
	await writeFile(join(root, "hawaii-flight-report.html"), "<h1>Old report</h1>");
	await writeFile(join(root, "flight-team-status.html"), "<h1>Current status</h1>");
	const definition = { ...resources.seed(agent(), ["browser_present"]).definition };
	definition.teamContext = JSON.stringify({
		goal: "Open the saved flight team status report beside this chat.",
		priorRequests: [{ goal: "Open hawaii-flight-report.html" }],
	});
	const tools = createTeamBrowserTools(runtime, definition, root, { kind: "agent-run", id: "named-report" });
	const presented = await call(tools, "browser_present", { path: "hawaii-flight-report.html" });
	expect(JSON.stringify(presented)).toContain("Displayed flight-team-status.html");
	expect((await runtime.manager.snapshot(runtime.manager.list()[0].id)).text).toContain("Current status");
}, 30000);
