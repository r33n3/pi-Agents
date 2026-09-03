import type { CapabilityApprovalOwner } from "./capability-approval-service.ts";
import type {
	ServeAuditActionInput,
	ServeAuditErrorClassification,
	ServeAuditIdentities,
	ServeAuditStore,
} from "./serve-audit-store.ts";

export interface GovernedActionDecision {
	decision: "allow" | "deny";
	reason: string;
	policy?: string;
	grant?: string;
	approval?: string;
}

export interface ActionAuthority {
	owner: CapabilityApprovalOwner;
	signal?: AbortSignal;
	assertLive: () => void;
}

export interface GovernedActionRequest<TTarget, TCredentials, TResult> {
	family: string;
	target: TTarget;
	identities?: ServeAuditIdentities;
	authority?: ActionAuthority;
	canonicalize: (target: TTarget) => ServeAuditActionInput["target"];
	authorize: (context: {
		action: ServeAuditActionInput;
		identities?: ServeAuditIdentities;
	}) => Promise<GovernedActionDecision> | GovernedActionDecision;
	resolveCredentials?: () => Promise<TCredentials>;
	dispatch: (context: {
		action: ServeAuditActionInput;
		credentials: TCredentials | undefined;
		authority?: ActionAuthority;
	}) => Promise<TResult>;
}

export type GovernedActionResult<TResult> =
	| { status: "denied"; correlationId: string; reason: string }
	| { status: "succeeded"; correlationId: string; value: TResult };

export class GovernedActionOutcomeUnknownError extends Error {
	readonly correlationId: string;

	constructor(correlationId: string, cause: unknown) {
		super(`Governed action outcome could not be recorded; reconcile correlation ${correlationId} before retrying`, {
			cause,
		});
		this.name = "GovernedActionOutcomeUnknownError";
		this.correlationId = correlationId;
	}
}

/**
 * Owns the security-critical order for privileged effects. Authorization must
 * be durably recorded before credentials are resolved or dispatch can begin.
 */
export class GovernedActionService {
	readonly #audit: ServeAuditStore;
	readonly #now: () => number;

	constructor(audit: ServeAuditStore, options: { now?: () => number } = {}) {
		this.#audit = audit;
		this.#now = options.now ?? Date.now;
	}

	async execute<TTarget, TCredentials, TResult>(
		request: GovernedActionRequest<TTarget, TCredentials, TResult>,
	): Promise<GovernedActionResult<TResult>> {
		const action: ServeAuditActionInput = {
			family: request.family,
			target: request.canonicalize(request.target),
		};
		let authorization: GovernedActionDecision;
		let cancellationAfterAuthorization: GovernedActionCancelledError | undefined;
		try {
			assertActionAuthority(request.authority);
			authorization = await request.authorize({ action, identities: request.identities });
			try {
				assertActionAuthority(request.authority);
			} catch (error) {
				cancellationAfterAuthorization = cancelledError(error);
			}
		} catch (error) {
			if (error instanceof GovernedActionCancelledError) {
				authorization = {
					decision: "deny",
					reason: error.message,
					policy: "inactive-authority",
				};
			} else {
				authorization = {
					decision: "deny",
					reason: "Authorization evaluation failed closed",
					policy: "invalid",
				};
			}
		}
		const decision = await this.#audit.appendDecision({
			identities: request.identities,
			action,
			...authorization,
		});
		if (authorization.decision === "deny") {
			return { status: "denied", correlationId: decision.correlationId, reason: authorization.reason };
		}

		const startedAt = this.#now();
		try {
			if (cancellationAfterAuthorization) throw cancellationAfterAuthorization;
			assertActionAuthority(request.authority);
			const credentials = await request.resolveCredentials?.();
			assertActionAuthority(request.authority);
			const value = await request.dispatch({ action, credentials, authority: request.authority });
			assertActionAuthority(request.authority);
			try {
				await this.#audit.appendOutcome({
					correlationId: decision.correlationId,
					identities: request.identities,
					action: decision.action,
					outcome: "succeeded",
					durationMs: elapsed(this.#now(), startedAt),
				});
			} catch (error) {
				throw new GovernedActionOutcomeUnknownError(decision.correlationId, error);
			}
			return { status: "succeeded", correlationId: decision.correlationId, value };
		} catch (error) {
			if (error instanceof GovernedActionOutcomeUnknownError) throw error;
			try {
				await this.#audit.appendOutcome({
					correlationId: decision.correlationId,
					identities: request.identities,
					action: decision.action,
					outcome: isGovernedActionCancellation(error) ? "cancelled" : "failed",
					durationMs: elapsed(this.#now(), startedAt),
					error: safeError(error),
				});
			} catch (auditError) {
				throw new GovernedActionOutcomeUnknownError(decision.correlationId, auditError);
			}
			throw error;
		}
	}
}

export class GovernedActionCancelledError extends Error {
	constructor(message = "Action was cancelled", options: ErrorOptions = {}) {
		super(message, options);
		this.name = "GovernedActionCancelledError";
	}
}

export function assertActionAuthority(authority: ActionAuthority | undefined): void {
	if (!authority) return;
	if (authority.signal?.aborted) throw new GovernedActionCancelledError("Action authority was cancelled");
	try {
		authority.assertLive();
	} catch (error) {
		if (error instanceof GovernedActionCancelledError) throw error;
		throw cancelledError(error);
	}
	if (authority.signal?.aborted) throw new GovernedActionCancelledError("Action authority was cancelled");
}

export function isGovernedActionCancellation(error: unknown): boolean {
	if (error instanceof GovernedActionCancelledError) return true;
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR");
}

function cancelledError(error: unknown): GovernedActionCancelledError {
	return new GovernedActionCancelledError(
		error instanceof Error && error.message ? error.message : "Action authority is no longer live",
		{ cause: error },
	);
}

function elapsed(now: number, startedAt: number): number {
	return Math.max(0, Math.min(Math.round(now - startedAt), 30 * 24 * 60 * 60 * 1000));
}

function safeError(error: unknown): {
	classification: ServeAuditErrorClassification;
	code?: string;
	message: string;
} {
	if (isGovernedActionCancellation(error)) {
		return { classification: "cancelled", message: error instanceof Error ? error.message : "Action was cancelled" };
	}
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		return { classification: classify(code), code, message: error.message || error.name };
	}
	return { classification: "internal", message: "Privileged action failed" };
}

function classify(code: string | undefined): ServeAuditErrorClassification {
	if (!code) return "internal";
	if (code === "ABORT_ERR") return "cancelled";
	if (code === "ETIMEDOUT") return "timeout";
	if (code === "ENOENT") return "not-found";
	if (code === "EACCES" || code === "EPERM") return "authorization";
	if (code === "EEXIST" || code === "EBUSY") return "conflict";
	return "dependency";
}
