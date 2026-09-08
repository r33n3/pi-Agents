import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createAgentSkillTool } from "../src/core/serve/agent-skill-tools.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";

test("confined agents can read discovered Pi skills without arbitrary filesystem access", async () => {
	const { skills } = loadSkillsFromDir({ dir: resolve("test/fixtures/skills/valid-skill"), source: "test" });
	expect(skills).toHaveLength(1);
	const tool = createAgentSkillTool(skills);
	const invoke = (input: unknown) => tool.execute("skill", input, undefined, undefined, {} as never);
	expect(JSON.stringify((await invoke({})).content)).toContain("valid-skill");
	expect(JSON.stringify((await invoke({ name: "valid-skill" })).content)).toContain("description:");
	await expect(invoke({ name: "../../private" })).rejects.toThrow("unavailable");
	const hidden = createAgentSkillTool(skills.map((skill) => ({ ...skill, disableModelInvocation: true })));
	await expect(hidden.execute("skill", { name: "valid-skill" }, undefined, undefined, {} as never)).rejects.toThrow(
		"unavailable",
	);
});
