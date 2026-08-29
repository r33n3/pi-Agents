import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ProviderAuthenticationManifest, ProviderConfigurationField } from "./capability-broker.ts";
import type { CredentialMetadata, CredentialReplaceRequest, CredentialStore } from "./credential-store.ts";
import {
	CredentialVaultError,
	type CredentialVaultStatus,
	EncryptedCredentialVault,
	type WindowsKeyProtector,
} from "./encrypted-credential-vault.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface ProviderEnvironmentUpdate {
	values?: Record<string, string>;
	clear?: string[];
}

export interface ProviderEnvironmentStatus {
	providerId: string;
	kind: "environment" | "oauth2" | "plaid-link";
	configured: boolean;
	storage: "encrypted-user-vault" | "legacy-environment" | "mixed" | "none";
	fields: Array<ProviderConfigurationField & { configured: boolean; value?: string; source?: "vault" | "legacy" }>;
}

export interface LegacyCredentialField {
	providerId: string;
	name: string;
	secret: boolean;
	sourceName: string;
}

export interface LegacyCredentialMigrationStatus {
	path: string;
	configuredFields: LegacyCredentialField[];
	migratedFields: LegacyCredentialField[];
	unmanagedNames: string[];
}

export interface CredentialVaultManagementStatus {
	vault: CredentialVaultStatus;
	legacy: LegacyCredentialMigrationStatus;
}

export interface ProviderEnvironmentStoreOptions {
	environment?: NodeJS.ProcessEnv;
	vaultPath?: string;
	platform?: NodeJS.Platform;
	windowsKeyProtector?: WindowsKeyProtector;
	passphrase?: string;
	onProviderChanged?: (providerId: string, values: Readonly<Record<string, string>>) => Promise<void>;
}

const LEGACY_ALIASES: Readonly<Record<string, readonly string[]>> = {
	ANTHROPIC_API_KEY: ["ANTHROPIC_API_KEY", "ANTHROPIC_PLATFORM_API"],
	OPENAI_API_KEY: ["OPENAI_API_KEY", "OPENAI_PLATFORM_API"],
};

/**
 * Owns provider configuration behind an encrypted vault while retaining a
 * read-only `.env.local` migration path. The historical class name is kept so
 * provider and browser APIs do not gain storage knowledge.
 */
export class ProviderEnvironmentStore implements CredentialStore {
	readonly #projectRoot: string;
	readonly #legacyPath: string;
	readonly #manifest: (providerId: string) => ProviderAuthenticationManifest | undefined;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #platform: NodeJS.Platform;
	readonly #vault: EncryptedCredentialVault;
	readonly #passphrase: string | undefined;
	readonly #onProviderChanged:
		| ((providerId: string, values: Readonly<Record<string, string>>) => Promise<void>)
		| undefined;
	readonly #queue = new SerialOperationQueue();
	readonly #vaultValues = new Map<string, Readonly<Record<string, string>>>();
	#legacyValues: Readonly<Record<string, string>> = Object.freeze({});
	#initialized = false;
	#vaultInitialized = false;
	#vaultLocked = true;

