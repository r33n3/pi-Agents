import Type, { type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";
import { assertDeclaredPlanConsistency } from "./team-work-plan.ts";

/** Captures one validated control action; the host dispatches it after the turn settles. */
export function createTeamTurnTool(
	schema: Record<string, unknown>,
	completedAgentIds: string[] = [],
	executionEvidence?: () => Array<{ id: string; name: string }>,
	validateContribution?: (input: unknown) => void,
) {
	const normalized = structuredClone(schema);
	if (
		typeof normalized.properties === "object" &&
		normalized.properties !== null &&
		"toolEvidence" in normalized.properties
	)
		delete normalized.properties.toolEvidence;
	if (executionEvidence && typeof normalized.properties === "object" && normalized.properties !== null) {
		Object.assign(normalized.properties, {
			workKind: {
				type: "string",
				enum: ["analysis", "execution", "routing", "blocked"],
				description:
					"Use execution for actions you performed yourself in this turn: creation, changes, registration, validation, rendering, presentation or delivery. Use analysis for reasoning or a final summary of completed member work: attribute results to the member and rely on host-recorded current-run receipts without claiming you repeated their actions. Do not downgrade a verified member result merely because you lack its tool. Routing assigns future work; blocked reports unfinished work.",
			},
			evidenceToolCallIds: {
				type: "array",
				items: { type: "string" },
				maxItems: 32,
				uniqueItems: true,
				description:
					"Copy successful execution tool call IDs from this turn supporting your own actions. Execution requires at least one; previous runs, context lookups and submission are not execution evidence. For analysis summarizing another member's current-run result, use an empty array and cite the member's host-recorded receipt in your message. Never copy another member's call IDs here or invent IDs.",
			},
		});
		normalized.required = [
			...new Set([
				...(Array.isArray(normalized.required) ? normalized.required : []),
				"workKind",
				"evidenceToolCallIds",
			]),
		];
	}
	if (
		typeof normalized.properties === "object" &&
		normalized.properties !== null &&
		"requestAgentIds" in normalized.properties
	) {
		Object.assign(normalized.properties, {
			independentAssignments: {
				type: "boolean",
				description:
					"Set true only when every requested member can finish without another requested member's new output. Otherwise request only the prerequisite member, wait for its result, then delegate the next step.",
			},
		});
	}
	// Historical transport records can omit these fields; new submissions cannot when their schema declares them.
	if (typeof normalized.properties === "object" && normalized.properties !== null) {
		for (const field of ["plan", "completionStatus"])
			if (field in normalized.properties)
				normalized.required = [
					...new Set([...(Array.isArray(normalized.required) ? normalized.required : []), field]),
				];
	}
	const parameters = normalized as TSchema;
	const validator = Compile(parameters);
	let submitted: string | undefined;
	const tool: ToolDefinition = {
		name: "submit_team_turn",
		label: "Send team message",
		description:
			"Submit your team message and any next assignment, recruitment, tool allocation or memory updates. Before allocating tools, call read_team_context with section tools and a short query; copy the returned catalog IDs into updateTeam.memberTools.toolIds. The host also resolves unique display names and runtime tool names, but never guesses ambiguous providers/accounts/versions. Ask the user which match they want if ambiguous. Enabled connections are available resources, not member assignments; preserve existing tools. Do not claim tools were saved until the host returns a saved receipt. Keep configuration-only requests separate from research execution. Call exactly once after gathering the needed evidence. When plan is present in the schema, interpret the user's request and declare its completion requirements: direct for your own answer, separate-member for an independent member contribution, separate-team for selected team contributions. Name every required team in teamIds; both/all means all selected teams regardless of wording. For a final response, message must contain the requested result, not merely a plan or promise to produce it. For routing, message must state the assignment and expected deliverable. The host retains the plan and checks contributions; do not impersonate recipients.",
		parameters,
		executionMode: "sequential",
		async execute(_id, input) {
			if (!validator.Check(input)) throw new Error("Team action does not match the permitted schema");
			if (
				typeof input === "object" &&
				input !== null &&
				"completionStatus" in input &&
				input.completionStatus === "complete" &&
				"workKind" in input &&
				(input.workKind === "routing" || input.workKind === "blocked")
			)
				throw new Error(`${input.workKind} work is unfinished and requires completionStatus:incomplete`);
			validateContribution?.(input);
			if (
				executionEvidence &&
				typeof input === "object" &&
				input !== null &&
				"workKind" in input &&
				"evidenceToolCallIds" in input &&
				Array.isArray(input.evidenceToolCallIds)
			) {
				const evidence = executionEvidence();
				if (
					input.evidenceToolCallIds.some((id) => !evidence.some((entry) => entry.id === id)) ||
					(input.workKind === "execution" && input.evidenceToolCallIds.length === 0)
				)
					throw new Error(
						`Execution claims require successful tool evidence from this turn. Available evidence: ${JSON.stringify(evidence)}. If you are summarizing completed member work, submit workKind:analysis with evidenceToolCallIds:[] and attribute the result to its current-run host receipt; you do not need to repeat the action or report a blocker just because you lack the member's tool. For your own unfinished actions, perform the work or report it as blocked. Historical messages alone do not prove completion.`,
					);
			}
			if (
				typeof input === "object" &&
				input !== null &&
				"requestAgentIds" in input &&
				Array.isArray(input.requestAgentIds) &&
				input.requestAgentIds.length > 1 &&
				!("independentAssignments" in input && input.independentAssignments === true)
			) {
				throw new Error(
					"Multiple members execute with the same context and cannot see one another's new output. For build then report/deliver, request only the builder now; wait for its result before requesting the reporter. Set independentAssignments:true only for genuinely independent work.",
				);
			}
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
			if (typeof input === "object" && input !== null && "plan" in input) assertDeclaredPlanConsistency(input.plan);
			if (submitted !== undefined) throw new Error("This turn already submitted an action");
			// Independence is checked at admission; the existing room action contract stays unchanged.
			submitted = JSON.stringify(
				typeof input === "object" && input !== null
					? Object.fromEntries(
							Object.entries(input)
								.filter(([key]) => !["independentAssignments", "workKind", "evidenceToolCallIds"].includes(key))
								.map(([key, value]) => [
									key,
									key === "message" &&
									executionEvidence &&
									"workKind" in input &&
									input.workKind === "analysis"
										? `${value}\nHost evidence: reasoning-only contribution; this action certifies no new execution effects and does not invalidate existing member receipts.`
										: value,
								]),
						)
					: input,
			);
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

export function teamHistoryGuidance(context: unknown): string | undefined {
	if (
		typeof context !== "object" ||
		context === null ||
		!("priorPublicResultIndex" in context) ||
		!Array.isArray(context.priorPublicResultIndex)
	)
		return undefined;
	const index = context.priorPublicResultIndex;
	const displayed = index.slice(0, 10).flatMap((value) => {
		if (typeof value !== "object" || value === null) return [];
		const entry = value as Record<string, unknown>;
		if (
			typeof entry.runId !== "string" ||
			typeof entry.status !== "string" ||
			typeof entry.goal !== "string" ||
			typeof entry.resultCount !== "number"
		)
			return [];
		return [
			{
				runId: entry.runId.slice(0, 128),
				status: entry.status.slice(0, 32),
				goal: entry.goal.slice(0, 300),
				resultCount: entry.resultCount,
			},
		];
	});
	return [
		`Authoritative prior public-result availability index: showing ${displayed.length} newest of ${index.length} indexed runs (historical evidence, not current-run receipts): ${JSON.stringify(displayed)}.`,
		index.length > 0
			? "A positive resultCount means public completed-member text is retained on demand. Older results omitted from this prompt remain searchable through read_team_context section history. Before declaring earlier evidence missing or unavailable, query history using distinctive goal, source, author or run terms. Paginate matching content when nextOffset is not null. Historical results inform the current task but never satisfy current-run staffing or execution requirements."
			: "No prior public completed-member results are indexed. If the current request refers to earlier work, query read_team_context section history before claiming a lookup found no relevant retained request or result.",
	].join("\n");
}

export function createTeamContextTool(context: string): ToolDefinition {
	let parsed: unknown;
	try {
		parsed = JSON.parse(context);
	} catch {
		/* Plain text context is also supported. */
	}
	const tools = typeof parsed === "object" && parsed !== null && "tools" in parsed ? parsed.tools : [];
	const historyValue =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "tools"))
			: undefined;
	const history = historyValue === undefined ? context : JSON.stringify(historyValue);
	return {
		name: "read_team_context",
		label: "Read team context",
		description:
			"Read retained team results and messages, or section tools for the environment tool catalog with account choices and setup guidance. For history, use query with distinctive goal, source, author or run terms to return only matching retained records before declaring earlier evidence unavailable; paginate while nextOffset is not null. Before adding a tool, discover it here and copy its exact id into updateTeam.memberTools.toolIds. Tool queries filter IDs, names or descriptions. If multiple providers/accounts/versions match, ask the user to choose; do not invent an ID. Entries with setup need configuration; entries without setup are available but still need member assignment. Catalog entries do not grant access. History is not fresh evidence and does not satisfy current-run receipts. Paginate with character offset.",
		parameters: Type.Object({
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			section: Type.Optional(Type.Union([Type.Literal("history"), Type.Literal("tools")])),
			query: Type.Optional(Type.String({ maxLength: 256 })),
		}),
		async execute(_id, input) {
			const section = typeof input === "object" && input !== null && "section" in input ? input.section : "history";
			const query =
				typeof input === "object" && input !== null && "query" in input && typeof input.query === "string"
					? input.query.toLowerCase().trim()
					: "";
			const catalog = Array.isArray(tools) ? tools : [];
			const exact = catalog.filter((tool) => !query || JSON.stringify(tool).toLowerCase().includes(query));
			const terms = query.split(/[\s,;]+/u).filter(Boolean);
			const matches = exact.length
				? exact
				: catalog.filter((tool) => terms.some((term) => JSON.stringify(tool).toLowerCase().includes(term)));
			const searchableHistoryKeys = ["priorRequests", "turns", "childResults", "memory"];
			const queriedHistory =
				section === "history" && query && historyValue
					? Object.fromEntries(
							searchableHistoryKeys.flatMap((key) => {
								const value = historyValue[key];
								if (!Array.isArray(value)) return [];
								const records = value.filter((entry) => {
									const text = JSON.stringify(entry).toLowerCase();
									return text.includes(query) || terms.every((term) => text.includes(term));
								});
								return records.length > 0 ? [[key, records]] : [];
							}),
						)
					: undefined;
			const historyMatchCount = queriedHistory
				? Object.values(queriedHistory).reduce(
						(total, value) => total + (Array.isArray(value) ? value.length : 0),
						0,
					)
				: undefined;
			const selected =
				section === "tools" ? JSON.stringify(matches) : queriedHistory ? JSON.stringify(queriedHistory) : history;
			const offset = typeof input === "object" && input !== null && "offset" in input ? Number(input.offset) : 0;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length)
				throw new Error("Invalid context offset");
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							...(section === "tools"
								? {
										catalogCount: catalog.length,
										matchCount: matches.length,
										guidance:
											matches.length === 0 && catalog.length > 0
												? "No tools matched this query. The catalog is not empty. Retry without query and paginate; do not report missing environment tools from this filtered result."
												: undefined,
									}
								: query
									? {
											matchCount: historyMatchCount,
											guidance:
												historyMatchCount === 0
													? "No retained requests or results matched this query. Try different distinctive goal, source, author or run terms before declaring earlier evidence unavailable."
													: "Matching historical records follow. They are not current-run receipts; paginate while nextOffset is not null.",
										}
									: {}),
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
