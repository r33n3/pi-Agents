import { expect, test } from "vitest";
import { teamMemberProfile } from "../src/core/serve/team-member-profile.ts";

const agent = {
	id: "builder",
	revision: 3,
	name: "Designer",
	description: "Reusable report design",
	persona: "Create or update templates; routine reports use the saved renderer.",
	tools: ["read", "write"],
};

test("projects existing instructions and keeps team context separate", () => {
	const profile = teamMemberProfile(agent, { role: "HTML builder", notes: "Return a validated template ID." });
	expect(profile).toMatchObject({
		revision: 3,
		instructions: agent.persona,
		teamInstructions: "Return a validated template ID.",
		role: "HTML builder",
	});
	expect(profile.assignedToolIds).toEqual(["read", "write"]);
});

test("explicit empty member grants do not inherit wider team or agent permissions", () => {
	expect(teamMemberProfile(agent, { role: "Designer", toolIds: [] }, ["report_tools"]).assignedToolIds).toEqual([]);
	expect(teamMemberProfile(agent, { role: "Designer" }, ["report_tools"]).assignedToolIds).toEqual(["report_tools"]);
	const memberTools = ["read"];
	const profile = teamMemberProfile(agent, { role: "Designer", toolIds: memberTools });
	profile.assignedToolIds.push("write");
	expect(memberTools).toEqual(["read"]);
});
