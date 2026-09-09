import { expect, test } from "vitest";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

const schema = {
	type: "object",
	properties: { message: { type: "string" } },
	required: ["message"],
	additionalProperties: false,
};

const completionSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		completionStatus: { enum: ["complete", "incomplete"] },
	},
	required: ["message"],
	additionalProperties: false,
};

const planSchema = {
	type: "object",
	properties: {
		message: { type: "string" },
		completionStatus: { enum: ["complete", "incomplete"] },
		plan: {
			type: "object",
			properties: {
				contribution: { enum: ["direct", "separate-member", "separate-team"] },
				teamIds: { type: "array", items: { type: "string" } },
				memberIds: { type: "array", items: { type: "string" } },
				toolHandoffs: { type: "array", items: { type: "object" } },
				reason: { type: "string" },
			},
			required: ["contribution", "teamIds", "memberIds", "toolHandoffs", "reason"],
			additionalProperties: false,
		},
	},
	required: ["message"],
	additionalProperties: false,
};

test("declared completion state is required on every new submission", async () => {
	const turn = createTeamTurnTool(completionSchema, [], () => []);
	await expect(
		submit(turn, { message: "Report: net is 1520.", workKind: "analysis", evidenceToolCallIds: [] }),
	).rejects.toThrow("permitted schema");
	expect(turn.result()).toBeUndefined();
	await submit(turn, {
		message: "Report: net is 1520.",
		completionStatus: "complete",
		workKind: "analysis",
		evidenceToolCallIds: [],
	});
	expect(JSON.parse(turn.result() ?? "{}").completionStatus).toBe("complete");
});

test.each(["routing", "blocked"])("%s work cannot declare completion", async (workKind) => {
	const turn = createTeamTurnTool(completionSchema, [], () => []);
	await expect(
		submit(turn, {
			message: "The requested result is not complete.",
			completionStatus: "complete",
			workKind,
			evidenceToolCallIds: [],
		}),
	).rejects.toThrow("completionStatus:incomplete");
	expect(turn.result()).toBeUndefined();
	await submit(turn, {
		message: "The requested result is not complete.",
		completionStatus: "incomplete",
		workKind,
		evidenceToolCallIds: [],
	});
	expect(JSON.parse(turn.result() ?? "{}").completionStatus).toBe("incomplete");
});

test("a completed answer may offer optional follow-up", async () => {
	const turn = createTeamTurnTool(completionSchema, [], () => []);
	await submit(turn, {
		message: "Report: net is 1520. I can provide a chart if wanted.",
		completionStatus: "complete",
		workKind: "analysis",
		evidenceToolCallIds: [],
	});
	expect(JSON.parse(turn.result() ?? "{}").message).toContain("net is 1520");
});

test("an inconsistent direct staffing plan can be corrected before submission commits", async () => {
	const turn = createTeamTurnTool(planSchema, [], () => []);
	const base = {
		message: "Use the retained specialist result.",
		completionStatus: "incomplete",
		workKind: "analysis",
		evidenceToolCallIds: [],
	};
	await expect(
		submit(turn, {
			...base,
			plan: {
				contribution: "direct",
				teamIds: [],
				memberIds: ["researcher"],
				toolHandoffs: [],
				reason: "Research is required",
			},
		}),
	).rejects.toThrow("separate-member or separate-team");
	expect(turn.result()).toBeUndefined();
	await submit(turn, {
		...base,
		plan: {
			contribution: "separate-member",
			teamIds: [],
			memberIds: ["researcher"],
			toolHandoffs: [],
			reason: "Research is required",
		},
	});
	expect(JSON.parse(turn.result() ?? "{}").plan).toMatchObject({
		contribution: "separate-member",
		memberIds: ["researcher"],
	});
});

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
