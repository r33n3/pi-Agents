import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

export const toolHandoffsSchema = Type.Array(
	Type.Object(
		{
			builderId: Type.String({ minLength: 1 }),
			consumerId: Type.String({ minLength: 1 }),
		},
		{ additionalProperties: false },
	),
	{
		maxItems: 8,
		description:
			"For building or updating a reusable report tool then using it, name builder and consumer before dispatch. The host requires successful new registration by that builder and execution of its exact saved version by that consumer. Use [] when no report-tool handoff is required.",
	},
);
export type ToolHandoff = Static<typeof toolHandoffsSchema>[number];
export const toolEvidenceSchema = Type.Array(
	Type.Object(
		{
			kind: Type.Union([Type.Literal("registered"), Type.Literal("rendered")]),
			tool: Type.String({ pattern: "^saved_report_[a-z][a-z0-9_]*_v[1-9][0-9]*$" }),
			reportPath: Type.Optional(Type.String()),
			sha256: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
		},
		{ additionalProperties: false },
	),
	{ maxItems: 64 },
);
export type ToolEvidence = Static<typeof toolEvidenceSchema>[number];

export function parseToolHandoffs(value: unknown): ToolHandoff[] {
	if (value === undefined) return [];
	if (!Compile(toolHandoffsSchema).Check(value)) throw new Error("Invalid tool handoffs");
	return structuredClone(value);
}
export function parseToolEvidence(value: unknown): ToolEvidence[] {
	if (value === undefined) return [];
	if (!Compile(toolEvidenceSchema).Check(value)) throw new Error("Invalid host tool evidence");
	return structuredClone(value);
}

/** Only successful runtime results count; assistant prose and listing old versions never do. */
export function collectToolEvidence(messages: readonly AgentMessage[]): ToolEvidence[] {
	const evidence: ToolEvidence[] = [];
	const calls = new Map(
		messages.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((part) => (part.type === "toolCall" ? [[part.id, part] as const] : []))
				: [],
		),
	);
	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError) continue;
		const call = calls.get(message.toolCallId);
		if (!call || call.name !== message.toolName) continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			try {
				const parsed: unknown = JSON.parse(part.text);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
				const result = parsed as Record<string, unknown>;
				const registered =
					call.name === "report_tools" &&
					call.arguments.action === "register" &&
					result.assigned === false &&
					typeof result.samplesPassed === "number" &&
					result.samplesPassed >= 2;
				const rendered =
					(call.name === result.tool || (call.name === "report_tools" && call.arguments.action === "run")) &&
					typeof result.reportPath === "string" &&
					typeof result.sha256 === "string";
				if (!registered && !rendered) continue;
				evidence.push(
					...parseToolEvidence([
						{
							kind: registered ? "registered" : "rendered",
							tool: result.tool,
							...(rendered ? { reportPath: result.reportPath, sha256: result.sha256 } : {}),
						},
					]),
				);
			} catch {
				/* Non-receipt tool output is not evidence of registration or rendering. */
			}
		}
	}
	return evidence;
}

/** Resolve a handoff from current-run host receipts, never from the supervisor's claimed version. */
export function resolveToolHandoffs(
	handoffs: readonly ToolHandoff[],
	turns: readonly { agentId: string; toolEvidence?: ToolEvidence[] }[],
) {
	return handoffs.map((handoff) => {
		let registrationIndex = -1;
		let tool: string | undefined;
		for (const [index, turn] of turns.entries()) {
			if (turn.agentId !== handoff.builderId) continue;
			const registered = turn.toolEvidence?.filter((entry) => entry.kind === "registered").at(-1);
			if (registered) {
				tool = registered.tool;
				registrationIndex = index;
			}
		}
		const rendered = tool
			? turns
					.slice(registrationIndex + 1)
					.some(
						(turn) =>
							turn.agentId === handoff.consumerId &&
							turn.toolEvidence?.some((entry) => entry.kind === "rendered" && entry.tool === tool),
					)
			: false;
		return { ...handoff, tool, rendered };
	});
}

/** Admission checks run before accepting a member's action, allowing correction in the same turn. */
export function assertToolHandoffContribution(
	context: unknown,
	agentId: string,
	messages: readonly AgentMessage[],
	input: unknown,
): void {
	if (
		typeof context !== "object" ||
		context === null ||
		!("toolHandoffs" in context) ||
		!Array.isArray(context.toolHandoffs)
	)
		return;
	if (typeof input === "object" && input !== null && "outcome" in input && input.outcome === "needs-user") return;
	const evidence = collectToolEvidence(messages);
	for (const handoff of context.toolHandoffs) {
		if (handoff.builderId === agentId && !handoff.tool && !evidence.some((entry) => entry.kind === "registered"))
			throw new Error(
				"The builder has no successful new registration receipt. Correct registration errors and retry report_tools in this turn. Do not hand off or claim success; if correction is impossible, submit needs-user with the concrete blocker for the supervisor.",
			);
		if (
			handoff.consumerId === agentId &&
			!evidence.some((entry) => entry.kind === "rendered" && entry.tool === handoff.tool)
		)
			throw new Error(
				`This assignment requires a successful render using ${handoff.tool ?? "the not-yet-registered new version"}. An older tool or a written claim does not satisfy it. Use the exact assigned tool now, or submit needs-user with the blocker.`,
			);
	}
}
