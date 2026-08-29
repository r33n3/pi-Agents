import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const SCHEMA = "pi.local-credential-vault.v1";
const CRYPTO_PROFILE = "pi.symmetric-256.v1";
const CIPHER = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MIN_PASSPHRASE_LENGTH = 16;
const LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export type CredentialVaultScope = "user" | "workspace";

export interface VaultCredentialEntry {
	providerId: string;
	values: Readonly<Record<string, string>>;
	createdAt: string;
	updatedAt: string;
	version: number;
}

export interface CredentialVaultStatus {
	path: string;
	scope: CredentialVaultScope;
	initialized: boolean;
	locked: boolean;
	protection: "windows" | "passphrase" | "none";
	generation?: number;
	updatedAt?: string;
	credentialCount?: number;
}

export interface WindowsKeyProtector {
	wrap(key: Buffer): Promise<Buffer>;
	unwrap(value: Buffer): Promise<Buffer>;
}

export interface EncryptedCredentialVaultOptions {
	path: string;
	scope: CredentialVaultScope;
	platform?: NodeJS.Platform;
	windowsKeyProtector?: WindowsKeyProtector;
	now?: () => Date;
	lockTimeoutMs?: number;
}

interface VaultPayload {
	version: 1;
	entries: Record<string, VaultCredentialEntry>;
}

interface WindowsKeyProtection {
	type: "windows-dpapi-current-user";
	wrappedKey: string;
}

interface PassphraseKeyProtection {
	type: "scrypt-passphrase";
	salt: string;
	n: number;
	r: number;
	p: number;
	iv: string;
	tag: string;
	wrappedKey: string;
}

type KeyProtection = WindowsKeyProtection | PassphraseKeyProtection;

interface VaultEnvelope {
	schema: typeof SCHEMA;
	cryptoProfile: typeof CRYPTO_PROFILE;
	vaultId: string;
	scope: CredentialVaultScope;
	createdAt: string;
	updatedAt: string;
	generation: number;
	keyProtections: KeyProtection[];
	cipher: {
		algorithm: typeof CIPHER;
		iv: string;
		tag: string;
		ciphertext: string;
	};
}

interface LockRecord {
	pid: number;
	createdAt: string;
	token: string;
}

export class CredentialVaultError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CredentialVaultError";
		this.code = code;
	}
}

/** Owns encrypted persistence, key protection, locking, and credential lifetimes. */
export class EncryptedCredentialVault {
	readonly #path: string;
	readonly #lockPath: string;
	readonly #scope: CredentialVaultScope;
	readonly #platform: NodeJS.Platform;
	readonly #windowsKeyProtector: WindowsKeyProtector | undefined;
	readonly #now: () => Date;
	readonly #lockTimeoutMs: number;
	readonly #queue = new SerialOperationQueue();
	#envelope: VaultEnvelope | undefined;
	#payload: VaultPayload | undefined;
	#dataKey: Buffer | undefined;

