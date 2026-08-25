import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const AUDIT_VERSION = 1 as const;
const AUDIT_FILE = "serve-audit.jsonl";
const REDACTED = "[REDACTED]";
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_STRING_LENGTH = 32 * 1024;
const MAX_CONTAINER_ENTRIES = 512;
const MAX_VALUE_DEPTH = 24;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface ServeAuditIdentities {
	actorId?: string;
	sessionId?: string;
	agentId?: string;
	taskId?: string;
	attemptId?: string;
	computerId?: string;
}

export interface ServeAuditActionInput {
	family: string;
	target: unknown;
}

export interface ServeAuditDecisionInput {
	correlationId?: string;
	identities?: ServeAuditIdentities;
	action: ServeAuditActionInput;
	decision: "allow" | "deny";
	reason: string;
	policy?: string;
	grant?: string;
	approval?: string;
}

export type ServeAuditErrorClassification =
	| "validation"
	| "authorization"
	| "policy"
	| "not-found"
	| "conflict"
	| "timeout"
	| "cancelled"
	| "dependency"
	| "internal";

export interface ServeAuditSafeError {
	classification: ServeAuditErrorClassification;
	code?: string;
	message: string;
}

export interface ServeAuditOutcomeInput {
	correlationId: string;
	identities?: ServeAuditIdentities;
	action: ServeAuditActionInput;
	outcome: "succeeded" | "failed" | "cancelled";
	durationMs: number;
	error?: ServeAuditSafeError;
}

interface ServeAuditEventBase {
	version: typeof AUDIT_VERSION;
	id: string;
	correlationId: string;
	timestamp: string;
	identities?: ServeAuditIdentities;
	action: {
		family: string;
		target: ServeAuditValue;
	};
}

export interface ServeAuditDecisionEvent extends ServeAuditEventBase {
	kind: "decision";
	decision: "allow" | "deny";
	reason: string;
	policy?: string;
	grant?: string;
	approval?: string;
}

export interface ServeAuditOutcomeEvent extends ServeAuditEventBase {
	kind: "outcome";
	outcome: "succeeded" | "failed" | "cancelled";
	durationMs: number;
	error?: ServeAuditSafeError;
}

export type ServeAuditEvent = ServeAuditDecisionEvent | ServeAuditOutcomeEvent;

type AuditPrimitive = null | boolean | number | string;
export type ServeAuditValue = AuditPrimitive | ServeAuditValue[] | { [key: string]: ServeAuditValue };

export interface ServeAuditStoreOptions {
	now?: () => Date;
	generateId?: () => string;
}

/**
 * Owns the append-only audit ledger for serve-host decisions and outcomes.
 * Every successful append is flushed before it resolves; callers must treat a
 * rejected decision append as a failed authorization step and perform no action.
 */
export class ServeAuditStore {
	readonly #path: string;
	readonly #now: () => Date;
	readonly #generateId: () => string;
	readonly #queue = new SerialOperationQueue();
	readonly #events: ServeAuditEvent[] = [];
	readonly #eventIds = new Set<string>();
	readonly #decisionCorrelations = new Set<string>();
	readonly #outcomeCorrelations = new Set<string>();
	readonly #decisions = new Map<string, ServeAuditDecisionEvent>();
	#initialization: Promise<void> | undefined;
	#initialized = false;

	constructor(directory: string, options: ServeAuditStoreOptions = {}) {
		this.#path = resolve(directory, AUDIT_FILE);
		this.#now = options.now ?? (() => new Date());
		this.#generateId = options.generateId ?? randomUUID;
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		this.#initialization ??= this.#load();
		await this.#initialization;
	}

	async #load(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		let contents = "";
		try {
			contents = await readFile(this.#path, "utf8");
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const loaded: ServeAuditEvent[] = [];
		for (const [index, line] of contents.split(/\r?\n/).entries()) {
			if (!line) continue;
			if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
				throw new Error(`Audit event ${index + 1} exceeds the maximum encoded size`);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new Error(`Audit event ${index + 1} is not valid JSON`);
			}
			loaded.push(normalizePersistedEvent(parsed));
		}
		this.#restore(loaded);
		this.#initialized = true;
	}

