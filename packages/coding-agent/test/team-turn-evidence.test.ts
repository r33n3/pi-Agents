import { expect, test } from "vitest";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

const schema = {
	type: "object",
	properties: { message: { type: "string" } },
	required: ["message"],
	additionalProperties: false,
};

test("execution claims cannot cite absent or invented tool results", async () => {
	const evidence: Array<{ id: string; name: string }> = [];
	const turn = createTeamTurnTool(schema, [], () => evidence);
	await expect(
		submit(turn, { message: "Registered", workKind: "execution", evidenceToolCallIds: [] }),
	).rejects.toThrow("Execution claims require");
	await expect(
		submit(turn, { message: "Registered", workKind: "execution", evidenceToolCallIds: ["invented"] }),
	).rejects.toThrow("Execution claims require");
	expect(turn.result()).toBeUndefined();
	evidence.push({ id: "registered-call", name: "report_tools" });
	await submit(turn, {
		message: "Registered",
		workKind: "execution",
		evidenceToolCallIds: ["registered-call"],
	});
	expect(JSON.parse(turn.result() ?? "{}")).toEqual({ message: "Registered" });
});

test("reasoning remains allowed but does not certify execution", async () => {
	const turn = createTeamTurnTool(schema, [], () => []);
	await submit(turn, {
		message: "Recommended structure",
		workKind: "analysis",
		evidenceToolCallIds: [],
	});
	expect(JSON.parse(turn.result() ?? "{}").message).toContain("reasoning-only contribution");
});

test("routing and blockers do not require effectful work", async () => {
	for (const workKind of ["routing", "blocked"]) {
		const turn = createTeamTurnTool(schema, [], () => []);
		await submit(turn, { message: "Next step", workKind, evidenceToolCallIds: [] });
		expect(JSON.parse(turn.result() ?? "{}")).toEqual({ message: "Next step" });
	}
});

test("a supervisor can correct an execution submission to an attributed member summary", async () => {
	const turn = createTeamTurnTool(schema, [], () => []);
	const message =
		"The reporting member rendered reports/example.html; its current-run host receipt records the artifact hash.";
	await expect(submit(turn, { message, workKind: "execution", evidenceToolCallIds: ["member-call"] })).rejects.toThrow(
		"submit workKind:analysis",
	);
	expect(turn.result()).toBeUndefined();
	await submit(turn, { message, workKind: "analysis", evidenceToolCallIds: [] });
	const result = JSON.parse(turn.result() ?? "{}");
	expect(result.message).toContain(message);
	expect(result.message).toContain("does not invalidate existing member receipts");
	expect(result).not.toHaveProperty("toolEvidence");
});

function submit(turn: ReturnType<typeof createTeamTurnTool>, input: Record<string, unknown>) {
	return turn.tool.execute("submit", input, undefined, undefined, undefined as never);
}
