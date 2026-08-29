import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CredentialVaultError,
	EncryptedCredentialVault,
	type WindowsKeyProtector,
} from "../src/core/serve/encrypted-credential-vault.ts";

const fakeProtector: WindowsKeyProtector = {
	async wrap(key) {
		return Buffer.from(key).reverse();
	},
	async unwrap(value) {
		return Buffer.from(value).reverse();
	},
};

describe("EncryptedCredentialVault", () => {
	let root: string;
	let vaultPath: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-credential-vault-"));
		vaultPath = join(root, "credentials", "vault.json");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("encrypts provider names, field names, and values while resolving selected fields", async () => {
		const vault = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await vault.initialize();
		await vault.replace(
			"google-workspace",
			{ GOOGLE_CLIENT_SECRET: "client-secret", GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-secret" },
			[],
			false,
		);
		const disk = await readFile(vaultPath, "utf8");
		expect(disk).not.toContain("google-workspace");
		expect(disk).not.toContain("GOOGLE_CLIENT_SECRET");
		expect(disk).not.toContain("client-secret");
		expect(vault.resolve("google-workspace", ["GOOGLE_CLIENT_SECRET"])).toEqual({
			GOOGLE_CLIENT_SECRET: "client-secret",
		});
		expect(vault.resolve("google-workspace", ["GOOGLE_OAUTH_ACCESS_TOKEN"])).toEqual({});
	});

	test("restarts through the Windows key protector and locks without exposing metadata values", async () => {
		const created = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await created.initialize();
		await created.replace("openai-api", { OPENAI_API_KEY: "secret" }, [], false);
		created.lock();
		expect(await created.status()).toMatchObject({ initialized: true, locked: true, protection: "windows" });
		expect(() => created.resolve("openai-api", ["OPENAI_API_KEY"])).toThrow("locked");

		const restarted = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await restarted.unlock();
		expect(restarted.resolve("openai-api", ["OPENAI_API_KEY"])).toEqual({ OPENAI_API_KEY: "secret" });
	});

	test.skipIf(process.platform !== "win32")("restarts through Windows DPAPI for the current user", async () => {
		const created = new EncryptedCredentialVault({ path: vaultPath, scope: "user", platform: "win32" });
		await created.initialize();
		await created.replace("fixture", { FIXTURE_TOKEN: "dpapi-secret" }, [], false);
		created.lock();
		const restarted = new EncryptedCredentialVault({ path: vaultPath, scope: "user", platform: "win32" });
		await restarted.unlock();
		expect(restarted.resolve("fixture", ["FIXTURE_TOKEN"])).toEqual({ FIXTURE_TOKEN: "dpapi-secret" });
	});

	test("supports portable passphrase protection and fails closed for the wrong passphrase", async () => {
		const created = new EncryptedCredentialVault({ path: vaultPath, scope: "workspace", platform: "linux" });
		await created.initialize("correct horse battery staple");
		await created.replace("fixture", { FIXTURE_TOKEN: "secret" }, [], false);
		created.lock();

		const wrong = new EncryptedCredentialVault({ path: vaultPath, scope: "workspace", platform: "linux" });
		await expect(wrong.unlock("this passphrase is incorrect")).rejects.toMatchObject({
			code: "VAULT_UNLOCK_FAILED",
		});
		const restarted = new EncryptedCredentialVault({ path: vaultPath, scope: "workspace", platform: "linux" });
		await restarted.unlock("correct horse battery staple");
		expect(restarted.resolve("fixture", ["FIXTURE_TOKEN"])).toEqual({ FIXTURE_TOKEN: "secret" });
	});

	test("rejects authenticated-envelope tampering", async () => {
		const vault = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await vault.initialize();
		vault.lock();
		const envelope = JSON.parse(await readFile(vaultPath, "utf8")) as { generation: number };
		envelope.generation += 1;
		await writeFile(vaultPath, JSON.stringify(envelope), "utf8");
		const restarted = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await expect(restarted.unlock()).rejects.toBeInstanceOf(CredentialVaultError);
	});

	test("serializes concurrent provider mutations without losing fields", async () => {
		const vault = new EncryptedCredentialVault({
			path: vaultPath,
			scope: "user",
			platform: "win32",
			windowsKeyProtector: fakeProtector,
		});
		await vault.initialize();
		await Promise.all([
			vault.replace("fixture", { FIXTURE_ONE: "one" }, [], false),
			vault.replace("fixture", { FIXTURE_TWO: "two" }, [], false),
		]);
		expect(vault.resolve("fixture", ["FIXTURE_ONE", "FIXTURE_TWO"])).toEqual({
			FIXTURE_ONE: "one",
			FIXTURE_TWO: "two",
		});
	});
});
