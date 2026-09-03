import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const APPROVAL_VERSION = 2 as const;
const ACTION_BINDING_VERSION = 1 as const;
const MAX_PREVIEW_LENGTH = 2_000;

export interface CapabilityApprovalOwner {
	kind: "session" | "agent-run";
	id: string;
}

export interface CapabilityApprovalActionBinding {
	version: typeof ACTION_BINDING_VERSION;
	digest: string;
	preview: string;
}

export interface CapabilityApprovalRequest {
	capabilityId: string;
	providerId: string;
	connectionId: string;
	action: string;
	target: string;
	owner?: CapabilityApprovalOwner;
	binding?: CapabilityApprovalActionBinding;
	expiresInSeconds?: number;
}

export interface CapabilityApprovalReceipt {
	id: string;
	idempotencyKey: string;
	capabilityId: string;
	providerId: string;
	connectionId: string;
	action: string;
	target: string;
	owner: CapabilityApprovalOwner;
	binding: CapabilityApprovalActionBinding;
	approvedAt: string;
	expiresAt: string;
	state: "approved" | "started" | "completed" | "failed" | "cancelled";
	result?: unknown;
	error?: string;
	revokedAt?: string;
	revocationReason?: string;
	legacy?: false;
}

export interface LegacyCapabilityApprovalReceipt {
	id: string;
	idempotencyKey: string;
	capabilityId: string;
	providerId: string;
	connectionId: string;
	action: string;
	target: string;
	approvedAt: string;
	expiresAt: string;
	state: "completed" | "failed" | "cancelled";
	result?: unknown;
	error?: string;
	legacy: true;
}

export type CapabilityApprovalHistoryReceipt = CapabilityApprovalReceipt | LegacyCapabilityApprovalReceipt;

export type CapabilityApprovalBeginResult =
	| { kind: "execute"; receipt: CapabilityApprovalReceipt }
	| { kind: "replay"; receipt: CapabilityApprovalReceipt; result: unknown };

interface PersistedApprovalState {
	version: typeof APPROVAL_VERSION;
	receipts: Record<string, CapabilityApprovalHistoryReceipt>;
}

export interface CapabilityApprovalRevocationSelector {
	owner?: CapabilityApprovalOwner;
	connectionId?: string;
}

/** Owns exact-action approval matching, durable idempotency, replay, and revocation state. */
export class CapabilityApprovalService {
	readonly #statePath: string;
	readonly #queue = new SerialOperationQueue();
	#state: PersistedApprovalState = { version: APPROVAL_VERSION, receipts: {} };
	#needsMigration = false;

	constructor(directory: string) {
		this.#statePath = resolve(directory, "approvals.json");
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.#statePath), { recursive: true });
		try {
			const loaded = normalizeState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
			this.#state = loaded.state;
			this.#needsMigration = loaded.migrated;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			await this.#persist();
		}
	}

