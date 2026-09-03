export type AgentDeliverySender =
	| { kind: "user"; id: "local-user"; sessionId: string }
	| { kind: "pi"; sessionId: string }
	| { kind: "agent"; agentId: string; taskId: string; attemptId: string }
	| { kind: "routine"; routineId: string; revision: number }
	| { kind: "workflow"; workflowRunId: string; nodeId: string }
	| { kind: "a2a"; principalId: string; requestId: string };

export type AgentDeliveryContextRef =
	| { kind: "task-result"; taskId: string }
	| { kind: "artifact"; artifactId: string; versionId?: string }
	| { kind: "message"; conversationId: string; sequence: number };

export interface AgentResolvedDeliveryContextRef {
	kind: "task-result" | "artifact" | "message";
	id: string;
	version?: string;
	digest: string;
}

export interface SubmitAgentDelivery {
	idempotencyKey: string;
	recipientAgentId: string;
	goal: string;
	contextRefs: AgentDeliveryContextRef[];
	expectedDeliverable?: { kind?: string; title?: string; artifactId?: string };
}

export interface AgentDeliveryEnvelope {
	version: 1;
	id: string;
	idempotencyScope: string;
	idempotencyKey: string;
	requestDigest: string;
	sender: AgentDeliverySender;
	recipientAgentId: string;
	recipientRevision: number;
	conversationId: string;
	taskId: string;
	parentTaskId?: string;
	goal: string;
	contextRefs: AgentResolvedDeliveryContextRef[];
	expectedDeliverable?: { kind?: string; title?: string; artifactId?: string };
	createdAt: number;
}

export type AgentDeliveryFailureCode =
	| "recipient_unavailable"
	| "recipient_busy"
	| "delegation_not_allowed"
	| "delegation_depth_exceeded"
	| "budget_exhausted"
	| "model_unavailable"
	| "provider_auth_or_access"
	| "provider_quota_limit"
	| "provider_rate_limit"
	| "provider_server_error"
	| "context_overflow"
	| "approval_required"
	| "cancelled"
	| "outcome_unknown"
	| "invalid_request"
	| "internal";

export class AgentDeliveryError extends Error {
	readonly code: AgentDeliveryFailureCode;

	constructor(code: AgentDeliveryFailureCode, message: string) {
		super(message);
		this.name = "AgentDeliveryError";
		this.code = code;
	}
}
