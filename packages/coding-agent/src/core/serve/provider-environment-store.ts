import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProviderAuthenticationManifest, ProviderConfigurationField } from "./capability-broker.ts";
import type { CredentialMetadata, CredentialReplaceRequest, CredentialStore } from "./credential-store.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface ProviderEnvironmentUpdate {
	values?: Record<string, string>;
	clear?: string[];
}

export interface ProviderEnvironmentStatus {
	providerId: string;
	kind: "environment" | "oauth2";
	configured: boolean;
	fields: Array<ProviderConfigurationField & { configured: boolean }>;
}

/** Owns write-only provider configuration in one project-local environment file. */
export class ProviderEnvironmentStore implements CredentialStore {
	readonly #path: string;
	readonly #manifest: (providerId: string) => ProviderAuthenticationManifest | undefined;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #queue = new SerialOperationQueue();

	constructor(
		projectRoot: string,
		manifest: (providerId: string) => ProviderAuthenticationManifest | undefined,
		environment: NodeJS.ProcessEnv = process.env,
	) {
		const root = resolve(projectRoot);
		this.#path = resolve(root, ".env.local");
		if (dirname(this.#path) !== root) throw new Error("Provider environment file must remain in the project root");
		this.#manifest = manifest;
		this.#environment = environment;
		this.#loadPersistedEnvironment();
	}

	async status(providerId: string): Promise<ProviderEnvironmentStatus> {
		const manifest = this.#requiredManifest(providerId);
		const fields = manifest.fields.map((field) => ({
			...field,
			configured: Boolean(this.#environment[field.env]?.trim()),
		}));
		return {
			providerId,
			kind: manifest.kind,
			configured: fields.filter((field) => field.required).every((field) => field.configured),
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
		assertProviderId(providerId);
		const fields = new Set(this.#requiredManifest(providerId).fields.map((field) => field.env));
		const requested = validateNames(names);
		const resolved: Record<string, string> = {};
		for (const name of requested) {
			if (!fields.has(name)) throw new Error(`Provider ${providerId} does not declare ${name}`);
			const value = this.#environment[name]?.trim();
			if (value) resolved[name] = value;
		}
		return Object.freeze(resolved);
	}

	async revoke(providerId: string, names?: readonly string[]): Promise<CredentialMetadata> {
		const manifest = this.#requiredManifest(providerId);
		const revoke = names === undefined ? manifest.fields.map((field) => field.env) : validateNames(names);
		await this.#configure(providerId, { clear: revoke }, true, false);
		return this.metadata(providerId);
	}

	async metadata(providerId: string): Promise<CredentialMetadata> {
		assertProviderId(providerId);
		const status = await this.status(providerId);
		return {
			reference: `managed:project-environment/${providerId}`,
			providerId,
			storage: "project-environment",
			configured: status.configured,
			entries: status.fields.map((field) => ({ name: field.env, configured: field.configured })),
		};
	}

	async #configure(
		providerId: string,
		update: ProviderEnvironmentUpdate,
		allowManagedFields: boolean,
		createOnly: boolean,
	): Promise<ProviderEnvironmentStatus> {
		return this.#queue.run(async () => {
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
			const normalizedValues = new Map<string, string>();
			for (const [name, value] of Object.entries(values)) {
				if (createOnly && this.#environment[name]?.trim()) throw new Error(`Credential ${name} is already stored`);
				normalizedValues.set(name, validateValue(fields.get(name)!, value));
			}

			let existing = "";
			try {
				existing = await readFile(this.#path, "utf8");
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			}
			const newline = existing.includes("\r\n") ? "\r\n" : "\n";
			const trailingNewline = existing.length === 0 || /\r?\n$/.test(existing);
			const seen = new Set<string>();
			const output: string[] = [];
			for (const line of existing.split(/\r?\n/)) {
				const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
				const name = match?.[1];
				if (!name || (!normalizedValues.has(name) && !clear.has(name))) {
					output.push(line);
					continue;
				}
				if (seen.has(name) || clear.has(name)) continue;
				output.push(`${name}=${quoteValue(normalizedValues.get(name)!)}`);
				seen.add(name);
			}
			while (output.length > 0 && output[output.length - 1] === "") output.pop();
			for (const [name, value] of normalizedValues) {
				if (!seen.has(name)) output.push(`${name}=${quoteValue(value)}`);
			}
			const contents = output.length === 0 ? "" : `${output.join(newline)}${trailingNewline ? newline : ""}`;
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = resolve(dirname(this.#path), `..env.local.${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
				await rename(temporary, this.#path);
			} finally {
				await rm(temporary, { force: true });
			}
			for (const name of clear) delete this.#environment[name];
			for (const [name, value] of normalizedValues) this.#environment[name] = value;
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

	#loadPersistedEnvironment(): void {
		let contents: string;
		try {
			contents = readFileSync(this.#path, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
		for (const line of contents.split(/\r?\n/)) {
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
			if (!match) continue;
			const name = match[1]!;
			if (isDangerousEnvironmentName(name)) continue;
			const value = parseStoredValue(match[2]!);
			if (value !== undefined) this.#environment[name] = value;
		}
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
	if (values === null || typeof values !== "object" || Array.isArray(values)) {
		throw new Error("Credential values must be an object");
	}
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
	return normalized;
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

function quoteValue(value: string): string {
	return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
