import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, test } from "vitest";
import {
	assertToolHandoffContribution,
	collectToolEvidence,
	resolveToolHandoffs,
	toolEvidenceSchema,
} from "../src/core/serve/team-tool-handoff.ts";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

function messages(action: string, result: unknown, isError = false): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "call", name: "report_tools", arguments: { action } }],
			api: "openai-responses",
			provider: "fixture",
			model: "fixture",
			stopReason: "toolUse",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
		{
			role: "toolResult",
			toolName: "report_tools",
			toolCallId: "call",
			content: [{ type: "text", text: JSON.stringify(result) }],
			isError,
			timestamp: 2,
		},
	];
}
const oldTool = "saved_report_example_v1";
const newTool = "saved_report_example_v2";
const handoffs = [{ builderId: "builder", consumerId: "reporter" }];
test("registration receipts exclude listings, failures and invented prose", () => {
	const receipt = { tool: newTool, assigned: false, samplesPassed: 2 };
	expect(collectToolEvidence(messages("register", receipt))).toEqual([{ kind: "registered", tool: newTool }]);
	expect(collectToolEvidence(messages("list", receipt))).toEqual([]);
	expect(collectToolEvidence(messages("register", receipt, true))).toEqual([]);
	expect(collectToolEvidence(messages("register", { message: "Registered v2" }))).toEqual([]);
});
test("the consumer must render the builder's exact new version after registration", () => {
	const registered = collectToolEvidence(messages("register", { tool: newTool, assigned: false, samplesPassed: 2 }));
	const render = (tool: string) =>
		collectToolEvidence(messages("run", { tool, reportPath: `reports/${tool}/one.html`, sha256: "a".repeat(64) }));
	expect(resolveToolHandoffs(handoffs, [{ agentId: "reporter", toolEvidence: render(oldTool) }])[0]).toMatchObject({
		tool: undefined,
		rendered: false,
	});
	const turns = [
		{ agentId: "builder", toolEvidence: registered },
		{ agentId: "reporter", toolEvidence: render(oldTool) },
	];
	expect(resolveToolHandoffs(handoffs, turns)[0]).toMatchObject({ tool: newTool, rendered: false });
	turns.push({ agentId: "reporter", toolEvidence: render(newTool) });
	expect(resolveToolHandoffs(handoffs, turns)[0]).toMatchObject({ tool: newTool, rendered: true });
	expect(resolveToolHandoffs(handoffs, [...turns].reverse())[0].rendered).toBe(false);
});
test("models cannot submit their own host tool evidence", async () => {
	const turn = createTeamTurnTool({
		type: "object",
		properties: { message: { type: "string" }, toolEvidence: toolEvidenceSchema },
		required: ["message"],
		additionalProperties: false,
	});
	await expect(
		turn.tool.execute(
			"submit",
			{ message: "Done", toolEvidence: [{ kind: "registered", tool: newTool }] },
			undefined,
			undefined,
			undefined as never,
		),
	).rejects.toThrow("schema");
});

test("members repair missing registration and stale-version use before submitting", () => {
	const context = { toolHandoffs: handoffs };
	expect(() => assertToolHandoffContribution(context, "builder", [], { outcome: "reply" })).toThrow(
		"no successful new registration",
	);
	expect(() => assertToolHandoffContribution(context, "builder", [], { outcome: "needs-user" })).not.toThrow();
	const registered = messages("register", { tool: newTool, assigned: false, samplesPassed: 2 });
	expect(() => assertToolHandoffContribution(context, "builder", registered, { outcome: "reply" })).not.toThrow();
	const assigned = { toolHandoffs: [{ ...handoffs[0], tool: newTool }] };
	const render = (tool: string) =>
		messages("run", { tool, reportPath: "reports/result.html", sha256: "a".repeat(64) });
	expect(() => assertToolHandoffContribution(assigned, "reporter", render(oldTool), { outcome: "reply" })).toThrow(
		newTool,
	);
	expect(() =>
		assertToolHandoffContribution(assigned, "reporter", render(newTool), { outcome: "reply" }),
	).not.toThrow();
});
