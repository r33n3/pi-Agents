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

function submit(turn: ReturnType<typeof createTeamTurnTool>, input: Record<string, unknown>) {
	return turn.tool.execute("submit", input, undefined, undefined, undefined as never);
}
