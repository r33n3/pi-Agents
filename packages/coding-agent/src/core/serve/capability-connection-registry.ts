import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type CapabilityConnectionStatus = "active" | "unhealthy" | "revoked";

export interface CapabilityConnectionProfile {
	id: string;
	providerId: string;
	accountLabel: string;
	secretRef: string;
	scopes: string[];
	capabilityIds: string[];
	status: CapabilityConnectionStatus;
	createdAt: string;
	updatedAt: string;
	revokedAt?: string;
}

export type CapabilityConnectionInput = Omit<
	CapabilityConnectionProfile,
	"id" | "status" | "createdAt" | "updatedAt" | "revokedAt"
> & { id?: string; status?: Exclude<CapabilityConnectionStatus, "revoked"> };

/** Persists provider account metadata while keeping credential values in an external secret store. */
export class CapabilityConnectionRegistry {
	readonly #directory: string;
	readonly #queue = new SerialOperationQueue();
	readonly #profiles = new Map<string, CapabilityConnectionProfile>();
	#initialized = false;

	constructor(directory: string) {
		this.#directory = resolve(directory);
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(this.#directory, { recursive: true });
		const files = (await readdir(this.#directory)).filter((file) => file.endsWith(".json")).sort();
		for (const file of files) {
			const profile = await this.#read(resolve(this.#directory, file));
			this.#profiles.set(profile.id, profile);
		}
		this.#initialized = true;
	}

	async list(): Promise<CapabilityConnectionProfile[]> {
		await this.initialize();
		return this.snapshot();
	}

	snapshot(): CapabilityConnectionProfile[] {
		return [...this.#profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
	}

	find(id: string): CapabilityConnectionProfile | undefined {
		return this.#profiles.get(id);
	}

	async get(id: string): Promise<CapabilityConnectionProfile | undefined> {
		assertIdentifier(id, "connection id");
		await this.initialize();
		return this.#profiles.get(id);
	}

	async save(input: CapabilityConnectionInput): Promise<CapabilityConnectionProfile> {
		return this.#queue.run(async () => {
			await this.initialize();
			const id = input.id ?? slugify(`${input.providerId}-${input.accountLabel}`);
			assertIdentifier(id, "connection id");
			const existing = await this.get(id);
			if (existing?.status === "revoked") throw new Error(`Connection ${id} is revoked and cannot be replaced`);
			const now = new Date().toISOString();
			const profile = normalizeProfile({
				...input,
				id,
				status: input.status ?? existing?.status ?? "active",
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
			await this.#persist(profile);
			this.#profiles.set(profile.id, profile);
			return profile;
		});
	}

	async revoke(id: string): Promise<CapabilityConnectionProfile> {
		assertIdentifier(id, "connection id");
		return this.#queue.run(async () => {
			const existing = await this.get(id);
			if (!existing) throw new Error(`Connection ${id} was not found`);
			if (existing.status === "revoked") return existing;
			const now = new Date().toISOString();
			const revoked = {
				...existing,
				status: "revoked" as const,
				updatedAt: now,
				revokedAt: now,
			};
			await this.#persist(revoked);
			this.#profiles.set(id, revoked);
			return revoked;
		});
	}

	async deleteRevoked(id: string): Promise<boolean> {
		const existing = await this.get(id);
		if (!existing) return false;
		if (existing.status !== "revoked") throw new Error(`Connection ${id} must be revoked before deletion`);
		return this.#queue.run(async () => {
			await unlink(resolve(this.#directory, `${id}.json`));
			this.#profiles.delete(id);
			return true;
		});
	}

	async assertGrant(connectionId: string, providerId: string, capabilityId: string): Promise<void> {
		const profile = await this.get(connectionId);
		if (!profile) throw new Error(`Capability connection ${connectionId} was not found`);
		if (profile.status !== "active") throw new Error(`Capability connection ${connectionId} is ${profile.status}`);
		if (profile.providerId !== providerId) {
			throw new Error(`Capability connection ${connectionId} belongs to provider ${profile.providerId}`);
		}
		if (!profile.capabilityIds.includes(capabilityId)) {
			throw new Error(`Capability connection ${connectionId} does not grant ${capabilityId}`);
		}
	}

	async #read(path: string): Promise<CapabilityConnectionProfile> {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return normalizeProfile(value);
	}

	async #persist(profile: CapabilityConnectionProfile): Promise<void> {
		const target = resolve(this.#directory, `${profile.id}.json`);
		const temporary = resolve(dirname(target), `.${profile.id}.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, target);
	}
}

function normalizeProfile(value: unknown): CapabilityConnectionProfile {
	const input = record(value, "connection profile");
	const id = requiredString(input.id, "id");
	assertIdentifier(id, "connection id");
	const secretRef = requiredString(input.secretRef, "secretRef");
	if (!/^(env|os|managed):[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(secretRef)) {
		throw new Error("secretRef must use an env:, os:, or managed: reference");
	}
	const status = input.status;
	if (status !== "active" && status !== "unhealthy" && status !== "revoked") {
		throw new Error("status must be active, unhealthy, or revoked");
	}
	const revokedAt = input.revokedAt === undefined ? undefined : requiredString(input.revokedAt, "revokedAt");
	if (status === "revoked" && !revokedAt) throw new Error("revoked connections require revokedAt");
	return {
		id,
		providerId: requiredIdentifier(input.providerId, "providerId"),
		accountLabel: requiredString(input.accountLabel, "accountLabel"),
		secretRef,
		scopes: stringList(input.scopes, "scopes"),
		capabilityIds: stringList(input.capabilityIds, "capabilityIds"),
		status,
		createdAt: requiredString(input.createdAt, "createdAt"),
		updatedAt: requiredString(input.updatedAt, "updatedAt"),
		revokedAt,
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function requiredIdentifier(value: unknown, name: string): string {
	const identifier = requiredString(value, name);
	assertIdentifier(identifier, name);
	return identifier;
}

function stringList(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
		throw new Error(`${name} must be a list of non-empty strings`);
	}
	return [...new Set(value.map((entry) => entry.trim()))].sort();
}

function assertIdentifier(value: string, name: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
		throw new Error(`${name} must contain only lowercase letters, numbers, and hyphens`);
	}
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("connection name must contain at least one letter or number");
	return slug;
}
