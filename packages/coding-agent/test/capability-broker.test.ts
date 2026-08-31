import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CapabilityBroker,
	type CapabilityDefinition,
	type CapabilityProviderManifest,
} from "../src/core/serve/capability-broker.ts";

describe("CapabilityBroker", () => {
	let root: string;
	let activeTools: string[];
	let broker: CapabilityBroker;

	const definitions: CapabilityDefinition[] = [
		{
			id: "web.search",
			version: 1,
			name: "Web search",
			description: "Search fixture",
			category: "web",
			effect: "read",
			defaultApproval: "never",
		},
	];
	const manifests: CapabilityProviderManifest[] = [
		{
			id: "fixture-search",
			name: "Fixture Search",
			source: "fixture-search@1.0.0",
			version: "1.0.0",
			permissions: ["network read"],
			bindings: [
				{ capabilityId: "web.search", capabilityVersion: 1, toolName: "fixture_search", executors: ["session"] },
			],
		},
	];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-capability-broker-"));
		activeTools = [];
		broker = new CapabilityBroker(root, { activeToolNames: () => activeTools, definitions, manifests });
		await broker.initialize();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("fails closed until the reviewed provider tools are loaded", async () => {
		expect(broker.snapshot()).toMatchObject({
			capabilities: [{ id: "web.search", status: "unavailable" }],
			providers: [{ id: "fixture-search", trust: "quarantined", health: "missing-tools" }],
		});
		await expect(broker.enableProvider("fixture-search", true)).rejects.toThrow("must be reviewed");
		await broker.reviewProvider("fixture-search", true);
		await expect(broker.enableProvider("fixture-search", true)).rejects.toThrow("missing loaded tools");

		activeTools = ["fixture_search"];
		await broker.enableProvider("fixture-search", true);
		expect(broker.resolveToolNames([{ capabilityId: "web.search", capabilityVersion: 1 }], "session")).toEqual([
			"fixture_search",
		]);
		expect(() => broker.resolveToolNames([{ capabilityId: "web.search", capabilityVersion: 1 }], "harness")).toThrow(
			"unavailable for the harness executor",
		);
	});

	test("persists trust, defaults, and an audit trail across restart", async () => {
		activeTools = ["fixture_search"];
		await broker.reviewProvider("fixture-search", true);
		await broker.enableProvider("fixture-search", true);

		const restored = new CapabilityBroker(root, { activeToolNames: () => activeTools, definitions, manifests });
		await restored.initialize();
		expect(restored.snapshot()).toMatchObject({
			capabilities: [{ id: "web.search", defaultProviderId: "fixture-search", status: "active" }],
			providers: [{ id: "fixture-search", trust: "enabled", enabled: true }],
		});
		const audit = await readFile(join(root, "audit.jsonl"), "utf8");
		expect(audit).toContain('"action":"provider.review"');
		expect(audit).toContain('"action":"provider.enable"');
	});

	test("keeps multiple providers enabled while changing the explicit default", async () => {
		activeTools = ["fixture_search", "alternate_search"];
		const alternate: CapabilityProviderManifest = {
			...manifests[0]!,
			id: "alternate-search",
			name: "Alternate Search",
			source: "alternate-search@1.0.0",
			bindings: [
				{ capabilityId: "web.search", capabilityVersion: 1, toolName: "alternate_search", executors: ["session"] },
			],
		};
		const providers = new CapabilityBroker(root, {
			activeToolNames: () => activeTools,
			definitions,
			manifests: [...manifests, alternate],
		});
		await providers.initialize();
		await providers.reviewProvider("fixture-search", true);
		await providers.enableProvider("fixture-search", true);
		await providers.reviewProvider("alternate-search", true);
		await providers.enableProvider("alternate-search", true);

		expect(providers.snapshot()).toMatchObject({
			capabilities: [{ defaultProviderId: "fixture-search", status: "active" }],
			providers: [
				{ id: "fixture-search", enabled: true },
				{ id: "alternate-search", enabled: true },
			],
		});

		await providers.setDefaultProvider("web.search", "alternate-search", true);
		expect(providers.snapshot().capabilities[0]).toMatchObject({ defaultProviderId: "alternate-search" });
	});

	test("requires explicit approval for provider state changes", async () => {
		await expect(broker.reviewProvider("fixture-search", false)).rejects.toThrow("explicit approval");
		await expect(broker.disableProvider("fixture-search", false)).rejects.toThrow("explicit approval");
	});

	test("returns a changed provider manifest to quarantine on restart", async () => {
		activeTools = ["fixture_search"];
		await broker.reviewProvider("fixture-search", true);
		await broker.enableProvider("fixture-search", true);
		const changed = [{ ...manifests[0]!, permissions: ["network read", "new credential access"] }];
		const restored = new CapabilityBroker(root, {
			activeToolNames: () => activeTools,
			definitions,
			manifests: changed,
		});
		await restored.initialize();
		expect(restored.snapshot()).toMatchObject({
			capabilities: [{ id: "web.search", defaultProviderId: undefined }],
			providers: [{ id: "fixture-search", trust: "quarantined", enabled: false }],
		});
	});

	test("requires active, scoped connections for connection-backed reads", async () => {
		activeTools = ["fixture_search"];
		let status = "active";
		const connectedManifest = [{ ...manifests[0]!, connectionRequired: true }];
		const connected = new CapabilityBroker(root, {
			activeToolNames: () => activeTools,
			definitions,
			manifests: connectedManifest,
			providerConnectionAvailable: () => true,
			connectionResolver: (id) =>
				id === "fixture-account"
					? { providerId: "fixture-search", capabilityIds: ["web.search"], status }
					: undefined,
		});
		await connected.initialize();
		await connected.reviewProvider("fixture-search", true);
		await connected.enableProvider("fixture-search", true);
		expect(() =>
			connected.resolveToolNames([{ capabilityId: "web.search", capabilityVersion: 1 }], "session"),
		).toThrow("requires a connection");
		expect(
			connected.resolveToolNames(
				[{ capabilityId: "web.search", capabilityVersion: 1, connectionId: "fixture-account" }],
				"session",
			),
		).toEqual(["fixture_search"]);
		status = "revoked";
		expect(() =>
			connected.resolveToolNames(
				[{ capabilityId: "web.search", capabilityVersion: 1, connectionId: "fixture-account" }],
				"session",
			),
		).toThrow("is revoked");
	});

	test("requires an active account before enabling a connection-backed provider", async () => {
		activeTools = ["fixture_search"];
		let connected = false;
		const provider = new CapabilityBroker(root, {
			activeToolNames: () => activeTools,
			definitions,
			manifests: [{ ...manifests[0]!, connectionRequired: true }],
			providerConnectionAvailable: () => connected,
		});
		await provider.initialize();
		await provider.reviewProvider("fixture-search", true);
		await expect(provider.enableProvider("fixture-search", true)).rejects.toThrow("requires an active connection");
		connected = true;
		await provider.enableProvider("fixture-search", true);
		expect(provider.snapshot().providers[0]).toMatchObject({ enabled: true });
	});

	test("rejects provider manifests that declare process-control environment fields", () => {
		const dangerous: CapabilityProviderManifest = {
			...manifests[0]!,
			authentication: {
				kind: "environment",
				fields: [{ env: "NODE_OPTIONS", label: "Unsafe", required: true, secret: false }],
			},
		};
		expect(
			() =>
				new CapabilityBroker(root, {
					activeToolNames: () => activeTools,
					definitions,
					manifests: [dangerous],
				}),
		).toThrow("prohibited environment field");
	});

	test("rejects non-read capability grants for unattended execution", async () => {
		activeTools = ["fixture_send"];
		const writeDefinitions: CapabilityDefinition[] = [
			{
				id: "email.send",
				version: 1,
				name: "Email send",
				description: "Send fixture",
				category: "communication",
				effect: "external-side-effect",
				defaultApproval: "per-run",
			},
		];
		const writeManifests: CapabilityProviderManifest[] = [
			{
				id: "fixture-mail",
				name: "Fixture Mail",
				source: "fixture-mail",
				version: "1",
				permissions: ["send"],
				bindings: [
					{
						capabilityId: "email.send",
						capabilityVersion: 1,
						toolName: "fixture_send",
						executors: ["session"],
					},
				],
			},
		];
		const writes = new CapabilityBroker(root, {
			activeToolNames: () => activeTools,
			definitions: writeDefinitions,
			manifests: writeManifests,
		});
		await writes.initialize();
		await writes.reviewProvider("fixture-mail", true);
		await writes.enableProvider("fixture-mail", true);
		expect(() =>
			writes.validateUnattendedGrants([{ capabilityId: "email.send", capabilityVersion: 1 }], "session"),
		).toThrow("interactive approval is required");
	});

	test("advertises the built-in SearXNG provider when its tool is loaded", async () => {
		const defaults = new CapabilityBroker(root, {
			activeToolNames: () => ["searxng_search"],
			environmentValue: (name) =>
				name === "SEARXNG_BASE_URL"
					? "http://127.0.0.1:8080"
					: name === "GOOGLE_CLIENT_SECRET"
						? "not-exposed-secret"
						: undefined,
		});
		await defaults.initialize();
		const snapshot = defaults.snapshot();
		expect(snapshot.capabilities.find((entry) => entry.id === "web.search")).toMatchObject({
			id: "web.search",
			status: "available",
		});
		expect(snapshot.providers.find((entry) => entry.id === "pi-searxng")).toMatchObject({
			id: "pi-searxng",
			health: "ready",
			authentication: {
				fields: [{ env: "SEARXNG_BASE_URL", configured: true, value: "http://127.0.0.1:8080" }],
			},
		});
		expect(JSON.stringify(snapshot)).not.toContain("not-exposed-secret");
		expect(snapshot.providers.find((entry) => entry.id === "google-workspace")?.authentication).toMatchObject({
			kind: "oauth2",
			defaultCapabilityIds: ["email.search", "email.read", "email.draft"],
			capabilityGroups: [
				{ id: "gmail", label: "Gmail" },
				{ id: "calendar", label: "Calendar" },
				{ id: "drive", label: "Drive" },
				{ id: "contacts", label: "Contacts" },
				{ id: "chat", label: "Google Chat" },
			],
		});
		expect(snapshot.providers.find((entry) => entry.id === "plaid")).toMatchObject({
			id: "plaid",
			connectionRequired: true,
			authentication: {
				kind: "plaid-link",
				defaultCapabilityIds: ["finance.accounts", "finance.transactions", "finance.spending"],
			},
		});
	});

	test("makes public page reads reviewable without changing existing everyday provider trust", async () => {
		const tools = ["weather_lookup", "weather_alerts", "feed_read", "site_monitor_check", "finance_watchlist_list"];
		const defaults = new CapabilityBroker(root, { activeToolNames: () => tools });
		await defaults.initialize();
		await defaults.reviewProvider("pi-everyday-data", true);
		await defaults.enableProvider("pi-everyday-data", true);
		const restored = new CapabilityBroker(root, { activeToolNames: () => [...tools, "page_read"] });
		await restored.initialize();
		expect(restored.snapshot().providers.find((provider) => provider.id === "pi-everyday-data")).toMatchObject({
			trust: "enabled",
		});
		expect(restored.snapshot().providers.find((provider) => provider.id === "pi-public-web")).toMatchObject({
			trust: "quarantined",
			health: "ready",
			enabled: false,
		});
		const grants = [{ capabilityId: "web.fetch", capabilityVersion: 1, providerId: "pi-public-web" }];
		expect(() => restored.resolveToolNames(grants, "harness")).toThrow("not enabled");
		await restored.reviewProvider("pi-public-web", true);
		await restored.enableProvider("pi-public-web", true);
		expect(restored.resolveToolNames(grants, "harness")).toEqual(["page_read"]);
		expect(restored.resolveToolNames(grants, "session")).toEqual(["page_read"]);
	});

	test("rejects authentication groups that expose unbound capabilities", async () => {
		const invalid: CapabilityProviderManifest = {
			...manifests[0]!,
			authentication: {
				kind: "oauth2",
				fields: [],
				capabilityGroups: [{ id: "search", label: "Search", capabilityIds: ["web.fetch"] }],
			},
		};
		expect(
			() =>
				new CapabilityBroker(root, {
					activeToolNames: () => activeTools,
					definitions,
					manifests: [invalid],
				}),
		).toThrow("groups an unbound capability");
	});
});