	async appendDecision(input: ServeAuditDecisionInput): Promise<ServeAuditDecisionEvent> {
		return this.#queue.run(async () => {
			await this.initialize();
			const correlationId = input.correlationId
				? identifier(input.correlationId, "correlationId")
				: this.#uniqueId("correlationId");
			if (this.#decisionCorrelations.has(correlationId)) {
				throw new Error(`Audit correlation ${correlationId} already has a decision`);
			}
			const event = normalizePersistedEvent({
				version: AUDIT_VERSION,
				id: this.#uniqueId("event id", new Set([correlationId])),
				correlationId,
				timestamp: timestamp(this.#now()),
				kind: "decision",
				identities: input.identities,
				action: input.action,
				decision: input.decision,
				reason: input.reason,
				policy: input.policy,
				grant: input.grant,
				approval: input.approval,
			});
			if (event.kind !== "decision") throw new Error("Normalized audit event is not a decision");
			await this.#append(event);
			this.#record(event);
			return cloneEvent(event);
		});
	}

	async appendOutcome(input: ServeAuditOutcomeInput): Promise<ServeAuditOutcomeEvent> {
		return this.#queue.run(async () => {
			await this.initialize();
			const correlationId = identifier(input.correlationId, "correlationId");
			if (!this.#decisionCorrelations.has(correlationId)) {
				throw new Error(`Audit correlation ${correlationId} has no decision`);
			}
			if (this.#outcomeCorrelations.has(correlationId)) {
				throw new Error(`Audit correlation ${correlationId} already has an outcome`);
			}
			const decision = this.#decisions.get(correlationId);
			if (!decision) throw new Error(`Audit correlation ${correlationId} has no decision`);
			const event = normalizePersistedEvent({
				version: AUDIT_VERSION,
				id: this.#uniqueId("event id"),
				correlationId,
				timestamp: timestamp(this.#now()),
				kind: "outcome",
				identities: input.identities,
				action: input.action,
				outcome: input.outcome,
				durationMs: input.durationMs,
				error: input.error,
			});
			if (event.kind !== "outcome") throw new Error("Normalized audit event is not an outcome");
			if (JSON.stringify(event.action) !== JSON.stringify(decision.action)) {
				throw new Error(`Audit outcome ${event.id} does not match its decision action`);
			}
			await this.#append(event);
			this.#record(event);
			return cloneEvent(event);
		});
	}

	async read(): Promise<ServeAuditEvent[]> {
		return this.#queue.run(async () => {
			await this.initialize();
			return this.#events.map(cloneEvent);
		});
	}

	async #append(event: ServeAuditEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_EVENT_BYTES) {
			throw new Error("Audit event exceeds the maximum encoded size");
		}
		const handle = await open(this.#path, "a");
		try {
			await handle.writeFile(line, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	#restore(events: readonly ServeAuditEvent[]): void {
		for (const event of events) {
			if (this.#eventIds.has(event.id)) throw new Error(`Duplicate audit event id: ${event.id}`);
			if (event.kind === "decision") {
				if (this.#decisionCorrelations.has(event.correlationId)) {
					throw new Error(`Duplicate audit decision correlation: ${event.correlationId}`);
				}
				this.#decisionCorrelations.add(event.correlationId);
				this.#decisions.set(event.correlationId, event);
			} else {
				if (!this.#decisionCorrelations.has(event.correlationId)) {
					throw new Error(`Audit outcome ${event.id} has no preceding decision`);
				}
				if (this.#outcomeCorrelations.has(event.correlationId)) {
					throw new Error(`Duplicate audit outcome correlation: ${event.correlationId}`);
				}
				const decision = this.#decisions.get(event.correlationId);
				if (!decision || JSON.stringify(event.action) !== JSON.stringify(decision.action)) {
					throw new Error(`Audit outcome ${event.id} does not match its decision action`);
				}
				this.#outcomeCorrelations.add(event.correlationId);
			}
			this.#eventIds.add(event.id);
			this.#events.push(event);
		}
	}

	#record(event: ServeAuditEvent): void {
		this.#eventIds.add(event.id);
		if (event.kind === "decision") {
			this.#decisionCorrelations.add(event.correlationId);
			this.#decisions.set(event.correlationId, event);
		} else this.#outcomeCorrelations.add(event.correlationId);
		this.#events.push(event);
	}

	#uniqueId(name: string, reserved: ReadonlySet<string> = new Set()): string {
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const value = identifier(this.#generateId(), name);
			if (!reserved.has(value) && !this.#eventIds.has(value) && !this.#decisionCorrelations.has(value)) return value;
		}
		throw new Error(`Could not generate a unique ${name}`);
	}
}

function normalizePersistedEvent(value: unknown): ServeAuditEvent {
	const input = record(value, "audit event");
	if (input.version !== AUDIT_VERSION) throw new Error("Audit event version is unsupported");
	assertOnlyKeys(
		input,
		input.kind === "decision"
			? [
					"version",
					"id",
					"correlationId",
					"timestamp",
					"kind",
					"identities",
					"action",
					"decision",
					"reason",
					"policy",
					"grant",
					"approval",
				]
			: [
					"version",
					"id",
					"correlationId",
					"timestamp",
					"kind",
					"identities",
					"action",
					"outcome",
					"durationMs",
					"error",
				],
		"audit event",
	);
	const common: ServeAuditEventBase = {
		version: AUDIT_VERSION,
		id: identifier(input.id, "event id"),
		correlationId: identifier(input.correlationId, "correlationId"),
		timestamp: timestamp(input.timestamp),
		identities: normalizeIdentities(input.identities),
		action: normalizeAction(input.action),
	};
	if (!common.identities) delete common.identities;
	if (input.kind === "decision") {
		if (input.decision !== "allow" && input.decision !== "deny") {
			throw new Error("Audit decision must be allow or deny");
		}
		return compact({
			...common,
			kind: "decision",
			decision: input.decision,
			reason: redactString(requiredString(input.reason, "decision reason")),
			policy: optionalRedactedString(input.policy, "policy"),
			grant: optionalRedactedString(input.grant, "grant"),
			approval: optionalRedactedString(input.approval, "approval"),
		});
	}
	if (input.kind !== "outcome") throw new Error("Audit event kind must be decision or outcome");
	if (input.outcome !== "succeeded" && input.outcome !== "failed" && input.outcome !== "cancelled") {
		throw new Error("Audit outcome is invalid");
	}
	const error = normalizeSafeError(input.error);
	if (input.outcome === "failed" && !error) throw new Error("Failed audit outcomes require a safe error");
	if (input.outcome === "succeeded" && error) throw new Error("Successful audit outcomes cannot include an error");
	return compact({
		...common,
		kind: "outcome",
		outcome: input.outcome,
		durationMs: duration(input.durationMs),
		error,
	});
}

function normalizeAction(value: unknown): ServeAuditEventBase["action"] {
	const input = record(value, "audit action");
	assertOnlyKeys(input, ["family", "target"], "audit action");
	const family = requiredString(input.family, "action family");
	if (!/^[a-z][a-z0-9.-]{0,127}$/.test(family)) throw new Error("Audit action family is invalid");
	return { family, target: normalizeAuditValue(input.target, "target", 0, new Set()) };
}

function normalizeIdentities(value: unknown): ServeAuditIdentities | undefined {
	if (value === undefined) return undefined;
	const input = record(value, "audit identities");
	assertOnlyKeys(input, ["actorId", "sessionId", "agentId", "taskId", "attemptId", "computerId"], "audit identities");
	const identities = compact({
		actorId: optionalIdentifier(input.actorId, "actorId"),
		sessionId: optionalIdentifier(input.sessionId, "sessionId"),
		agentId: optionalIdentifier(input.agentId, "agentId"),
		taskId: optionalIdentifier(input.taskId, "taskId"),
		attemptId: optionalIdentifier(input.attemptId, "attemptId"),
		computerId: optionalIdentifier(input.computerId, "computerId"),
	});
	return Object.keys(identities).length === 0 ? undefined : identities;
}

function normalizeSafeError(value: unknown): ServeAuditSafeError | undefined {
	if (value === undefined) return undefined;
	const input = record(value, "safe error");
	assertOnlyKeys(input, ["classification", "code", "message"], "safe error");
	const classification = input.classification;
	if (
		classification !== "validation" &&
		classification !== "authorization" &&
		classification !== "policy" &&
		classification !== "not-found" &&
		classification !== "conflict" &&
		classification !== "timeout" &&
		classification !== "cancelled" &&
		classification !== "dependency" &&
		classification !== "internal"
	) {
		throw new Error("Audit error classification is invalid");
	}
	const error: ServeAuditSafeError = compact({
		classification,
		code: optionalIdentifier(input.code, "error code"),
		message: redactString(requiredString(input.message, "error message")),
	});
	return error;
}

function normalizeAuditValue(value: unknown, key: string, depth: number, seen: Set<object>): ServeAuditValue {
	if (depth > MAX_VALUE_DEPTH) throw new Error("Audit target exceeds the maximum depth");
	if (isSensitiveName(key)) return REDACTED;
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Audit target numbers must be finite");
		return value;
	}
	if (typeof value === "string") return redactString(boundedString(value, "audit target string"));
	if (typeof value !== "object") throw new Error("Audit target must contain only JSON values");
	if (seen.has(value)) throw new Error("Audit target must not contain cycles");
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_CONTAINER_ENTRIES) throw new Error("Audit target array is too large");
			return value.map((entry) => normalizeAuditValue(entry, "", depth + 1, seen));
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new Error("Audit target objects must be plain records");
		}
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > MAX_CONTAINER_ENTRIES) throw new Error("Audit target object is too large");
		const output: Record<string, ServeAuditValue> = {};
		for (const [entryKey, entryValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
			const normalizedKey = boundedString(entryKey, "audit target key");
			output[normalizedKey] = normalizeAuditValue(entryValue, normalizedKey, depth + 1, seen);
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

function redactString(value: string): string {
	const bearerRedacted = value.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, `$1 ${REDACTED}`);
	const assignmentsRedacted = bearerRedacted.replace(
		/\b(password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*=\s*([^\s,;&]+)/gi,
		(_match, key: string) => `${key}=${REDACTED}`,
	);
	return assignmentsRedacted.replace(/https?:\/\/[^\s<>'"]+/gi, (candidate) => redactUrl(candidate));
}

function redactUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return value;
	}
	if (url.username) url.username = "redacted";
	if (url.password) url.password = "redacted";
	for (const key of [...url.searchParams.keys()]) {
		if (isSensitiveQueryName(key)) url.searchParams.set(key, "redacted");
	}
	url.searchParams.sort();
	if (url.hash.includes("=")) {
		const fragment = new URLSearchParams(url.hash.slice(1));
		for (const key of [...fragment.keys()]) if (isSensitiveQueryName(key)) fragment.set(key, "redacted");
		fragment.sort();
		url.hash = fragment.toString();
	}
	return url.href;
}

function isSensitiveQueryName(value: string): boolean {
	const name = value.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		isSensitiveName(value) ||
		name === "key" ||
		name === "code" ||
		name === "sig" ||
		name === "signature" ||
		name === "auth"
	);
}

function isSensitiveName(value: string): boolean {
	const name = value.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		name.includes("authorization") ||
		name.includes("cookie") ||
		name.includes("password") ||
		name.includes("passwd") ||
		name.includes("secret") ||
		name.includes("token") ||
		name.includes("apikey") ||
		name.includes("accesskey") ||
		name.includes("privatekey") ||
		name.includes("credential")
	);
}

