import { describe, expect, test } from "vitest";
import type {
	CapabilityDefinition,
	CapabilityProviderManifest,
} from "../src/core/serve/capability-provider-contract.ts";
import {
	CapabilityProviderRegistry,
	capabilityProviderManifestDigest,
} from "../src/core/serve/capability-provider-registry.ts";

const definition: CapabilityDefinition = {
	id: "web.search",
	version: 1,
	name: "Web search",
	description: "Search fixture",
	category: "web",
	effect: "read",
	defaultApproval: "never",
};

const manifest: CapabilityProviderManifest = {
	id: "fixture-search",
	name: "Fixture Search",
	source: "fixture:search",
	version: "1",
	permissions: ["network read"],
	authentication: {
		kind: "environment",
		fields: [{ env: "FIXTURE_TOKEN", label: "Fixture token", required: true, secret: true }],
	},
	bindings: [{ capabilityId: "web.search", capabilityVersion: 1, toolName: "fixture_search", executors: ["session"] }],
};

describe("CapabilityProviderRegistry", () => {
	test("validates built-ins into an immutable secret-free discovery snapshot", () => {
		const snapshot = new CapabilityProviderRegistry().snapshot();
		expect(snapshot.version).toBe(1);
		expect(snapshot.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot.providers.find((provider) => provider.id === "pi-searxng")).toMatchObject({
			authentication: { fields: [{ env: "SEARXNG_BASE_URL", secret: false }] },
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.providers)).toBe(true);
	});

	test("uses canonical provider digests and detects permission changes", () => {
		const reordered: CapabilityProviderManifest = {
			bindings: manifest.bindings,
			permissions: manifest.permissions,
			version: manifest.version,
			source: manifest.source,
			name: manifest.name,
			id: manifest.id,
			authentication: manifest.authentication,
		};
		expect(capabilityProviderManifestDigest(reordered)).toBe(capabilityProviderManifestDigest(manifest));
		expect(capabilityProviderManifestDigest({ ...manifest, permissions: ["network read", "credential"] })).not.toBe(
			capabilityProviderManifestDigest(manifest),
		);
	});

	test("rejects invalid sidecar metadata before runtime activation", () => {
		expect(
			() =>
				new CapabilityProviderRegistry({
					definitions: [definition],
					providers: [
						{
							...manifest,
							authentication: {
								kind: "environment",
								fields: [{ env: "NODE_OPTIONS", label: "Unsafe", required: true, secret: false }],
							},
						},
					],
				}),
		).toThrow("prohibited environment field");
	});
});
