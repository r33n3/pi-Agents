import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type WtkFactoryOperationStatus = "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";

export interface WtkFactoryOperation {
	id: string;
	kind: string;
	status: WtkFactoryOperationStatus;
	result?: unknown;
	error?: { message: string; code?: string };
	progress?: { stage: string; message: string };
}

export interface WtkFactoryStatus {
	configured: boolean;
	available: boolean;
	message: string;
}

export type WtkFactoryControlAction = "cancel" | "pause" | "resume" | "steer";

interface WtkAcceptedOperation {
	operation: WtkFactoryOperation;
	sessionId?: string;
}

/** Hides WTK's control-plane sequencing and artifact layout behind one Pi-owned boundary. */
export class WtkAgentFactoryClient {
	readonly #origin: URL;
	readonly #root: string;
	readonly #accessToken: string | undefined;
	readonly #fetch: typeof fetch;

	constructor(input: { origin: string; root: string; accessToken?: string; fetch?: typeof fetch }) {
		this.#origin = validatedLoopbackOrigin(input.origin);
		this.#root = resolve(input.root);
		this.#accessToken = input.accessToken?.trim() || undefined;
		this.#fetch = input.fetch ?? fetch;
	}

	async status(): Promise<WtkFactoryStatus> {
		try {
			await this.#health();
			return { configured: true, available: true, message: "Canonical WTK builder is ready" };
		} catch (error) {
			return {
				configured: true,
				available: false,
				message: error instanceof Error ? error.message : "Canonical WTK builder is unavailable",
			};
		}
	}