	list(): CapabilityApprovalHistoryReceipt[] {
		return Object.values(this.#state.receipts)
			.sort((left, right) => right.approvedAt.localeCompare(left.approvedAt))
			.map((receipt) => structuredClone(receipt));
	}

	async issue(request: CapabilityApprovalRequest, approved: boolean): Promise<CapabilityApprovalReceipt> {
		if (!approved) throw new Error("External write approval requires explicit confirmation");
		const owner = normalizeOwner(request.owner, "approval owner");
		const binding = normalizeBinding(request.binding, "approval action binding");
		return this.#queue.run(async () => {
			const now = Date.now();
			const ttl = request.expiresInSeconds ?? 300;
			if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 3600) {
				throw new Error("Approval expiry must be between 30 and 3600 seconds");
			}
			const receipt = normalizeReceipt({
				...request,
				owner,
				binding,
				id: randomUUID(),
				idempotencyKey: randomBytes(24).toString("base64url"),
				approvedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + ttl * 1000).toISOString(),
				state: "approved",
			});
			this.#state.receipts[receipt.id] = receipt;
			await this.#persist();
			return structuredClone(receipt);
		});
	}

	async begin(
		receiptId: string,
		expected: Omit<CapabilityApprovalRequest, "expiresInSeconds">,
	): Promise<CapabilityApprovalBeginResult> {
		const owner = normalizeOwner(expected.owner, "approval owner");
		const binding = normalizeBinding(expected.binding, "approval action binding");
		return this.#queue.run(async () => {
			const receipt = this.#receipt(receiptId);
			if (receipt.legacy)
				throw new Error(`Legacy approval receipt ${receiptId} cannot authorize execution or replay`);
			assertReceiptMatches(receipt, { ...expected, owner, binding });
			if (receipt.state === "completed") {
				return { kind: "replay", receipt: structuredClone(receipt), result: structuredClone(receipt.result) };
			}
			if (receipt.revokedAt) throw new Error(`Approval receipt ${receiptId} has been revoked`);
			if (Date.parse(receipt.expiresAt) <= Date.now() && receipt.state === "approved") {
				throw new Error(`Approval receipt ${receiptId} has expired`);
			}
			if (receipt.state === "failed") throw new Error(`Approval receipt ${receiptId} previously failed`);
			if (receipt.state === "cancelled") throw new Error(`Approval receipt ${receiptId} was cancelled`);
			if (receipt.state === "started") throw new Error(`Approval receipt ${receiptId} is already in progress`);
			receipt.state = "started";
			await this.#persist();
			return { kind: "execute", receipt: structuredClone(receipt) };
		});
	}

	async complete(receiptId: string, result: unknown): Promise<CapabilityApprovalHistoryReceipt> {
		return this.#finish(receiptId, { state: "completed", result });
	}

	async fail(receiptId: string, error: string): Promise<CapabilityApprovalHistoryReceipt> {
		if (error.trim() === "") throw new Error("Approval failure requires an error message");
		return this.#finish(receiptId, { state: "failed", error: error.trim() });
	}

	async cancel(receiptId: string, reason: string): Promise<CapabilityApprovalHistoryReceipt> {
		if (reason.trim() === "") throw new Error("Approval cancellation requires a reason");
		return this.#finish(receiptId, { state: "cancelled", error: reason.trim() });
	}

	async revoke(selector: CapabilityApprovalRevocationSelector, reason: string): Promise<number> {
		if (!selector.owner && !selector.connectionId)
			throw new Error("Approval revocation requires an owner or connection");
		const owner = selector.owner ? normalizeOwner(selector.owner, "approval owner") : undefined;
		const connectionId = selector.connectionId ? requiredString(selector.connectionId, "connectionId") : undefined;
		const revocationReason = requiredString(reason, "revocation reason");
		return this.#queue.run(async () => {
			const revokedAt = new Date().toISOString();
			let changed = 0;
			for (const receipt of Object.values(this.#state.receipts)) {
				if (receipt.legacy) continue;
				if (owner && !ownersEqual(receipt.owner, owner)) continue;
				if (connectionId && receipt.connectionId !== connectionId) continue;
				if (receipt.state !== "approved" && receipt.state !== "started") continue;
				receipt.revokedAt = revokedAt;
				receipt.revocationReason = revocationReason;
				if (receipt.state === "approved") {
					receipt.state = "cancelled";
					receipt.error = revocationReason;
				}
				changed += 1;
			}
			if (changed > 0 || this.#needsMigration) await this.#persist();
			return changed;
		});
	}

	async #finish(
		receiptId: string,
		outcome: {
			state: "completed" | "failed" | "cancelled";
			result?: unknown;
			error?: string;
		},
	): Promise<CapabilityApprovalHistoryReceipt> {
		return this.#queue.run(async () => {
			const receipt = this.#receipt(receiptId);
			if (receipt.legacy) throw new Error(`Legacy approval receipt ${receiptId} is history only`);
			if (receipt.state === "completed" || receipt.state === "failed" || receipt.state === "cancelled") {
				return structuredClone(receipt);
			}
			if (receipt.state !== "started") throw new Error(`Approval receipt ${receiptId} has not started`);
			receipt.state = outcome.state;
			if (outcome.result !== undefined) receipt.result = structuredClone(outcome.result);
			if (outcome.error !== undefined) receipt.error = outcome.error;
			await this.#persist();
			return structuredClone(receipt);
		});
	}

	#receipt(id: string): CapabilityApprovalHistoryReceipt {
		const receipt = this.#state.receipts[id];
		if (!receipt) throw new Error(`Approval receipt ${id} was not found`);
		return receipt;
	}

	async #persist(): Promise<void> {
		const temporary = resolve(dirname(this.#statePath), `.approvals.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, this.#statePath);
		this.#needsMigration = false;
	}
}

