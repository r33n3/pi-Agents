import Type from "typebox";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

test("receipt bookkeeping cannot become a user question; corrected action remains possible", async () => {
	const turn = createTeamTurnTool({ ...Type.Object({ outcome: Type.String(), message: Type.String() }) });
	await expect(
		turn.tool.execute(
			"bad",
			{ outcome: "needs-user", message: "Please provide the approval receipt ID" },
			undefined,
			undefined,
			{} as ExtensionContext,
		),
	).rejects.toThrow("internal host state");
	expect(turn.result()).toBeUndefined();
	await turn.tool.execute(
		"fixed",
		{ outcome: "reply", message: "The reporting member will prepare the approved draft." },
		undefined,
		undefined,
		{} as ExtensionContext,
	);
	expect(turn.result()).toContain("reporting member");
});
