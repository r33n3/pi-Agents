import Type, { type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";

/** Captures one validated control action; the host dispatches it after the turn settles. */
export function createTeamTurnTool(schema: Record<string, unknown>, completedAgentIds: string[] = []) {
	const normalized = structuredClone(schema);
	// Historical transport records can omit this field; new supervisor actions cannot.
	if (typeof normalized.properties === "object" && normalized.properties !== null && "plan" in normalized.properties)
		normalized.required = [...new Set([...(Array.isArray(normalized.required) ? normalized.required : []), "plan"])];
	const parameters = normalized as TSchema;
	const validator = Compile(parameters);
	let submitted: string | undefined;
	const tool: ToolDefinition = {
		name: "submit_team_turn",
		label: "Send team message",
		description:
			"Submit your team message and any next assignment, recruitment, tool allocation or memory updates. Before allocating tools, call read_team_context with section tools and a short query; copy the returned catalog IDs into updateTeam.memberTools.toolIds. The host also resolves unique display names and runtime tool names, but never guesses ambiguous providers/accounts/versions. Ask the user which match they want if ambiguous. Enabled connections are available resources, not member assignments; preserve existing tools. Do not claim tools were saved until the host returns a saved receipt. Keep configuration-only requests separate from research execution. Call exactly once after gathering the needed evidence. When plan is present in the schema, interpret the user's request and declare its completion requirements: direct for your own answer, separate-member for an independent member contribution, separate-team for selected team contributions. Name every required team in teamIds; both/all means all selected teams regardless of wording. Explain the plan briefly in message. The host retains the plan and checks contributions; do not impersonate recipients.",
		parameters,
		executionMode: "sequential",
		async execute(_id, input) {
			if (!validator.Check(input)) throw new Error("Team action does not match the permitted schema");
			if (
				typeof input === "object" &&
				input !== null &&
				"outcome" in input &&
				input.outcome === "needs-user" &&
				"message" in input &&
				typeof input.message === "string" &&
				/(?:approval receipt|receipt ID)/i.test(input.message)
			) {
				throw new Error(
					"Receipt IDs are internal host state, not user input. For draft preparation, invoke the current email.draft tool without receiptId or delegate to its assigned member; it resolves user chat authorization. Recheck the current tool before repeating a historical blocker. For a genuine approval or setup gap, ask for the concrete user action, never an internal receipt ID.",
				);
			}
			if (
				typeof input === "object" &&
				input !== null &&
				"requestAgentIds" in input &&
				Array.isArray(input.requestAgentIds) &&
				input.requestAgentIds.some((id) => completedAgentIds.includes(id)) &&
				!(
					"reassignmentReason" in input &&
					typeof input.reassignmentReason === "string" &&
					input.reassignmentReason.trim()
				)
			)
				throw new Error(
					"This member already completed a contribution in this run. Use its result and finish, or provide reassignmentReason describing a concrete defect, new prerequisite, or user correction. Do not repeat completed work merely to obtain another confirmation.",
				);
			if (
				typeof input === "object" &&
				input !== null &&
				"plan" in input &&
				typeof input.plan === "object" &&
				input.plan !== null &&
				"contribution" in input.plan &&
				input.plan.contribution !== "separate-team" &&
				"teamIds" in input.plan &&
				Array.isArray(input.plan.teamIds) &&
				input.plan.teamIds.length > 0
			)
				throw new Error("Only a separate-team plan can name team IDs");
			if (submitted !== undefined) throw new Error("This turn already submitted an action");
			submitted = JSON.stringify(input);
			return {
				content: [
					{
						type: "text",
						text: "Team message recorded. Finish this turn; the host will run any requested assignment.",
					},
				],
				details: undefined,
			};
		},
	};
	return { tool, result: () => submitted };
}

export function createTeamContextTool(context: string): ToolDefinition {
	let parsed: unknown;
	try {
		parsed = JSON.parse(context);
	} catch {
		/* Plain text context is also supported. */
	}
	const tools = typeof parsed === "object" && parsed !== null && "tools" in parsed ? parsed.tools : [];
	const history =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "tools")))
			: context;
	return {
		name: "read_team_context",
		label: "Read team context",
		description:
			"Read retained team results and messages, or section tools for the environment tool catalog with account choices and setup guidance. Before adding a tool, discover it here and copy its exact id into updateTeam.memberTools.toolIds. Use query to filter tool IDs, names or descriptions. If multiple providers/accounts/versions match, ask the user to choose; do not invent an ID. Entries with setup need configuration; entries without setup are available but still need member assignment. Catalog entries do not grant access. History is not fresh evidence. Paginate with character offset.",
		parameters: Type.Object({
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			section: Type.Optional(Type.Union([Type.Literal("history"), Type.Literal("tools")])),
			query: Type.Optional(Type.String({ maxLength: 256 })),
		}),
		async execute(_id, input) {
			const section = typeof input === "object" && input !== null && "section" in input ? input.section : "history";
			const query =
				typeof input === "object" && input !== null && "query" in input && typeof input.query === "string"
					? input.query.toLowerCase()
					: "";
			const selected =
				section === "tools"
					? JSON.stringify(
							Array.isArray(tools)
								? tools.filter((tool) => !query || JSON.stringify(tool).toLowerCase().includes(query))
								: [],
						)
					: history;
			const offset = typeof input === "object" && input !== null && "offset" in input ? Number(input.offset) : 0;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length)
				throw new Error("Invalid context offset");
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							content: selected.slice(offset, offset + 8000),
							nextOffset: offset + 8000 < selected.length ? offset + 8000 : null,
						}),
					},
				],
				details: undefined,
			};
		},
	};
}