export function createCapabilityApprovalActionBinding(
	action: unknown,
	preview: string,
): CapabilityApprovalActionBinding {
	const canonical = canonicalJsonValue(action, "approval action", 0, new Set());
	return {
		version: ACTION_BINDING_VERSION,
		digest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
		preview: boundedPreview(preview),
	};
}

function normalizeState(value: unknown): { state: PersistedApprovalState; migrated: boolean } {
	const input = record(value, "approval state");
	const receiptsInput = record(input.receipts, "approval receipts");
	if (input.version === APPROVAL_VERSION) {
		const receipts: Record<string, CapabilityApprovalHistoryReceipt> = {};
		for (const [id, receipt] of Object.entries(receiptsInput)) receipts[id] = normalizeHistoryReceipt(receipt);
		return { state: { version: APPROVAL_VERSION, receipts }, migrated: false };
	}
	if (input.version !== 1) throw new Error("Approval state version is unsupported");
	const receipts: Record<string, LegacyCapabilityApprovalReceipt> = {};
	for (const [id, receipt] of Object.entries(receiptsInput)) receipts[id] = migrateLegacyReceipt(receipt);
	return { state: { version: APPROVAL_VERSION, receipts }, migrated: true };
}

function normalizeHistoryReceipt(value: unknown): CapabilityApprovalHistoryReceipt {
	const input = record(value, "approval receipt");
	if (input.legacy === true) return normalizeLegacyReceipt(input);
	return normalizeReceipt(input);
}

function normalizeReceipt(value: unknown): CapabilityApprovalReceipt {
	const input = record(value, "approval receipt");
	return compact({
		id: requiredString(input.id, "id"),
		idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
		capabilityId: requiredString(input.capabilityId, "capabilityId"),
		providerId: requiredString(input.providerId, "providerId"),
		connectionId: requiredString(input.connectionId, "connectionId"),
		action: requiredString(input.action, "action"),
		target: requiredString(input.target, "target"),
		owner: normalizeOwner(input.owner, "approval owner"),
		binding: normalizeBinding(input.binding, "approval action binding"),
		approvedAt: timestamp(input.approvedAt, "approvedAt"),
		expiresAt: timestamp(input.expiresAt, "expiresAt"),
		state: approvalState(input.state),
		result: input.result,
		error: input.error === undefined ? undefined : requiredString(input.error, "error"),
		revokedAt: input.revokedAt === undefined ? undefined : timestamp(input.revokedAt, "revokedAt"),
		revocationReason:
			input.revocationReason === undefined ? undefined : requiredString(input.revocationReason, "revocationReason"),
	});
}

function normalizeLegacyReceipt(input: Record<string, unknown>): LegacyCapabilityApprovalReceipt {
	const state = input.state;
	if (state !== "completed" && state !== "failed" && state !== "cancelled") {
		throw new Error("Legacy approval receipt state is invalid");
	}
	return compact({
		id: requiredString(input.id, "id"),
		idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
		capabilityId: requiredString(input.capabilityId, "capabilityId"),
		providerId: requiredString(input.providerId, "providerId"),
		connectionId: requiredString(input.connectionId, "connectionId"),
		action: requiredString(input.action, "action"),
		target: requiredString(input.target, "target"),
		approvedAt: timestamp(input.approvedAt, "approvedAt"),
		expiresAt: timestamp(input.expiresAt, "expiresAt"),
		state,
		result: input.result,
		error: input.error === undefined ? undefined : requiredString(input.error, "error"),
		legacy: true,
	});
}