	async startIntake(input: string): Promise<WtkAcceptedOperation> {
		return this.#accepted(
			await this.#request("POST", "/api/goal-intake/start", {
				input: requiredText(input, "input"),
				experience: "conversation",
				defer: true,
			}),
		);
	}

	async continueIntake(sessionId: string, input: string): Promise<WtkAcceptedOperation> {
		return this.#accepted(
			await this.#request("POST", "/api/goal-intake/message", {
				sessionId: requiredIdentifier(sessionId, "sessionId"),
				input: requiredText(input, "input"),
				experience: "conversation",
				defer: true,
			}),
		);
	}

	async research(goalRecordPath: string): Promise<WtkAcceptedOperation> {
		return this.#accepted(
			await this.#request("POST", "/api/research/run", {
				goalRecordPath: this.#boundedWtkPath(goalRecordPath, "goalRecordPath"),
			}),
		);
	}

	async build(pkgId: string, handoffPath: string): Promise<WtkAcceptedOperation> {
		return this.#accepted(
			await this.#request("POST", "/api/factory/build", {
				pkgId: packageId(pkgId),
				handoffPath: this.#boundedWtkPath(handoffPath, "handoffPath"),
				requireReview: false,
				generateEvals: false,
				noJudge: true,
			}),
		);
	}

	async deliver(pkgId: string): Promise<WtkAcceptedOperation> {
		return this.#accepted(
			await this.#request("POST", "/api/package/deliver", {
				pkgId: packageId(pkgId),
				targets: ["pi-agents"],
				requireEvals: false,
			}),
		);
	}

	async operation(operationId: string): Promise<WtkFactoryOperation> {
		const value = record(
			await this.#request(
				"GET",
				`/api/operations/${encodeURIComponent(requiredIdentifier(operationId, "operationId"))}`,
			),
			"WTK operation response",
		);
		return parseOperation(value.operation);
	}

	async controlOperation(
		operationId: string,
		action: WtkFactoryControlAction,
		message?: string,
	): Promise<WtkFactoryOperation> {
		const value = record(
			await this.#request(
				"POST",
				`/api/executions/${encodeURIComponent(requiredIdentifier(operationId, "operationId"))}/control`,
				{ action, ...(message?.trim() ? { message: message.trim() } : {}) },
			),
			"WTK execution control response",
		);
		return parseOperation(value.operation);
	}

	async loadBundle(pkgIdValue: string): Promise<unknown> {
		const pkgId = packageId(pkgIdValue);
		const packagesRoot = resolve(this.#root, ".wtk", "packages");
		const bundlePath = resolve(packagesRoot, pkgId, "targets", "pi-agents", "bundle.json");
		const pathFromRoot = relative(packagesRoot, bundlePath);
		if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
			throw new Error("WTK package artifact escaped the configured package root");
		}
		try {
			return JSON.parse(await readFile(bundlePath, "utf8")) as unknown;
		} catch (error) {
			throw new Error(`WTK did not produce a Pi team bundle for ${pkgId}`, { cause: error });
		}
	}

	async #health(): Promise<void> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 1_000);
		try {
			const response = await this.#fetch(new URL("/healthz", this.#origin), {
				headers: this.#accessToken ? { authorization: `Bearer ${this.#accessToken}` } : {},
				signal: controller.signal,
			});
			const text = await response.text();
			if (text.length > 4 * 1024) throw new Error("WTK health response exceeded 4 KiB");
			if (!response.ok) throw new Error(`WTK health check failed with HTTP ${response.status}`);
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new Error("WTK health check timed out");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	#accepted(value: unknown): WtkAcceptedOperation {
		const response = record(value, "WTK accepted operation response");
		return {
			operation: parseOperation(response.operation),
			...(typeString(response.sessionId) ? { sessionId: requiredIdentifier(response.sessionId, "sessionId") } : {}),
		};
	}

	#boundedWtkPath(value: unknown, name: string): string {
		const candidate = requiredText(value, name);
		const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(this.#root, candidate);
		const pathFromRoot = relative(this.#root, absolute);
		if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) throw new Error(`${name} must remain inside WTK`);
		return isAbsolute(candidate) ? absolute : candidate;
	}

	async #request(
		method: "GET" | "POST",
		pathname: string,
		body?: Record<string, unknown>,
		timeoutMs = 15_000,
	): Promise<unknown> {
		const url = new URL(pathname, this.#origin);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await this.#fetch(url, {
				method,
				headers: {
					...(body ? { "content-type": "application/json" } : {}),
					...(this.#accessToken ? { authorization: `Bearer ${this.#accessToken}` } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			const text = await response.text();
			if (text.length > 2 * 1024 * 1024) throw new Error("WTK response exceeded 2 MiB");
			let value: unknown;
			try {
				value = text ? (JSON.parse(text) as unknown) : {};
			} catch {
				throw new Error(`WTK returned a non-JSON ${response.status} response`);
			}
			if (!response.ok) {
				const error = recordOrUndefined(value);
				throw new Error(
					typeString(error?.error) ??
						typeString(error?.message) ??
						`WTK request failed with HTTP ${response.status}`,
				);
			}
			return value;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw new Error("WTK request timed out");
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}

function validatedLoopbackOrigin(value: string): URL {
	const origin = new URL(value);
	if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new Error("WTK control URL must use HTTP(S)");
	const hostname = origin.hostname.toLowerCase();
	if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]") {
		throw new Error("WTK control URL must remain on loopback");
	}
	if (origin.username || origin.password || origin.search || origin.hash)
		throw new Error("WTK control URL must be an origin only");
	origin.pathname = "/";
	return origin;
}

function parseOperation(value: unknown): WtkFactoryOperation {
	const operation = record(value, "WTK operation");
	const status = requiredText(operation.status, "operation.status");
	if (!["queued", "running", "paused", "succeeded", "failed", "cancelled"].includes(status)) {
		throw new Error(`Unsupported WTK operation status: ${status}`);
	}
	const error = recordOrUndefined(operation.error);
	const progress = recordOrUndefined(operation.progress);
	return {
		id: requiredIdentifier(operation.id, "operation.id"),
		kind: requiredText(operation.kind, "operation.kind"),
		status: status as WtkFactoryOperationStatus,
		...(operation.result !== undefined ? { result: operation.result } : {}),
		...(error
			? {
					error: {
						message: requiredText(error.message, "operation.error.message"),
						...(typeString(error.code) ? { code: typeString(error.code) } : {}),
					},
				}
			: {}),
		...(progress
			? {
					progress: {
						stage: requiredText(progress.stage, "operation.progress.stage"),
						message: requiredText(progress.message, "operation.progress.message"),
					},
				}
			: {}),
	};
}

function packageId(value: string): string {
	const id = requiredText(value, "pkgId");
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("pkgId must be a lowercase WTK package identifier");
	return id;
}

function requiredIdentifier(value: unknown, name: string): string {
	const id = requiredText(value, name);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) throw new Error(`${name} is invalid`);
	return id;
}

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function typeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
