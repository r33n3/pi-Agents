import type { AgentSession } from "../agent-session.ts";

/** Repair the missing control envelope once without replaying completed tool effects. */
export async function recoverTeamTurn(
	session: Pick<AgentSession, "getActiveToolNames" | "setActiveToolsByName" | "prompt">,
	result: () => string | undefined,
): Promise<void> {
	if (result()) return;
	const active = session.getActiveToolNames();
	session.setActiveToolsByName(["submit_team_turn"]);
	try {
		await session.prompt(
			"Your work has finished but the required team action was not submitted. Using the existing results, call submit_team_turn now with the observed outcome and any remaining assignment. Only this submission tool is available during this single repair attempt. Do not redo work, invent successful results, or claim completion if requirements remain. If blocked, report the concrete blocker. Then finish briefly.",
			{ source: "rpc" },
		);
		if (!result()) throw new Error("Agent finished without submitting its team action after one repair attempt");
	} finally {
		session.setActiveToolsByName(active);
	}
}