	constructor(options: EncryptedCredentialVaultOptions) {
		this.#path = resolve(options.path);
		this.#lockPath = `${this.#path}.lock`;
		this.#scope = options.scope;
		this.#platform = options.platform ?? process.platform;
		this.#windowsKeyProtector =
			options.windowsKeyProtector ?? (this.#platform === "win32" ? createPowerShellDpapiKeyProtector() : undefined);
		this.#now = options.now ?? (() => new Date());
		this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	}

	get path(): string {
		return this.#path;
	}

	get scope(): CredentialVaultScope {
		return this.#scope;
	}

	async status(): Promise<CredentialVaultStatus> {
		const envelope = this.#envelope ?? (await this.#readEnvelope(false));
		if (!envelope) {
			return {
				path: this.#path,
				scope: this.#scope,
				initialized: false,
				locked: true,
				protection: "none",
			};
		}
		return {
			path: this.#path,
			scope: this.#scope,
			initialized: true,
			locked: !this.#dataKey || !this.#payload,
			protection: envelope.keyProtections.some((entry) => entry.type === "windows-dpapi-current-user")
				? "windows"
				: "passphrase",
			generation: envelope.generation,
			updatedAt: envelope.updatedAt,
			...(this.#payload ? { credentialCount: Object.keys(this.#payload.entries).length } : {}),
		};
	}

	async initializeAndUnlock(passphrase?: string): Promise<void> {
		const existing = await this.#readEnvelope(false);
		if (existing) {
			await this.unlock(passphrase);
			return;
		}
		await this.initialize(passphrase);
	}

	async initialize(passphrase?: string): Promise<void> {
		await this.#queue.run(async () => {
			if (await this.#readEnvelope(false)) {
				throw new CredentialVaultError("VAULT_ALREADY_INITIALIZED", "Credential vault is already initialized");
			}
			const dataKey = randomBytes(KEY_BYTES);
			try {
				const keyProtections = await this.#createKeyProtections(dataKey, passphrase);
				const now = this.#now().toISOString();
				const payload: VaultPayload = { version: 1, entries: {} };
				await this.#withFileLock(async () => {
					if (await this.#readEnvelope(false)) {
						throw new CredentialVaultError(
							"VAULT_ALREADY_INITIALIZED",
							"Credential vault is already initialized",
						);
					}
					const envelope = encryptPayload(
						{
							schema: SCHEMA,
							cryptoProfile: CRYPTO_PROFILE,
							vaultId: randomUUID(),
							scope: this.#scope,
							createdAt: now,
							updatedAt: now,
							generation: 0,
							keyProtections,
						},
						payload,
						dataKey,
					);
					await writeEnvelopeAtomically(this.#path, envelope);
					this.#replaceUnlockedState(envelope, payload, dataKey);
				});
			} finally {
				dataKey.fill(0);
			}
		});
	}

	async unlock(passphrase?: string): Promise<void> {
		await this.#queue.run(async () => {
			const envelope = await this.#readEnvelope(true);
			if (!envelope) throw new CredentialVaultError("VAULT_NOT_INITIALIZED", "Credential vault is not initialized");
			const key = await this.#unwrapDataKey(envelope, passphrase);
			try {
				const payload = decryptPayload(envelope, key);
				this.#replaceUnlockedState(envelope, payload, key);
			} catch (cause) {
				throw new CredentialVaultError(
					"VAULT_UNLOCK_FAILED",
					"Credential vault could not be unlocked or authenticated",
					{ cause },
				);
			} finally {
				key.fill(0);
			}
		});
	}

	lock(): void {
		this.#dataKey?.fill(0);
		for (const entry of Object.values(this.#payload?.entries ?? {})) {
			for (const value of Object.values(entry.values)) Buffer.from(value, "utf8").fill(0);
		}
		this.#dataKey = undefined;
		this.#payload = undefined;
	}

	list(): VaultCredentialEntry[] {
		return Object.values(this.#requiredPayload().entries)
			.map(cloneEntry)
			.sort((left, right) => left.providerId.localeCompare(right.providerId));
	}

	resolve(providerId: string, names: readonly string[]): Readonly<Record<string, string>> {
		assertProviderId(providerId);
		const requested = validateEnvironmentNames(names);
		const entry = this.#requiredPayload().entries[providerId];
		if (!entry) return Object.freeze({});
		const values: Record<string, string> = {};
		for (const name of requested) {
			const value = entry.values[name];
			if (value !== undefined) values[name] = value;
		}
		return Object.freeze(values);
	}

	async replace(
		providerId: string,
		values: Readonly<Record<string, string>>,
		clear: readonly string[],
		createOnly: boolean,
	): Promise<void> {
		assertProviderId(providerId);
		const names = validateEnvironmentNames([...Object.keys(values), ...clear]);
		const clearNames = new Set(validateEnvironmentNames(clear));
		for (const name of names) {
			if (Object.hasOwn(values, name) && clearNames.has(name)) {
				throw new Error(`${name} cannot be set and cleared together`);
			}
		}
		await this.#mutate((payload, now) => {
			const existing = payload.entries[providerId];
			const nextValues = { ...(existing?.values ?? {}) };
			for (const [name, value] of Object.entries(values)) {
				if (createOnly && nextValues[name] !== undefined) throw new Error(`Credential ${name} is already stored`);
				nextValues[name] = value;
			}
			for (const name of clearNames) delete nextValues[name];
			if (Object.keys(nextValues).length === 0) {
				delete payload.entries[providerId];
				return;
			}
			payload.entries[providerId] = {
				providerId,
				values: nextValues,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				version: (existing?.version ?? 0) + 1,
			};
		});
	}

	async revoke(providerId: string, names?: readonly string[]): Promise<void> {
		assertProviderId(providerId);
		const requested = names === undefined ? undefined : validateEnvironmentNames(names);
		await this.#mutate((payload, now) => {
			const existing = payload.entries[providerId];
			if (!existing) return;
			if (requested === undefined) {
				delete payload.entries[providerId];
				return;
			}
			const values = { ...existing.values };
			for (const name of requested) delete values[name];
			if (Object.keys(values).length === 0) delete payload.entries[providerId];
			else {
				payload.entries[providerId] = {
					...existing,
					values,
					updatedAt: now,
					version: existing.version + 1,
				};
			}
		});
	}

	async #mutate(operation: (payload: VaultPayload, now: string) => void): Promise<void> {
		await this.#queue.run(async () => {
			const key = this.#requiredKey();
			await this.#withFileLock(async () => {
				const latest = await this.#readEnvelope(true);
				if (!latest) throw new CredentialVaultError("VAULT_NOT_INITIALIZED", "Credential vault is not initialized");
				let payload: VaultPayload;
				try {
					payload = decryptPayload(latest, key);
				} catch (cause) {
					throw new CredentialVaultError(
						"VAULT_UPDATE_CONFLICT",
						"Credential vault changed and must be unlocked again",
						{
							cause,
						},
					);
				}
				const now = this.#now().toISOString();
				operation(payload, now);
				const envelope = encryptPayload(
					{ ...latest, updatedAt: now, generation: latest.generation + 1 },
					payload,
					key,
				);
				await writeEnvelopeAtomically(this.#path, envelope);
				this.#replaceUnlockedState(envelope, payload, key);
			});
		});
	}

	async #createKeyProtections(dataKey: Buffer, passphrase?: string): Promise<KeyProtection[]> {
		if (this.#windowsKeyProtector) {
			return [
				{
					type: "windows-dpapi-current-user",
					wrappedKey: (await this.#windowsKeyProtector.wrap(dataKey)).toString("base64"),
				},
			];
		}
		if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
			throw new CredentialVaultError(
				"VAULT_PASSPHRASE_REQUIRED",
				`A credential vault passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters is required`,
			);
		}
		const salt = randomBytes(SALT_BYTES);
		const keyEncryptionKey = await derivePassphraseKey(passphrase, salt);
		try {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(CIPHER, keyEncryptionKey, iv, { authTagLength: TAG_BYTES });
			cipher.setAAD(Buffer.from(`${SCHEMA}\0key-wrap`, "utf8"));
			const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
			return [
				{
					type: "scrypt-passphrase",
					salt: salt.toString("base64"),
					n: 2 ** 15,
					r: 8,
					p: 3,
					iv: iv.toString("base64"),
					tag: cipher.getAuthTag().toString("base64"),
					wrappedKey: wrapped.toString("base64"),
				},
			];
		} finally {
			keyEncryptionKey.fill(0);
			salt.fill(0);
		}
	}

	async #unwrapDataKey(envelope: VaultEnvelope, passphrase?: string): Promise<Buffer> {
		const windows = envelope.keyProtections.find(
			(entry): entry is WindowsKeyProtection => entry.type === "windows-dpapi-current-user",
		);
		if (windows && this.#windowsKeyProtector) {
			try {
				return await this.#windowsKeyProtector.unwrap(decodeBase64(windows.wrappedKey, "wrapped DPAPI key"));
			} catch (cause) {
				throw new CredentialVaultError("VAULT_UNLOCK_FAILED", "Credential vault could not be unlocked", { cause });
			}
		}
		const portable = envelope.keyProtections.find(
			(entry): entry is PassphraseKeyProtection => entry.type === "scrypt-passphrase",
		);
		if (!portable || !passphrase) {
			throw new CredentialVaultError("VAULT_PASSPHRASE_REQUIRED", "Credential vault passphrase is required");
		}
		validatePassphraseProtection(portable);
		const keyEncryptionKey = await derivePassphraseKey(passphrase, decodeBase64(portable.salt, "scrypt salt"));
		try {
			const decipher = createDecipheriv(CIPHER, keyEncryptionKey, decodeBase64(portable.iv, "key-wrap IV"), {
				authTagLength: TAG_BYTES,
			});
			decipher.setAAD(Buffer.from(`${SCHEMA}\0key-wrap`, "utf8"));
			decipher.setAuthTag(decodeBase64(portable.tag, "key-wrap tag"));
			const key = Buffer.concat([
				decipher.update(decodeBase64(portable.wrappedKey, "wrapped passphrase key")),
				decipher.final(),
			]);
			if (key.byteLength !== KEY_BYTES) throw new Error("Unwrapped vault key has an invalid length");
			return key;
		} catch (cause) {
			throw new CredentialVaultError("VAULT_UNLOCK_FAILED", "Credential vault could not be unlocked", { cause });
		} finally {
			keyEncryptionKey.fill(0);
		}
	}

	#replaceUnlockedState(envelope: VaultEnvelope, payload: VaultPayload, key: Buffer): void {
		const nextKey = Buffer.from(key);
		this.#dataKey?.fill(0);
		this.#envelope = envelope;
		this.#payload = clonePayload(payload);
		this.#dataKey = nextKey;
	}

	#requiredPayload(): VaultPayload {
		if (!this.#payload) throw new CredentialVaultError("VAULT_LOCKED", "Credential vault is locked");
		return this.#payload;
	}

	#requiredKey(): Buffer {
		if (!this.#dataKey) throw new CredentialVaultError("VAULT_LOCKED", "Credential vault is locked");
		return this.#dataKey;
	}

	async #readEnvelope(required: boolean): Promise<VaultEnvelope | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.#path, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT" && !required) return undefined;
			if (isNodeError(error) && error.code === "ENOENT") {
				throw new CredentialVaultError("VAULT_NOT_INITIALIZED", "Credential vault is not initialized");
			}
			throw error;
		}
		try {
			return validateEnvelope(JSON.parse(raw) as unknown, this.#scope);
		} catch (cause) {
			if (cause instanceof CredentialVaultError) throw cause;
			throw new CredentialVaultError("VAULT_INVALID", "Credential vault envelope is invalid", { cause });
		}
	}

	async #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.#path), { recursive: true });
		const deadline = Date.now() + this.#lockTimeoutMs;
		const token = randomUUID();
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		while (!handle) {
			try {
				handle = await open(this.#lockPath, "wx", 0o600);
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: this.#now().toISOString(), token } satisfies LockRecord),
					"utf8",
				);
				await handle.sync();
			} catch (error) {
				if (!isNodeError(error) || error.code !== "EEXIST") throw error;
				await this.#removeStaleLock();
				if (Date.now() >= deadline) {
					throw new CredentialVaultError("VAULT_LOCK_TIMEOUT", "Credential vault is busy; retry shortly");
				}
				await delay(LOCK_RETRY_MS);
			}
		}
		try {
			return await operation();
		} finally {
			await handle.close().catch(() => {});
			await unlink(this.#lockPath).catch(() => {});
		}
	}

	async #removeStaleLock(): Promise<void> {
		let record: LockRecord;
		try {
			record = validateLockRecord(JSON.parse(await readFile(this.#lockPath, "utf8")) as unknown);
		} catch {
			return;
		}
		if (Date.now() - Date.parse(record.createdAt) < STALE_LOCK_MS || processExists(record.pid)) return;
		await unlink(this.#lockPath).catch(() => {});
	}
}

function encryptPayload(base: Omit<VaultEnvelope, "cipher">, payload: VaultPayload, key: Buffer): VaultEnvelope {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(envelopeAad(base));
	const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
	try {
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			...base,
			cipher: {
				algorithm: CIPHER,
				iv: iv.toString("base64"),
				tag: cipher.getAuthTag().toString("base64"),
				ciphertext: ciphertext.toString("base64"),
			},
		};
	} finally {
		plaintext.fill(0);
		iv.fill(0);
	}
}

function decryptPayload(envelope: VaultEnvelope, key: Buffer): VaultPayload {
	const decipher = createDecipheriv(CIPHER, key, decodeBase64(envelope.cipher.iv, "vault IV"), {
		authTagLength: TAG_BYTES,
	});
	decipher.setAAD(envelopeAad(envelope));
	decipher.setAuthTag(decodeBase64(envelope.cipher.tag, "vault tag"));
	const plaintext = Buffer.concat([
		decipher.update(decodeBase64(envelope.cipher.ciphertext, "vault ciphertext")),
		decipher.final(),
	]);
	try {
		return validatePayload(JSON.parse(plaintext.toString("utf8")) as unknown);
	} finally {
		plaintext.fill(0);
	}
}

function envelopeAad(envelope: Omit<VaultEnvelope, "cipher"> | VaultEnvelope): Buffer {
	return Buffer.from(
		JSON.stringify({
			schema: envelope.schema,
			cryptoProfile: envelope.cryptoProfile,
			vaultId: envelope.vaultId,
			scope: envelope.scope,
			createdAt: envelope.createdAt,
			updatedAt: envelope.updatedAt,
			generation: envelope.generation,
			keyProtections: envelope.keyProtections,
		}),
		"utf8",
	);
}

async function writeEnvelopeAtomically(path: string, envelope: VaultEnvelope): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = resolve(dirname(path), `.${randomUUID()}.vault.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(envelope, null, 2)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temporary, path);
		if (process.platform !== "win32") await chmod(path, 0o600);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

function validateEnvelope(value: unknown, scope: CredentialVaultScope): VaultEnvelope {
	const record = object(value, "credential vault envelope");
	if (record.schema !== SCHEMA || record.cryptoProfile !== CRYPTO_PROFILE) {
		throw new CredentialVaultError("VAULT_INVALID", "Credential vault schema or crypto profile is unsupported");
	}
	if (record.scope !== scope) throw new CredentialVaultError("VAULT_INVALID", "Credential vault scope is invalid");
	const keyProtections = array(record.keyProtections, "keyProtections").map(validateKeyProtection);
	if (keyProtections.length === 0)
		throw new CredentialVaultError("VAULT_INVALID", "Credential vault has no key protection");
	const cipher = object(record.cipher, "cipher");
	if (cipher.algorithm !== CIPHER)
		throw new CredentialVaultError("VAULT_INVALID", "Credential vault cipher is unsupported");
	const envelope: VaultEnvelope = {
		schema: SCHEMA,
		cryptoProfile: CRYPTO_PROFILE,
		vaultId: identifier(record.vaultId, "vaultId"),
		scope,
		createdAt: timestamp(record.createdAt, "createdAt"),
		updatedAt: timestamp(record.updatedAt, "updatedAt"),
		generation: nonNegativeInteger(record.generation, "generation"),
		keyProtections,
		cipher: {
			algorithm: CIPHER,
			iv: base64(recordValue(cipher, "iv"), "cipher.iv", IV_BYTES),
			tag: base64(recordValue(cipher, "tag"), "cipher.tag", TAG_BYTES),
			ciphertext: base64(recordValue(cipher, "ciphertext"), "cipher.ciphertext"),
		},
	};
	return envelope;
}

function validateKeyProtection(value: unknown): KeyProtection {
	const record = object(value, "key protection");
	if (record.type === "windows-dpapi-current-user") {
		return {
			type: record.type,
			wrappedKey: base64(record.wrappedKey, "wrappedKey"),
		};
	}
	if (record.type !== "scrypt-passphrase") {
		throw new CredentialVaultError("VAULT_INVALID", "Credential vault key protection is unsupported");
	}
	const protection: PassphraseKeyProtection = {
		type: record.type,
		salt: base64(record.salt, "salt", SALT_BYTES),
		n: nonNegativeInteger(record.n, "n"),
		r: nonNegativeInteger(record.r, "r"),
		p: nonNegativeInteger(record.p, "p"),
		iv: base64(record.iv, "iv", IV_BYTES),
		tag: base64(record.tag, "tag", TAG_BYTES),
		wrappedKey: base64(record.wrappedKey, "wrappedKey", KEY_BYTES),
	};
	validatePassphraseProtection(protection);
	return protection;
}

function validatePassphraseProtection(value: PassphraseKeyProtection): void {
	if (value.n !== 2 ** 15 || value.r !== 8 || value.p !== 3) {
		throw new CredentialVaultError("VAULT_INVALID", "Credential vault scrypt parameters are unsupported");
	}
}

function validatePayload(value: unknown): VaultPayload {
	const record = object(value, "vault payload");
	if (record.version !== 1) throw new CredentialVaultError("VAULT_INVALID", "Credential vault payload is unsupported");
	const rawEntries = object(record.entries, "vault entries");
	const entries: Record<string, VaultCredentialEntry> = {};
	for (const [providerId, rawEntry] of Object.entries(rawEntries)) {
		assertProviderId(providerId);
		const entry = object(rawEntry, `credential ${providerId}`);
		if (entry.providerId !== providerId)
			throw new CredentialVaultError("VAULT_INVALID", "Credential provider mismatch");
		const rawValues = object(entry.values, `credential ${providerId} values`);
		const values: Record<string, string> = {};
		for (const [name, rawValue] of Object.entries(rawValues)) {
			validateEnvironmentNames([name]);
			if (typeof rawValue !== "string")
				throw new CredentialVaultError("VAULT_INVALID", "Credential value is invalid");
			values[name] = rawValue;
		}
		entries[providerId] = {
			providerId,
			values,
			createdAt: timestamp(entry.createdAt, "entry.createdAt"),
			updatedAt: timestamp(entry.updatedAt, "entry.updatedAt"),
			version: nonNegativeInteger(entry.version, "entry.version"),
		};
	}
	return { version: 1, entries };
}

function clonePayload(payload: VaultPayload): VaultPayload {
	return {
		version: 1,
		entries: Object.fromEntries(Object.entries(payload.entries).map(([id, entry]) => [id, cloneEntry(entry)])),
	};
}

function cloneEntry(entry: VaultCredentialEntry): VaultCredentialEntry {
	return { ...entry, values: { ...entry.values } };
}

function validateEnvironmentNames(names: readonly string[]): string[] {
	if (!Array.isArray(names) || names.length > 128) throw new Error("Credential names are invalid");
	const normalized = [...new Set(names)];
	for (const name of normalized) {
		if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
			throw new Error("Credential names must use uppercase environment-style identifiers");
		}
	}
	return normalized;
}

function assertProviderId(providerId: string): void {
	if (typeof providerId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(providerId)) {
		throw new Error("Credential provider ID is invalid");
	}
}

function validateLockRecord(value: unknown): LockRecord {
	const record = object(value, "vault lock");
	return {
		pid: nonNegativeInteger(record.pid, "pid"),
		createdAt: timestamp(record.createdAt, "createdAt"),
		token: identifier(record.token, "token"),
	};
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error) && error.code === "EPERM";
	}
}

function createPowerShellDpapiKeyProtector(): WindowsKeyProtector {
	return {
		wrap: (key) => runDpapi("Protect", key),
		unwrap: (value) => runDpapi("Unprotect", value),
	};
}

async function runDpapi(operation: "Protect" | "Unprotect", input: Buffer): Promise<Buffer> {
	const script = [
		"$ErrorActionPreference='Stop'",
		"Add-Type -AssemblyName System.Security",
		"$raw=[Console]::In.ReadToEnd()",
		"$bytes=[Convert]::FromBase64String($raw)",
		`$result=[Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)`,
		"[Console]::Out.Write([Convert]::ToBase64String($result))",
	].join(";");
	const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		env: dpapiEnvironment(),
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout = `${stdout}${chunk}`.slice(-65_536);
	});
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-4_096);
	});
	child.stdin.end(input.toString("base64"));
	const exitCode = await new Promise<number>((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => resolveExit(code ?? 1));
	});
	if (exitCode !== 0) throw new Error(`Windows credential protection failed${stderr ? `: ${stderr.trim()}` : ""}`);
	const result = decodeBase64(stdout.trim(), "DPAPI result");
	if (operation === "Unprotect" && result.byteLength !== KEY_BYTES) {
		result.fill(0);
		throw new Error("Windows credential protection returned an invalid key");
	}
	return result;
}

function dpapiEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "TEMP", "TMP", "WINDIR"]) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function derivePassphraseKey(passphrase: string, salt: Buffer): Promise<Buffer> {
	return new Promise((resolveKey, reject) => {
		scryptCallback(
			passphrase,
			salt,
			KEY_BYTES,
			{ N: 2 ** 15, r: 8, p: 3, maxmem: 128 * 1024 * 1024 },
			(error, key) => {
				if (error) reject(error);
				else resolveKey(Buffer.from(key));
			},
		);
	});
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value;
}

function recordValue(record: Record<string, unknown>, name: string): unknown {
	return record[name];
}

function identifier(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

function timestamp(value: unknown, name: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
	return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} is invalid`);
	return Number(value);
}

function base64(value: unknown, name: string, expectedBytes?: number): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(`${name} is invalid`);
	const decoded = Buffer.from(value, "base64");
	if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
		throw new Error(`${name} has an invalid length`);
	return value;
}

function decodeBase64(value: string, name: string): Buffer {
	base64(value, name);
	return Buffer.from(value, "base64");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
