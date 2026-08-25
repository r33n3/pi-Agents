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

export interface GovernedActionRequest<TTarget, TCredentials, TResult> {
	family: string;
	target: TTarget;
	identities?: ServeAuditIdentities;
	canonicalize: (target: TTarget) => ServeAuditActionInput["target"];
	authorize: (context: {
		action: ServeAuditActionInput;
		identities?: ServeAuditIdentities;
	}) => Promise<GovernedActionDecision> | GovernedActionDecision;
	resolveCredentials?: () => Promise<TCredentials>;
	dispatch: (context: { action: ServeAuditActionInput; credentials: TCredentials | undefined }) => Promise<TResult>;
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
		try {
			authorization = await request.authorize({ action, identities: request.identities });
		} catch {
			authorization = {
				decision: "deny",
				reason: "Authorization evaluation failed closed",
				policy: "invalid",
			};
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
			const credentials = await request.resolveCredentials?.();
			const value = await request.dispatch({ action, credentials });
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
					outcome: error instanceof GovernedActionCancelledError ? "cancelled" : "failed",
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
	constructor(message = "Action was cancelled") {
		super(message);
		this.name = "GovernedActionCancelledError";
	}
}

function elapsed(now: number, startedAt: number): number {
	return Math.max(0, Math.min(Math.round(now - startedAt), 30 * 24 * 60 * 60 * 1000));
}

function safeError(error: unknown): {
	classification: ServeAuditErrorClassification;
	code?: string;
	message: string;
} {
	if (error instanceof GovernedActionCancelledError) {
		return { classification: "cancelled", message: error.message };
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