function migrateLegacyReceipt(value: unknown): LegacyCapabilityApprovalReceipt {
	const input = record(value, "legacy approval receipt");
	const priorState = input.state;
	if (priorState !== "approved" && priorState !== "started" && priorState !== "completed" && priorState !== "failed") {
		throw new Error("Legacy approval receipt state is invalid");
	}
	return normalizeLegacyReceipt({
		...input,
		state: priorState === "approved" ? "cancelled" : priorState === "started" ? "failed" : priorState,
		error:
			priorState === "approved"
				? "Legacy approval was cancelled because it has no exact action or owner binding"
				: priorState === "started"
					? "Legacy approval outcome requires reconciliation"
					: input.error,
		legacy: true,
	});
}

function assertReceiptMatches(
	receipt: CapabilityApprovalReceipt,
	expected: Omit<CapabilityApprovalRequest, "expiresInSeconds"> & {
		owner: CapabilityApprovalOwner;
		binding: CapabilityApprovalActionBinding;
	},
): void {
	for (const key of ["capabilityId", "providerId", "connectionId", "action", "target"] as const) {
		if (receipt[key] !== expected[key]) throw new Error(`Approval receipt ${receipt.id} does not match ${key}`);
	}
	if (!ownersEqual(receipt.owner, expected.owner))
		throw new Error(`Approval receipt ${receipt.id} does not match owner`);
	if (receipt.binding.version !== expected.binding.version || receipt.binding.digest !== expected.binding.digest) {
		throw new Error(`Approval receipt ${receipt.id} does not match exact action`);
	}
}

function normalizeOwner(value: unknown, name: string): CapabilityApprovalOwner {
	const input = record(value, name);
	if (input.kind !== "session" && input.kind !== "agent-run") throw new Error(`${name} kind is invalid`);
	return { kind: input.kind, id: requiredString(input.id, `${name} id`) };
}

function normalizeBinding(value: unknown, name: string): CapabilityApprovalActionBinding {
	const input = record(value, name);
	if (input.version !== ACTION_BINDING_VERSION) throw new Error(`${name} version is unsupported`);
	const digest = requiredString(input.digest, `${name} digest`);
	if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${name} digest is invalid`);
	return { version: ACTION_BINDING_VERSION, digest, preview: boundedPreview(input.preview) };
}

function canonicalJsonValue(value: unknown, name: string, depth: number, seen: Set<object>): unknown {
	if (depth > 32) throw new Error(`${name} exceeds the maximum depth`);
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number`);
		return value;
	}
	if (value === undefined) throw new Error(`${name} contains undefined`);
	if (typeof value !== "object") throw new Error(`${name} must contain only JSON values`);
	if (seen.has(value)) throw new Error(`${name} contains a cycle`);
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry, name, depth + 1, seen));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
			throw new Error(`${name} contains a non-plain object`);
		}
		const output: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			output[key] = canonicalJsonValue((value as Record<string, unknown>)[key], name, depth + 1, seen);
		}
		return output;
	} finally {
		seen.delete(value);
	}
}

function approvalState(value: unknown): CapabilityApprovalReceipt["state"] {
	if (
		value !== "approved" &&
		value !== "started" &&
		value !== "completed" &&
		value !== "failed" &&
		value !== "cancelled"
	) {
		throw new Error("Approval receipt state is invalid");
	}
	return value;
}

function ownersEqual(left: CapabilityApprovalOwner, right: CapabilityApprovalOwner): boolean {
	return left.kind === right.kind && left.id === right.id;
}

function boundedPreview(value: unknown): string {
	const preview = requiredString(value, "approval preview");
	if (preview.length > MAX_PREVIEW_LENGTH) throw new Error("Approval preview is too long");
	return preview;
}

function timestamp(value: unknown, name: string): string {
	const result = requiredString(value, name);
	const date = new Date(result);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) throw new Error(`${name} is invalid`);
	return result;
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error(`${name} must be a plain object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function compact<T extends object>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key as keyof T] === undefined) delete value[key as keyof T];
	}
	return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
