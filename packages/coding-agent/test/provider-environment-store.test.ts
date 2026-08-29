import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProviderAuthenticationManifest } from "../src/core/serve/capability-broker.ts";
import type { WindowsKeyProtector } from "../src/core/serve/encrypted-credential-vault.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";

const fakeProtector: WindowsKeyProtector = {
	async wrap(key) {
		return Buffer.from(key).reverse();
	},
	async unwrap(value) {
		return Buffer.from(value).reverse();
	},
};

describe("ProviderEnvironmentStore", () => {
	let root: string;
	let environment: NodeJS.ProcessEnv;
	let store: ProviderEnvironmentStore;
	const manifest: ProviderAuthenticationManifest = {
		kind: "environment",
		fields: [
			{ env: "FIXTURE_URL", label: "Fixture URL", required: true, secret: false, format: "url" },
			{ env: "FIXTURE_TOKEN", label: "Fixture token", required: true, secret: true },
		],
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-provider-environment-"));
		environment = {};
		store = new ProviderEnvironmentStore(root, (providerId) => (providerId === "fixture" ? manifest : undefined), {
			environment,
			vaultPath: join(root, "user", "credentials.v1.json"),
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("preserves unrelated content and returns only redacted configuration status", async () => {
		await writeFile(join(root, ".env.local"), "# retained\nUNRELATED=keep\nFIXTURE_TOKEN=old\n", "utf8");
		const result = await store.configure("fixture", {
			values: { FIXTURE_URL: "https://example.test", FIXTURE_TOKEN: "new-secret" },
		});
		expect(result).toEqual({
			providerId: "fixture",
			kind: "environment",
			configured: true,
			storage: "encrypted-user-vault",
			fields: [
				{ ...manifest.fields[0], configured: true, value: "https://example.test", source: "vault" },
				{ ...manifest.fields[1], configured: true, source: "vault" },
			],
		});
		expect(JSON.stringify(result)).toContain("https://example.test");
		expect(JSON.stringify(result)).not.toContain("new-secret");
		expect(await readFile(join(root, ".env.local"), "utf8")).toBe("# retained\nUNRELATED=keep\nFIXTURE_TOKEN=old\n");
		expect(environment).toEqual({});
		expect(await readFile(join(root, "user", "credentials.v1.json"), "utf8")).not.toContain("new-secret");
	});

	test("rejects undeclared names, multiline values, and credential-bearing URLs", async () => {
		await expect(store.configure("fixture", { values: { NODE_OPTIONS: "--require attack.js" } })).rejects.toThrow(
			"does not declare NODE_OPTIONS",
		);
		await expect(store.configure("fixture", { values: { FIXTURE_TOKEN: "one\ntwo" } })).rejects.toThrow(
			"single-line",
		);
		await expect(
			store.configure("fixture", { values: { FIXTURE_URL: "https://user:pass@example.test" } }),
		).rejects.toThrow("without embedded credentials");
	});

	test("clears declared values from the vault without mutating the legacy environment", async () => {
		await store.configure("fixture", {
			values: { FIXTURE_URL: "https://example.test", FIXTURE_TOKEN: "secret" },
		});
		await store.configure("fixture", { clear: ["FIXTURE_TOKEN"] });
		expect(environment.FIXTURE_TOKEN).toBeUndefined();
		await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await store.status("fixture")).toMatchObject({ configured: false });
	});

	test("serializes concurrent updates without losing either field", async () => {
		await Promise.all([
			store.configure("fixture", { values: { FIXTURE_URL: "https://example.test" } }),
			store.configure("fixture", { values: { FIXTURE_TOKEN: "secret" } }),
		]);
		expect(await store.resolveTrusted("fixture", ["FIXTURE_URL", "FIXTURE_TOKEN"])).toEqual({
			FIXTURE_URL: "https://example.test",
			FIXTURE_TOKEN: "secret",
		});
	});

	test("exposes safe metadata while trusted adapters can resolve selected values", async () => {
		await store.store("fixture", {
			FIXTURE_URL: "https://example.test",
			FIXTURE_TOKEN: "secret-value",
		});
		const metadata = await store.metadata("fixture");
		expect(metadata).toEqual({
			reference: "vault:user/fixture",
			providerId: "fixture",
			storage: "encrypted-user-vault",
			configured: true,
			entries: [
				{ name: "FIXTURE_URL", configured: true },
				{ name: "FIXTURE_TOKEN", configured: true },
			],
		});
		expect(JSON.stringify(metadata)).not.toContain("secret-value");
		expect(await store.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).toEqual({
			FIXTURE_TOKEN: "secret-value",
		});
	});

	test("distinguishes create from replace and supports selective revocation", async () => {
		await store.store("fixture", { FIXTURE_TOKEN: "first" });
		await expect(store.store("fixture", { FIXTURE_TOKEN: "second" })).rejects.toThrow("already stored");
		await store.replace("fixture", {
			values: { FIXTURE_TOKEN: "second", FIXTURE_URL: "https://example.test" },
		});
		expect(await store.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).toEqual({ FIXTURE_TOKEN: "second" });
		await store.revoke("fixture", ["FIXTURE_TOKEN"]);
		expect(await store.resolveTrusted("fixture", ["FIXTURE_TOKEN", "FIXTURE_URL"])).toEqual({
			FIXTURE_URL: "https://example.test",
		});
	});

	test("fails closed while locked instead of falling back to legacy values", async () => {
		await writeFile(join(root, ".env.local"), "FIXTURE_TOKEN=legacy-secret\n", "utf8");
		await store.configure("fixture", { values: { FIXTURE_TOKEN: "vault-secret" } });
		await store.lockVault();
		expect(store.environmentValue("FIXTURE_TOKEN")).toBeUndefined();
		expect(await store.status("fixture")).toMatchObject({ configured: false });
		await expect(store.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).rejects.toThrow("vault is locked");
	});

	test("validates trusted resolution and replacement inputs without echoing values", async () => {
		await expect(store.resolveTrusted("fixture", ["NODE_OPTIONS"])).rejects.toThrow("is not allowed");
		await expect(store.replace("fixture", { values: { FIXTURE_TOKEN: 42 as unknown as string } })).rejects.toThrow(
			"must be a string",
		);
		await expect(store.replace("fixture", { values: { FIXTURE_TOKEN: "line\nbreak" } })).rejects.toThrow(
			"single-line",
		);
	});

	test("imports persisted legacy values into an encrypted vault and restarts without hydrating process environment", async () => {
		await writeFile(
			join(root, ".env.local"),
			'FIXTURE_URL="https://restart.example.test"\nFIXTURE_TOKEN="restart-secret"\n',
			"utf8",
		);
		const restartedEnvironment: NodeJS.ProcessEnv = {};
		const restarted = new ProviderEnvironmentStore(root, () => manifest, {
			environment: restartedEnvironment,
			vaultPath: join(root, "user", "credentials.v1.json"),
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await restarted.initialize();
		await restarted.migrateLegacy(["fixture"]);
		expect(await restarted.status("fixture")).toMatchObject({ configured: true });
		expect(await restarted.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).toEqual({
			FIXTURE_TOKEN: "restart-secret",
		});
		expect(restartedEnvironment).toEqual({});
		await restarted.dispose();
		const secondRestart = new ProviderEnvironmentStore(root, () => manifest, {
			environment: {},
			vaultPath: join(root, "user", "credentials.v1.json"),
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		expect(await secondRestart.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).toEqual({
			FIXTURE_TOKEN: "restart-secret",
		});
	});

	test("rejects provider-owned and dangerous environment fields at the write boundary", async () => {
		const managedManifest: ProviderAuthenticationManifest = {
			kind: "oauth2",
			fields: [
				{
					env: "FIXTURE_MANAGED_TOKEN",
					label: "Managed token",
					required: false,
					secret: true,
					operatorEditable: false,
				},
			],
		};
		const managedStore = new ProviderEnvironmentStore(root, () => managedManifest, {
			environment,
			vaultPath: join(root, "managed", "credentials.v1.json"),
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await expect(
			managedStore.configure("fixture", { values: { FIXTURE_MANAGED_TOKEN: "operator-supplied" } }),
		).rejects.toThrow("does not declare");
		await managedStore.configureManaged("fixture", { values: { FIXTURE_MANAGED_TOKEN: "provider-supplied" } });
		expect(environment.FIXTURE_MANAGED_TOKEN).toBeUndefined();
		expect(await managedStore.resolveTrusted("fixture", ["FIXTURE_MANAGED_TOKEN"])).toEqual({
			FIXTURE_MANAGED_TOKEN: "provider-supplied",
		});

		const dangerousManifest: ProviderAuthenticationManifest = {
			kind: "environment",
			fields: [{ env: "NODE_OPTIONS", label: "Unsafe", required: true, secret: false }],
		};
		const dangerousStore = new ProviderEnvironmentStore(root, () => dangerousManifest, {
			environment,
			vaultPath: join(root, "dangerous", "credentials.v1.json"),
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await expect(dangerousStore.status("fixture")).rejects.toThrow("is not allowed");
	});
});
