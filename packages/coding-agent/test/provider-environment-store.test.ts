import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProviderAuthenticationManifest } from "../src/core/serve/capability-broker.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";

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
		store = new ProviderEnvironmentStore(
			root,
			(providerId) => (providerId === "fixture" ? manifest : undefined),
			environment,
		);
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
			fields: [
				{ ...manifest.fields[0], configured: true },
				{ ...manifest.fields[1], configured: true },
			],
		});
		expect(JSON.stringify(result)).not.toContain("new-secret");
		expect(await readFile(join(root, ".env.local"), "utf8")).toBe(
			'# retained\nUNRELATED=keep\nFIXTURE_TOKEN="new-secret"\nFIXTURE_URL="https://example.test"\n',
		);
		expect(environment).toMatchObject({
			FIXTURE_URL: "https://example.test",
			FIXTURE_TOKEN: "new-secret",
		});
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

	test("clears declared values from the file and running environment", async () => {
		await store.configure("fixture", {
			values: { FIXTURE_URL: "https://example.test", FIXTURE_TOKEN: "secret" },
		});
		await store.configure("fixture", { clear: ["FIXTURE_TOKEN"] });
		expect(environment.FIXTURE_TOKEN).toBeUndefined();
		expect(await readFile(join(root, ".env.local"), "utf8")).not.toContain("FIXTURE_TOKEN");
		expect(await store.status("fixture")).toMatchObject({ configured: false });
	});

	test("serializes concurrent updates without losing either field", async () => {
		await Promise.all([
			store.configure("fixture", { values: { FIXTURE_URL: "https://example.test" } }),
			store.configure("fixture", { values: { FIXTURE_TOKEN: "secret" } }),
		]);
		const contents = await readFile(join(root, ".env.local"), "utf8");
		expect(contents).toContain("FIXTURE_URL=");
		expect(contents).toContain("FIXTURE_TOKEN=");
	});

	test("exposes safe metadata while trusted adapters can resolve selected values", async () => {
		await store.store("fixture", {
			FIXTURE_URL: "https://example.test",
			FIXTURE_TOKEN: "secret-value",
		});
		const metadata = await store.metadata("fixture");
		expect(metadata).toEqual({
			reference: "managed:project-environment/fixture",
			providerId: "fixture",
			storage: "project-environment",
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

	test("validates trusted resolution and replacement inputs without echoing values", async () => {
		await expect(store.resolveTrusted("fixture", ["NODE_OPTIONS"])).rejects.toThrow("is not allowed");
		await expect(store.replace("fixture", { values: { FIXTURE_TOKEN: 42 as unknown as string } })).rejects.toThrow(
			"must be a string",
		);
		await expect(store.replace("fixture", { values: { FIXTURE_TOKEN: "line\nbreak" } })).rejects.toThrow(
			"single-line",
		);
	});

	test("loads persisted project values into a fresh process environment", async () => {
		await writeFile(
			join(root, ".env.local"),
			'FIXTURE_URL="https://restart.example.test"\nFIXTURE_TOKEN="restart-secret"\n',
			"utf8",
		);
		const restartedEnvironment: NodeJS.ProcessEnv = {};
		const restarted = new ProviderEnvironmentStore(root, () => manifest, restartedEnvironment);
		expect(await restarted.status("fixture")).toMatchObject({ configured: true });
		expect(await restarted.resolveTrusted("fixture", ["FIXTURE_TOKEN"])).toEqual({
			FIXTURE_TOKEN: "restart-secret",
		});
		expect(restartedEnvironment).toMatchObject({
			FIXTURE_URL: "https://restart.example.test",
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
		const managedStore = new ProviderEnvironmentStore(root, () => managedManifest, environment);
		await expect(
			managedStore.configure("fixture", { values: { FIXTURE_MANAGED_TOKEN: "operator-supplied" } }),
		).rejects.toThrow("does not declare");
		await managedStore.configureManaged("fixture", { values: { FIXTURE_MANAGED_TOKEN: "provider-supplied" } });
		expect(environment.FIXTURE_MANAGED_TOKEN).toBe("provider-supplied");

		const dangerousManifest: ProviderAuthenticationManifest = {
			kind: "environment",
			fields: [{ env: "NODE_OPTIONS", label: "Unsafe", required: true, secret: false }],
		};
		const dangerousStore = new ProviderEnvironmentStore(root, () => dangerousManifest, environment);
		await expect(dangerousStore.status("fixture")).rejects.toThrow("is not allowed");
	});
});
