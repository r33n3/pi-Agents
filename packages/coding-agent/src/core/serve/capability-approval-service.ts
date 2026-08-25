import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface CapabilityApprovalRequest {
	capabilityId: string;
	providerId: string;
	connectionId: string;
	action: string;
	target: string;
	expiresInSeconds?: number;
}

export interface CapabilityApprovalReceipt extends CapabilityApprovalRequest {
	id: string;
	idempotencyKey: string;
	approvedAt: string;
	expiresAt: string;
	state: "approved" | "started" | "completed" | "failed";
	result?: unknown;
	error?: string;
}

interface PersistedApprovalState {
	version: 1;
	receipts: Record<string, CapabilityApprovalReceipt>;
}

/** Issues visible write receipts and preserves stable idempotency keys across retries and restarts. */
export class CapabilityApprovalService {
	readonly #statePath: string;
	readonly #queue = new SerialOperationQueue();
	#state: PersistedApprovalState = { version: 1, receipts: {} };

	constructor(directory: string) {
		this.#statePath = resolve(directory, "approvals.json");
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.#statePath), { recursive: true });
		try {
			this.#state = normalizeState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			await this.#persist();
		}
	}

	list(): CapabilityApprovalReceipt[] {
		return Object.values(this.#state.receipts).sort((left, right) => right.approvedAt.localeCompare(left.approvedAt));
	}

	async issue(request: CapabilityApprovalRequest, approved: boolean): Promise<CapabilityApprovalReceipt> {
		if (!approved) throw new Error("External write approval requires explicit confirmation");
		return this.#queue.run(async () => {
			const now = Date.now();
			const ttl = request.expiresInSeconds ?? 300;
			if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 3600) {
				throw new Error("Approval expiry must be between 30 and 3600 seconds");
			}
			const receipt = normalizeReceipt({
				...request,
				id: randomUUID(),
				idempotencyKey: randomBytes(24).toString("base64url"),
				approvedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + ttl * 1000).toISOString(),
				state: "approved",
			});
			this.#state.receipts[receipt.id] = receipt;
			await this.#persist();
			return receipt;
		});
	}

	async begin(
		receiptId: string,
		expected: Omit<CapabilityApprovalRequest, "expiresInSeconds">,
	): Promise<CapabilityApprovalReceipt> {
		return this.#queue.run(async () => {
			const receipt = this.#receipt(receiptId);
			assertReceiptMatches(receipt, expected);
			if (Date.parse(receipt.expiresAt) <= Date.now() && receipt.state === "approved") {
				throw new Error(`Approval receipt ${receiptId} has expired`);
			}
			if (receipt.state === "failed") throw new Error(`Approval receipt ${receiptId} previously failed`);
			if (receipt.state === "started") throw new Error(`Approval receipt ${receiptId} is already in progress`);
			if (receipt.state === "approved") receipt.state = "started";
			await this.#persist();
			return receipt;
		});
	}

	async complete(receiptId: string, result: unknown): Promise<CapabilityApprovalReceipt> {
		return this.#finish(receiptId, { state: "completed", result });
	}

	async fail(receiptId: string, error: string): Promise<CapabilityApprovalReceipt> {
		if (error.trim() === "") throw new Error("Approval failure requires an error message");
		return this.#finish(receiptId, { state: "failed", error: error.trim() });
	}

	async #finish(
		receiptId: string,
		outcome: Pick<CapabilityApprovalReceipt, "state"> & {
			result?: unknown;
			error?: string;
		},
	): Promise<CapabilityApprovalReceipt> {
		return this.#queue.run(async () => {
			const receipt = this.#receipt(receiptId);
			if (receipt.state === "completed" || receipt.state === "failed") return receipt;
			if (receipt.state !== "started") throw new Error(`Approval receipt ${receiptId} has not started`);
			Object.assign(receipt, outcome);
			await this.#persist();
			return receipt;
		});
	}

	#receipt(id: string): CapabilityApprovalReceipt {
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
	}
}

function normalizeState(value: unknown): PersistedApprovalState {
	const input = record(value, "approval state");
	if (input.version !== 1) throw new Error("Approval state version is unsupported");
	const receiptsInput = record(input.receipts, "approval receipts");
	const receipts: Record<string, CapabilityApprovalReceipt> = {};
	for (const [id, receipt] of Object.entries(receiptsInput)) receipts[id] = normalizeReceipt(receipt);
	return { version: 1, receipts };
}

function normalizeReceipt(value: unknown): CapabilityApprovalReceipt {
	const input = record(value, "approval receipt");
	const state = input.state;
	if (state !== "approved" && state !== "started" && state !== "completed" && state !== "failed") {
		throw new Error("Approval receipt state is invalid");
	}
	return {
		id: requiredString(input.id, "id"),
		idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey"),
		capabilityId: requiredString(input.capabilityId, "capabilityId"),
		providerId: requiredString(input.providerId, "providerId"),
		connectionId: requiredString(input.connectionId, "connectionId"),
		action: requiredString(input.action, "action"),
		target: requiredString(input.target, "target"),
		approvedAt: requiredString(input.approvedAt, "approvedAt"),
		expiresAt: requiredString(input.expiresAt, "expiresAt"),
		state,
		result: input.result,
		error: input.error === undefined ? undefined : requiredString(input.error, "error"),
	};
}

function assertReceiptMatches(
	receipt: CapabilityApprovalReceipt,
	expected: Omit<CapabilityApprovalRequest, "expiresInSeconds">,
): void {
	for (const key of ["capabilityId", "providerId", "connectionId", "action", "target"] as const) {
		if (receipt[key] !== expected[key]) throw new Error(`Approval receipt ${receipt.id} does not match ${key}`);
	}
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
