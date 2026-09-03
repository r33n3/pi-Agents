import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentDeliveryContextRef, AgentDeliverySender } from "./agent-collaboration-contract.ts";
import type { AgentCollaborationService, AgentDeliveryReceipt } from "./agent-collaboration-service.ts";
import type { AgentTaskService } from "./agent-task-service.ts";

const contextReference = Type.Union([
	Type.Object({ kind: Type.Literal("task-result"), taskId: Type.String({ minLength: 1, maxLength: 128 }) }),
	Type.Object({
		kind: Type.Literal("artifact"),
		artifactId: Type.String({ minLength: 1, maxLength: 128 }),
		versionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	}),
	Type.Object({
		kind: Type.Literal("message"),
		conversationId: Type.String({ minLength: 1, maxLength: 128 }),
		sequence: Type.Integer({ minimum: 0 }),
	}),
]);

const delegateParameters = Type.Object({
	recipientAgentId: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
	goal: Type.String({ minLength: 1, maxLength: 16_384 }),
	idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" }),
	contextRefs: Type.Optional(Type.Array(contextReference, { maxItems: 16 })),
	expectedDeliverable: Type.Optional(
		Type.Object({
			kind: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			artifactId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		}),
	),
});
const deliveryParameters = Type.Object({
	deliveryId: Type.String({ minLength: 1, maxLength: 128 }),
});
type DelegateAgentTool = ToolDefinition<typeof delegateParameters, AgentDeliveryReceipt>;
type DeliveryActionTool = ToolDefinition<typeof deliveryParameters, AgentDeliveryReceipt>;

/** Creates run-bound collaboration tools; the caller cannot supply sender authority. */
export function createAgentCollaborationTools(
	service: AgentCollaborationService,
	tasks: AgentTaskService,
	context: { agentId: string; runId: string },
): [DelegateAgentTool, DeliveryActionTool, DeliveryActionTool] {
	const sender = (): AgentDeliverySender => {
		const task = tasks.findTaskByAttempt(context.runId);
		if (!task || task.agentId !== context.agentId) throw new Error("The active run does not own an agent task");
		return { kind: "agent", agentId: context.agentId, taskId: task.id, attemptId: context.runId };
	};
	return [
		{
			name: "delegate_agent",
			label: "delegate_agent",
			description: "Queue durable work for one explicitly allowed local agent and return a delivery receipt.",
			promptSnippet:
				"Use a stable idempotencyKey for one logical delegation and reuse it for retries. Pass only explicit bounded context references. Continue independently unless the result is required now.",
			parameters: delegateParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const receipt = await service.submit(sender(), {
					...parameters,
					contextRefs: (parameters.contextRefs ?? []) as AgentDeliveryContextRef[],
				});
				return textResult(receipt);
			},
		},
		{
			name: "inspect_delegation",
			label: "inspect_delegation",
			description: "Inspect a delivery created by this source task.",
			parameters: deliveryParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { deliveryId }) {
				return textResult(await service.inspect(deliveryId, sender()));
			},
		},
		{
			name: "cancel_delegation",
			label: "cancel_delegation",
			description: "Cancel a queued or active delivery created by this source task.",
			parameters: deliveryParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { deliveryId }) {
				return textResult(await service.cancel(deliveryId, sender()));
			},
		},
	];
}

function textResult(value: AgentDeliveryReceipt) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}