	constructor(
		projectRoot: string,
		manifest: (providerId: string) => ProviderAuthenticationManifest | undefined,
		options: ProviderEnvironmentStoreOptions = {},
	) {
		this.#projectRoot = resolve(projectRoot);
		this.#legacyPath = resolve(this.#projectRoot, ".env.local");
		if (dirname(this.#legacyPath) !== this.#projectRoot) {
			throw new Error("Legacy provider environment file must remain in the project root");
		}
		this.#manifest = manifest;
		this.#environment = options.environment ?? process.env;
		this.#platform = options.platform ?? process.platform;
		this.#passphrase = options.passphrase;
		this.#onProviderChanged = options.onProviderChanged;
		this.#vault = new EncryptedCredentialVault({
			path: options.vaultPath ?? join(this.#projectRoot, ".pi", "vault", "credentials.v1.json"),
			scope: options.vaultPath ? "user" : "workspace",
			platform: this.#platform,
			windowsKeyProtector: options.windowsKeyProtector,
		});
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		this.#legacyValues = Object.freeze(await readEnvironmentFile(this.#legacyPath));
		const vaultStatus = await this.#vault.status();
		this.#vaultInitialized = vaultStatus.initialized;
		this.#vaultLocked = vaultStatus.locked;
		try {
			if (vaultStatus.initialized) await this.#vault.unlock(this.#passphrase);
			else if (this.#platform === "win32" || this.#passphrase) await this.#vault.initialize(this.#passphrase);
		} catch (error) {
			if (!(error instanceof CredentialVaultError) || error.code !== "VAULT_PASSPHRASE_REQUIRED") throw error;
		}
		const initializedStatus = await this.#vault.status();
		this.#vaultInitialized = initializedStatus.initialized;
		this.#vaultLocked = initializedStatus.locked;
		this.#refreshVaultValues();
		this.#initialized = true;
		for (const providerId of this.#vaultValues.keys()) {
			if (!this.#manifest(providerId)) continue;
			const values = this.#vaultValues.get(providerId) ?? this.#legacyProviderValues(providerId);
			if (Object.keys(values).length > 0) await this.#onProviderChanged?.(providerId, values);
		}
	}

	environmentValue(name: string): string | undefined {
		assertSafeEnvironmentName(name);
		if (this.#vaultInitialized && this.#vaultLocked) return undefined;
		for (const values of this.#vaultValues.values()) {
			const value = values[name]?.trim();
			if (value) return value;
		}
		return legacyValue(this.#legacyValues, this.#environment, name);
	}

	async managementStatus(providerIds: readonly string[]): Promise<CredentialVaultManagementStatus> {
		await this.initialize();
		return { vault: await this.#vault.status(), legacy: this.#legacyMigrationStatus(providerIds) };
	}

	async initializeVault(passphrase?: string): Promise<CredentialVaultStatus> {
		await this.initialize();
		const status = await this.#vault.status();
		if (!status.initialized) await this.#vault.initialize(passphrase);
		else if (status.locked) await this.#vault.unlock(passphrase);
		this.#vaultInitialized = true;
		this.#vaultLocked = false;
		this.#refreshVaultValues();
		return this.#vault.status();
	}

	async unlockVault(passphrase?: string): Promise<CredentialVaultStatus> {
		await this.initialize();
		await this.#vault.unlock(passphrase);
		this.#vaultInitialized = true;
		this.#vaultLocked = false;
		this.#refreshVaultValues();
		return this.#vault.status();
	}

	async lockVault(): Promise<CredentialVaultStatus> {
		await this.initialize();
		this.#vault.lock();
		this.#vaultLocked = true;
		this.#vaultValues.clear();
		return this.#vault.status();
	}

	async migrateLegacy(providerIds: readonly string[]): Promise<CredentialVaultManagementStatus> {
		await this.initialize();
		this.#assertUnlocked();
		for (const providerId of [...new Set(providerIds)]) {
			const manifest = this.#requiredManifest(providerId);
			const values: Record<string, string> = {};
			for (const field of manifest.fields) {
				const value = legacyFileValue(this.#legacyValues, field.env);
				if (value) values[field.env] = validateValue(field, value);
			}
			if (Object.keys(values).length === 0) continue;
			await this.#vault.replace(providerId, values, [], false);
			this.#refreshVaultValues();
			await this.#notifyProviderChanged(providerId);
		}
		return this.managementStatus(providerIds);
	}

	async removeMigratedLegacy(providerIds: readonly string[]): Promise<CredentialVaultManagementStatus> {
		await this.initialize();
		this.#assertUnlocked();
		const removeNames = new Set<string>();
		for (const providerId of [...new Set(providerIds)]) {
			const configured = this.#vaultValues.get(providerId) ?? {};
			for (const field of this.#requiredManifest(providerId).fields) {
				if (!configured[field.env]) continue;
				for (const sourceName of sourceNames(field.env)) removeNames.add(sourceName);
			}
		}
		if (removeNames.size > 0) await removeEnvironmentAssignments(this.#legacyPath, removeNames);
		this.#legacyValues = Object.freeze(await readEnvironmentFile(this.#legacyPath));
		return this.managementStatus(providerIds);
	}

	async status(providerId: string): Promise<ProviderEnvironmentStatus> {
		await this.initialize();
		const manifest = this.#requiredManifest(providerId);
		const vaultValues = this.#vaultValues.get(providerId);
		const fields = manifest.fields.map((field) => {
			const vaultValue = vaultValues?.[field.env]?.trim();
			const legacy =
				this.#vaultInitialized && this.#vaultLocked
					? undefined
					: vaultValues
						? undefined
						: legacyValue(this.#legacyValues, this.#environment, field.env)?.trim();
			const value = vaultValue ?? legacy;
			return {
				...field,
				configured: Boolean(value),
				...(value ? { source: vaultValue ? ("vault" as const) : ("legacy" as const) } : {}),
				...(field.secret || !value ? {} : { value }),
			};
		});
		const sources = new Set(fields.map((field) => field.source).filter(Boolean));
		return {
			providerId,
			kind: manifest.kind,
			configured: fields.filter((field) => field.required).every((field) => field.configured),
			storage:
				sources.size > 1
					? "mixed"
					: sources.has("vault")
						? "encrypted-user-vault"
						: sources.has("legacy")
							? "legacy-environment"
							: "none",
			fields,
		};
	}

	async configure(providerId: string, update: ProviderEnvironmentUpdate): Promise<ProviderEnvironmentStatus> {
		return this.#configure(providerId, update, false, false);
	}

	/** Writes provider-owned values such as OAuth tokens. Never expose this operation through a generic configuration API. */
	async configureManaged(providerId: string, update: ProviderEnvironmentUpdate): Promise<ProviderEnvironmentStatus> {
		return this.#configure(providerId, update, true, false);
	}

	async store(providerId: string, values: Readonly<Record<string, string>>): Promise<CredentialMetadata> {
		assertCredentialValues(values, false);
		await this.#configure(providerId, { values: { ...values } }, true, true);
		return this.metadata(providerId);
	}

	async replace(providerId: string, request: CredentialReplaceRequest): Promise<CredentialMetadata> {
		if (request === null || typeof request !== "object" || Array.isArray(request)) {
			throw new Error("Credential replacement must be an object");
		}
		assertCredentialValues(request.values ?? {}, request.revoke !== undefined);
		await this.#configure(
			providerId,
			{
				values: request.values === undefined ? undefined : { ...request.values },
				clear: [...(request.revoke ?? [])],
			},
			true,
			false,
		);
		return this.metadata(providerId);
	}

	async resolveTrusted(providerId: string, names: readonly string[]): Promise<Readonly<Record<string, string>>> {
		await this.initialize();
		if (this.#vaultInitialized && this.#vaultLocked) this.#assertUnlocked();
		assertProviderId(providerId);
		const fields = new Set(this.#requiredManifest(providerId).fields.map((field) => field.env));
		const requested = validateNames(names);
		for (const name of requested) {
			if (!fields.has(name)) throw new Error(`Provider ${providerId} does not declare ${name}`);
		}
		const vaultValues = this.#vaultValues.get(providerId);
		if (vaultValues) return this.#vault.resolve(providerId, requested);
		const resolved: Record<string, string> = {};
		for (const name of requested) {
			const value = legacyValue(this.#legacyValues, this.#environment, name)?.trim();
			if (value) resolved[name] = value;
		}
		return Object.freeze(resolved);
	}

	async revoke(providerId: string, names?: readonly string[]): Promise<CredentialMetadata> {
		await this.initialize();
		this.#assertUnlocked();
		const manifest = this.#requiredManifest(providerId);
		const revoke = names === undefined ? manifest.fields.map((field) => field.env) : validateNames(names);
		for (const name of revoke) {
			if (!manifest.fields.some((field) => field.env === name))
				throw new Error(`Provider ${providerId} does not declare ${name}`);
		}
		await this.#vault.revoke(providerId, revoke);
		this.#refreshVaultValues();
		await this.#notifyProviderChanged(providerId);
		return this.metadata(providerId);
	}

	async metadata(providerId: string): Promise<CredentialMetadata> {
		assertProviderId(providerId);
		const status = await this.status(providerId);
		return {
			reference: `vault:user/${providerId}`,
			providerId,
			storage: status.storage,
			configured: status.configured,
			entries: status.fields.map((field) => ({ name: field.env, configured: field.configured })),
		};
	}

	async dispose(): Promise<void> {
		this.#vault.lock();
		this.#vaultValues.clear();
	}

	async #configure(
		providerId: string,
		update: ProviderEnvironmentUpdate,
		allowManagedFields: boolean,
		createOnly: boolean,
	): Promise<ProviderEnvironmentStatus> {
		return this.#queue.run(async () => {
			await this.initialize();
			this.#assertUnlocked();
			assertProviderId(providerId);
			const manifest = this.#requiredManifest(providerId);
			const fields = new Map(
				manifest.fields
					.filter((field) => allowManagedFields || field.operatorEditable !== false)
					.map((field) => [field.env, field]),
			);
			if (update === null || typeof update !== "object" || Array.isArray(update)) {
				throw new Error("Credential update must be an object");
			}
			const values = update.values ?? {};
			if (values === null || typeof values !== "object" || Array.isArray(values)) {
				throw new Error("Credential values must be an object");
			}
			const clear = new Set(validateNames(update.clear ?? []));
			for (const name of [...Object.keys(values), ...clear]) {
				if (!fields.has(name)) throw new Error(`Provider ${providerId} does not declare ${name}`);
			}
			for (const name of clear) {
				if (Object.hasOwn(values, name)) throw new Error(`${name} cannot be set and cleared together`);
			}
			const normalizedValues: Record<string, string> = {};
			if (!this.#vaultValues.has(providerId)) {
				for (const field of manifest.fields) {
					const legacy = legacyValue(this.#legacyValues, this.#environment, field.env)?.trim();
					if (legacy) normalizedValues[field.env] = validateValue(field, legacy);
				}
			}
			for (const [name, value] of Object.entries(values))
				normalizedValues[name] = validateValue(fields.get(name)!, value);
			await this.#vault.replace(providerId, normalizedValues, [...clear], createOnly);
			this.#refreshVaultValues();
			await this.#notifyProviderChanged(providerId);
			return this.status(providerId);
		});
	}

	#requiredManifest(providerId: string): ProviderAuthenticationManifest {
		assertProviderId(providerId);
		const manifest = this.#manifest(providerId);
		if (!manifest) throw new Error(`Provider ${providerId} does not declare configurable authentication`);
		for (const field of manifest.fields) assertSafeEnvironmentName(field.env);
		return manifest;
	}

	#assertUnlocked(): void {
		try {
			this.#vault.list();
		} catch (error) {
			if (error instanceof CredentialVaultError && error.code === "VAULT_LOCKED") {
				throw new CredentialVaultError(
					"VAULT_LOCKED",
					"Credential vault is locked; unlock it in Settings > Security",
				);
			}
			throw error;
		}
	}

	#refreshVaultValues(): void {
		this.#vaultValues.clear();
		try {
			for (const entry of this.#vault.list())
				this.#vaultValues.set(entry.providerId, Object.freeze({ ...entry.values }));
		} catch (error) {
			if (!(error instanceof CredentialVaultError) || error.code !== "VAULT_LOCKED") throw error;
		}
	}

	#legacyMigrationStatus(providerIds: readonly string[]): LegacyCredentialMigrationStatus {
		const configuredFields: LegacyCredentialField[] = [];
		const migratedFields: LegacyCredentialField[] = [];
		const managedSourceNames = new Set<string>();
		for (const providerId of [...new Set(providerIds)]) {
			const manifest = this.#manifest(providerId);
			if (!manifest) continue;
			const vaultValues = this.#vaultValues.get(providerId) ?? {};
			for (const field of manifest.fields) {
				for (const name of sourceNames(field.env)) managedSourceNames.add(name);
				const sourceName = sourceNames(field.env).find((name) => Boolean(this.#legacyValues[name]?.trim()));
				if (!sourceName) continue;
				const row = { providerId, name: field.env, secret: field.secret, sourceName };
				configuredFields.push(row);
				if (vaultValues[field.env]?.trim()) migratedFields.push(row);
			}
		}
		return {
			path: this.#legacyPath,
			configuredFields,
			migratedFields,
			unmanagedNames: Object.keys(this.#legacyValues)
				.filter((name) => !managedSourceNames.has(name))
				.sort(),
		};
	}

	#legacyProviderValues(providerId: string): Readonly<Record<string, string>> {
		const manifest = this.#manifest(providerId);
		if (!manifest) return Object.freeze({});
		const values: Record<string, string> = {};
		for (const field of manifest.fields) {
			const value = legacyValue(this.#legacyValues, this.#environment, field.env)?.trim();
			if (value) values[field.env] = value;
		}
		return Object.freeze(values);
	}

	async #notifyProviderChanged(providerId: string): Promise<void> {
		if (this.#onProviderChanged) await this.#onProviderChanged(providerId, this.#vaultValues.get(providerId) ?? {});
	}
}

function assertProviderId(providerId: string): void {
	if (typeof providerId !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(providerId)) {
		throw new Error("Credential provider ID is invalid");
	}
}

function validateNames(names: readonly string[]): string[] {
	if (!Array.isArray(names) || names.length > 64)
		throw new Error("Credential names must be an array of at most 64 entries");
	const normalized = [...new Set(names)];
	for (const name of normalized) {
		if (typeof name !== "string") throw new Error("Credential names must be strings");
		assertSafeEnvironmentName(name);
	}
	return normalized;
}

function assertCredentialValues(values: Readonly<Record<string, string>>, allowEmpty: boolean): void {
	if (values === null || typeof values !== "object" || Array.isArray(values))
		throw new Error("Credential values must be an object");
	if (!allowEmpty && Object.keys(values).length === 0) throw new Error("At least one credential value is required");
}

function validateValue(field: ProviderConfigurationField, value: string): string {
	assertSafeEnvironmentName(field.env);
	if (typeof value !== "string") throw new Error(`${field.env} must be a string`);
	if (value.length > 16_384) throw new Error(`${field.env} exceeds the maximum length`);
	if (/[\0\r\n]/.test(value)) throw new Error(`${field.env} must be a single-line value`);
	const normalized = value.trim();
	if (field.required && normalized === "") throw new Error(`${field.env} is required`);
	if (field.format === "url" && normalized !== "") {
		const url = new URL(normalized);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
			throw new Error(`${field.env} must be an HTTP(S) URL without embedded credentials`);
		}
	}
	if (field.options && normalized !== "" && !field.options.some((option) => option.value === normalized)) {
		throw new Error(`${field.env} must be one of: ${field.options.map((option) => option.value).join(", ")}`);
	}
	return normalized;
}

function assertSafeEnvironmentName(name: string): void {
	if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || isDangerousEnvironmentName(name)) {
		throw new Error(`Provider environment field ${name} is not allowed`);
	}
}

function isDangerousEnvironmentName(name: string): boolean {
	return (
		new Set([
			"BASH_ENV",
			"CDPATH",
			"COMSPEC",
			"ELECTRON_RUN_AS_NODE",
			"ENV",
			"HOME",
			"IFS",
			"NODE_OPTIONS",
			"NODE_PATH",
			"PATH",
			"PATHEXT",
			"PERL5OPT",
			"PYTHONHOME",
			"PYTHONPATH",
			"RUBYOPT",
			"SHELL",
			"SYSTEMROOT",
			"TEMP",
			"TMP",
			"USERPROFILE",
			"WINDIR",
		]).has(name) ||
		name.startsWith("DYLD_") ||
		name.startsWith("GIT_CONFIG_") ||
		name.startsWith("LD_") ||
		name.startsWith("NPM_CONFIG_")
	);
}

async function readEnvironmentFile(path: string): Promise<Record<string, string>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return {};
		throw error;
	}
	const values: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match || isDangerousEnvironmentName(match[1]!)) continue;
		const value = parseStoredValue(match[2]!);
		if (value !== undefined) values[match[1]!] = value;
	}
	return values;
}

function parseStoredValue(value: string): string | undefined {
	if (value.startsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" && !/[\0\r\n]/.test(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		const parsed = value.slice(1, -1);
		return /[\0\r\n]/.test(parsed) ? undefined : parsed;
	}
	return /[\0\r\n]/.test(value) ? undefined : value;
}

function sourceNames(name: string): readonly string[] {
	return LEGACY_ALIASES[name] ?? [name];
}

function legacyFileValue(values: Readonly<Record<string, string>>, name: string): string | undefined {
	for (const sourceName of sourceNames(name)) {
		const value = values[sourceName]?.trim();
		if (value) return value;
	}
	return undefined;
}

function legacyValue(
	values: Readonly<Record<string, string>>,
	environment: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	return (
		legacyFileValue(values, name) ??
		sourceNames(name)
			.map((entry) => environment[entry]?.trim())
			.find(Boolean)
	);
}

async function removeEnvironmentAssignments(path: string, names: ReadonlySet<string>): Promise<void> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return;
		throw error;
	}
	const newline = raw.includes("\r\n") ? "\r\n" : "\n";
	const trailingNewline = /\r?\n$/.test(raw);
	const output = raw.split(/\r?\n/).filter((line) => {
		const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		return !match || !names.has(match[1]!);
	});
	while (output.length > 0 && output[output.length - 1] === "") output.pop();
	const next = output.length === 0 ? "" : `${output.join(newline)}${trailingNewline ? newline : ""}`;
	const temporary = resolve(dirname(path), `..env.local.vault-migration.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
