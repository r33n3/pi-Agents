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
});
