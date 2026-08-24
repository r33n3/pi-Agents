import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";

describe("CapabilityConnectionRegistry", () => {
	let root: string;
	let registry: CapabilityConnectionRegistry;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-capability-connections-"));
		registry = new CapabilityConnectionRegistry(root);
		await registry.initialize();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("persists secret references without accepting credential values", async () => {
		const saved = await registry.save({
			providerId: "gmail",
			accountLabel: "Work",
			secretRef: "managed:gmail/work",
			scopes: ["mail.read"],
			capabilityIds: ["email.read"],
		});
		const restored = new CapabilityConnectionRegistry(root);
		expect(await restored.get(saved.id)).toEqual(saved);
		await expect(
			registry.save({
				providerId: "gmail",
				accountLabel: "Unsafe",
				secretRef: "actual-access-token",
				scopes: [],
				capabilityIds: [],
			}),
		).rejects.toThrow("secretRef");
	});

	test("revocation immediately invalidates grants and is durable", async () => {
		const saved = await registry.save({
			id: "weather-home",
			providerId: "open-meteo",
			accountLabel: "Home",
			secretRef: "managed:anonymous/open-meteo",
			scopes: [],
			capabilityIds: ["weather.read"],
		});
		await expect(registry.assertGrant(saved.id, "open-meteo", "weather.read")).resolves.toBeUndefined();
		await registry.revoke(saved.id);
		await expect(registry.assertGrant(saved.id, "open-meteo", "weather.read")).rejects.toThrow("revoked");
		await expect(registry.save({ ...saved, status: "active" })).rejects.toThrow("cannot be replaced");
	});
});
