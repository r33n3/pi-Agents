import { readFile } from "node:fs/promises";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { Skill } from "../skills.ts";

/** Read only Pi-discovered, model-invocable skill entry points; never arbitrary host files. */
export function createAgentSkillTool(skills: Skill[]): ToolDefinition {
	const available = skills.filter((skill) => !skill.disableModelInvocation);
	return {
		name: "read_agent_skill",
		label: "Read agent skill",
		description:
			"List available Pi skills, or read one by its exact name before applying it. Skills supply methods, not tool grants. Required tools and references remain subject to your assigned access.",
		parameters: Type.Object({ name: Type.Optional(Type.String()) }),
		async execute(_id, input) {
			const name = typeof input === "object" && input !== null && "name" in input ? input.name : undefined;
			if (name === undefined)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(available.map(({ name, description }) => ({ name, description }))),
						},
					],
					details: undefined,
				};
			const skill = available.find((entry) => entry.name === name);
			if (!skill) throw new Error("Skill is unavailable. List available skills and select an exact name.");
			const content = await readFile(skill.filePath, "utf8");
			if (Buffer.byteLength(content) > 64000) throw new Error("Skill exceeds the 64 KB entry-point limit");
			return { content: [{ type: "text", text: content }], details: { name: skill.name } };
		},
	};
}