function duration(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_DURATION_MS) {
		throw new Error("Audit durationMs is invalid");
	}
	return Number(value);
}

function timestamp(value: unknown): string {
	const text = requiredString(value instanceof Date ? value.toISOString() : value, "timestamp");
	const date = new Date(text);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) throw new Error("Audit timestamp is invalid");
	return text;
}

function identifier(value: unknown, name: string): string {
	const result = requiredString(value, name);
	if (result.length > 256 || /[\0-\x1f\x7f]/.test(result)) throw new Error(`${name} is invalid`);
	return result;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : identifier(value, name);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return boundedString(value.trim(), name);
}

function optionalString(value: unknown, name: string): string | undefined {
	return value === undefined ? undefined : requiredString(value, name);
}

function optionalRedactedString(value: unknown, name: string): string | undefined {
	const text = optionalString(value, name);
	return text === undefined ? undefined : redactString(text);
}

function boundedString(value: string, name: string): string {
	if (value.length > MAX_STRING_LENGTH || /\0/.test(value)) throw new Error(`${name} is invalid`);
	return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(`${name} must be a plain object`);
	}
	return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[], name: string): void {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${name} contains unknown field: ${key}`);
	}
}

function compact<T extends object>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key as keyof T] === undefined) delete value[key as keyof T];
	}
	return value;
}

function cloneEvent<T extends ServeAuditEvent>(event: T): T {
	return structuredClone(event);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
