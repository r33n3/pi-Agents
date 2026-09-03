import { createHash } from "node:crypto";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentDefinition } from "./agent-registry.ts";

export interface AgentRunCapabilityBinding {
	capabilityId: string;
	capabilityVersion: number;
	providerId: string;
	providerDigest: string;
	connectionId?: string;
}

export interface AgentExecutionConfigurationSeed {
	version: 1;
	agentId: string;
	agentRevision: number;
	workspace: string;
	definition: AgentDefinition;
	effectiveModel?: ModelRef;
	capabilityBindings: AgentRunCapabilityBinding[];
	digest: string;
}

export interface AgentExecutionConfigurationSeedInput {
	workspace: string;
	definition: AgentDefinition;
	effectiveModel?: ModelRef;
	capabilityBindings: readonly AgentRunCapabilityBinding[];
}

export interface AgentRunConfigurationSnapshot {
	version: 1;
	runId: string;
	configuration: AgentExecutionConfigurationSeed;
	digest: string;
}

type AgentExecutionConfigurationSeedBase = Omit<AgentExecutionConfigurationSeed, "digest">;
type AgentRunConfigurationSnapshotBase = Omit<AgentRunConfigurationSnapshot, "digest">;

/** Captures reusable, non-secret execution configuration before work becomes schedulable. */
export function createAgentExecutionConfigurationSeed(
	input: AgentExecutionConfigurationSeedInput,
): AgentExecutionConfigurationSeed {
	const base = canonicalClone({
		version: 1 as const,
		agentId: input.definition.id,
		agentRevision: input.definition.revision,
		workspace: input.workspace,
		definition: input.definition,
		...(input.effectiveModel ? { effectiveModel: input.effectiveModel } : {}),
		capabilityBindings: input.capabilityBindings,
	}) as AgentExecutionConfigurationSeedBase;
	return deepFreeze({ ...base, digest: digest(base) });
}

/** Adds attempt identity without re-resolving or copying configuration policy. */
export function createAgentRunConfigurationSnapshot(
	runId: string,
	configuration: AgentExecutionConfigurationSeed,
): AgentRunConfigurationSnapshot {
	assertAgentExecutionConfigurationSeedIntegrity(configuration, configuration.digest);
	const base = canonicalClone({
		version: 1 as const,
		runId,
		configuration,
	}) as AgentRunConfigurationSnapshotBase;
	return deepFreeze({ ...base, digest: digest(base) });
}

export function assertAgentExecutionConfigurationSeedIntegrity(value: unknown, expectedDigest: string): void {
	const record = digestRecord(value, "execution configuration seed");
	if (record.version !== 1) throw new Error("Invalid execution configuration seed");
	const actualDigest = digestWithoutOwnDigest(record);
	if (record.digest !== actualDigest || expectedDigest !== actualDigest) {
		throw new Error("Execution configuration seed digest does not match");
	}
}

export function assertAgentRunConfigurationSnapshotIntegrity(value: unknown, expectedDigest: string): void {
	const record = digestRecord(value, "run configuration snapshot");
	if (record.version !== 1 || typeof record.configuration !== "object" || record.configuration === null) {
		throw new Error("Invalid run configuration snapshot");
	}
	const configuration = record.configuration as Record<string, unknown>;
	if (typeof configuration.digest !== "string") throw new Error("Invalid execution configuration seed");
	assertAgentExecutionConfigurationSeedIntegrity(configuration, configuration.digest);
	const actualDigest = digestWithoutOwnDigest(record);
	if (record.digest !== actualDigest || expectedDigest !== actualDigest) {
		throw new Error("Run configuration snapshot digest does not match its run record");
	}
}

function digestRecord(value: unknown, name: string): Record<string, unknown> & { digest: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${name}`);
	const record = value as Record<string, unknown>;
	if (typeof record.digest !== "string") throw new Error(`Invalid ${name}`);
	return record as Record<string, unknown> & { digest: string };
}

function digestWithoutOwnDigest(record: Record<string, unknown>): string {
	const base: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (key !== "digest") base[key] = entry;
	}
	return digest(canonicalClone(base));
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalClone(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Run configuration contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => canonicalClone(entry));
	if (typeof value !== "object") throw new Error("Run configuration contains a non-JSON value");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error("Run configuration contains a non-plain object");
	}
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry === undefined) continue;
		result[key] = canonicalClone(entry);
	}
	return result;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
	return Object.freeze(value);
}
