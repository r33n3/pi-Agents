import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { AgentRoomDefinition } from "./agent-room-service.ts";
import { type TeamMemoryPolicy, teamMemoryPolicySchema } from "./team-memory.ts";

export const teamChatUpdateSchema = Type.Object(
	{
		expectedRevision: Type.Integer({ minimum: 0 }),
		independentAgentIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 8, uniqueItems: true }),
		),
		memoryStrategy: Type.Optional(Type.Union([Type.Literal("team"), Type.Literal("recent"), Type.Literal("none")])),
		memoryPolicy: Type.Optional({
			...teamMemoryPolicySchema,
			description:
				"Whole-team retention policy. Omit when only editing member methods or tool grants. Change only when the user requests a team memory policy change; preserve travel preferences and other unrelated retention purposes.",
		}),
		memberTools: Type.Optional(
			Type.Array(
				Type.Object(
					{
						agentId: Type.String({ minLength: 1, maxLength: 64 }),
						toolIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
							minItems: 1,
							maxItems: 64,
							uniqueItems: true,
						}),
					},
					{ additionalProperties: false },
				),
				{ minItems: 1, maxItems: 8 },
			),
		),
		memberInstructions: Type.Optional(
			Type.Array(
				Type.Object(
					{
						agentId: Type.String({ minLength: 1, maxLength: 64 }),
						instructions: Type.String({
							maxLength: 4096,
							description:
								"Durable methods and success criteria only. Keep one-run assignments, synthetic fixtures, test recipients, prices, dates and temporary restrictions in the current assignment message, not these persistent instructions. Preserve unrelated existing methods.",
						}),
					},
					{ additionalProperties: false },
				),
				{ maxItems: 8 },
			),
		),
		sharedInstructions: Type.Optional(
			Type.String({
				maxLength: 8192,
				description:
					"Persistent team-wide methods only. Omit for a member-only change. Do not turn a current test or configuration-only request into a standing restriction on future work.",
			}),
		),
		taskFacts: Type.Optional(
			Type.Record(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_ -]{0,63}$" }), Type.String({ maxLength: 1024 }), {
				maxProperties: 32,
			}),
		),
		undo: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type TeamChatUpdate = Static<typeof teamChatUpdateSchema>;
interface SavedInstructions {
	memoryStrategy?: AgentRoomDefinition["memoryStrategy"];
	memoryPolicy?: TeamMemoryPolicy;
	members: Array<{ agentId: string; notes?: string }>;
	sharedNotes?: string;
	taskFacts: Record<string, string>;
}
export interface TeamChatState {
	memoryPolicy?: TeamMemoryPolicy;
	revision: number;
	taskFacts: Record<string, string>;
	lastActionId: string;
	receipt: string;
	previous?: SavedInstructions;
}

const validator = Compile(teamChatUpdateSchema);
const stateValidator = Compile(
	Type.Object({
		memoryPolicy: Type.Optional(teamMemoryPolicySchema),
		revision: Type.Integer({ minimum: 1 }),
		taskFacts: Type.Record(Type.String(), Type.String({ maxLength: 1024 }), { maxProperties: 32 }),
		lastActionId: Type.String(),
		receipt: Type.String(),
		previous: Type.Optional(
			Type.Object({
				memoryStrategy: Type.Optional(
					Type.Union([Type.Literal("team"), Type.Literal("recent"), Type.Literal("none")]),
				),
				memoryPolicy: Type.Optional(teamMemoryPolicySchema),
				members: Type.Array(Type.Object({ agentId: Type.String(), notes: Type.Optional(Type.String()) }), {
					maxItems: 8,
				}),
				sharedNotes: Type.Optional(Type.String()),
				taskFacts: Type.Record(Type.String(), Type.String()),
			}),
		),
	}),
);

export function parseTeamChatState(value: unknown): TeamChatState | undefined {
	if (value === undefined) return undefined;
	if (!stateValidator.Check(value)) throw new Error("Invalid saved team update state");
	return structuredClone(value);
}

export function parseTeamChatUpdate(value: unknown): TeamChatUpdate | undefined {
	if (value === undefined) return undefined;
	if (!validator.Check(value)) throw new Error("Invalid team update");
	if (
		value.undo &&
		(value.memberTools !== undefined ||
			value.independentAgentIds !== undefined ||
			value.memoryStrategy !== undefined ||
			value.memoryPolicy !== undefined ||
			value.memberInstructions !== undefined ||
			value.sharedInstructions !== undefined ||
			value.taskFacts !== undefined)
	)
		throw new Error("Undo cannot be combined with edits");
	if (
		!value.undo &&
		value.memoryStrategy === undefined &&
		value.memoryPolicy === undefined &&
		!value.memberTools?.length &&
		!value.memberInstructions?.length &&
		value.sharedInstructions === undefined &&
		!Object.keys(value.taskFacts ?? {}).length
	)
		// Models may include the current revision without requesting a change.
		// Treat this as an omitted update so an otherwise valid turn can proceed.
		return undefined;
	return structuredClone(value);
}

/** Pure preparation: caller must atomically persist before publishing this receipt. */
export function prepareTeamChatUpdate(
	definition: AgentRoomDefinition,
	update: TeamChatUpdate,
	actionId: string,
	approvedToolIds: readonly string[] = [],
) {
	if (definition.chatState?.lastActionId === actionId)
		return { definition: structuredClone(definition), receipt: definition.chatState.receipt };
	const revision = definition.chatState?.revision ?? 0;
	if (update.expectedRevision !== revision)
		throw new Error("Team changed; read the current revision before updating it");
	const next = structuredClone(definition);
	const before: SavedInstructions = {
		memoryStrategy: definition.memoryStrategy,
		memoryPolicy: definition.chatState?.memoryPolicy,
		members: definition.members.map(({ agentId, notes }) => ({ agentId, notes })),
		sharedNotes: definition.sharedNotes,
		taskFacts: { ...definition.chatState?.taskFacts },
	};
	let facts = { ...before.taskFacts };
	let memoryPolicy = before.memoryPolicy;
	const changes: string[] = [];
	if (update.undo) {
		const previous = definition.chatState?.previous;
		if (!previous) throw new Error("No saved team update is available to undo");
		for (const member of previous.members) {
			const target = next.members.find((entry) => entry.agentId === member.agentId);
			if (!target) throw new Error("Team membership changed; review instructions before undoing");
			target.notes = member.notes;
		}
		next.sharedNotes = previous.sharedNotes;
		next.memoryStrategy = previous.memoryStrategy ?? next.memoryStrategy;
		memoryPolicy = previous.memoryPolicy;
		facts = { ...previous.taskFacts };
		changes.push("Restored instructions and task facts from before the last update");
	} else {
		if (update.memoryStrategy !== undefined) {
			next.memoryStrategy = update.memoryStrategy;
			changes.push(`Memory strategy: ${update.memoryStrategy}`);
		}
		if (update.memoryPolicy !== undefined) {
			memoryPolicy = structuredClone(update.memoryPolicy);
			changes.push(
				`Memory: ${memoryPolicy.retain}. Observations expire after ${memoryPolicy.observationTtlHours} hours.`,
			);
		}
		const toolMembers = new Set<string>();
		for (const assignment of update.memberTools ?? []) {
			const member = next.members.find((entry) => entry.agentId === assignment.agentId);
			if (!member || toolMembers.has(assignment.agentId))
				throw new Error("Tool update must name unique current members");
			toolMembers.add(assignment.agentId);
			if (
				assignment.toolIds.some(
					(id) =>
						!definition.toolIds?.includes(id) && !member.toolIds?.includes(id) && !approvedToolIds.includes(id),
				)
			)
				throw new Error("Tool update requires user approval");
			if (member.toolIds === undefined && definition.toolIds === undefined)
				throw new Error("Resolve the member's existing tools before adding tools");
			member.toolIds = [...new Set([...(member.toolIds ?? definition.toolIds ?? []), ...assignment.toolIds])];
			changes.push(`${member.name ?? member.agentId}: added tools ${assignment.toolIds.join(", ")}`);
		}
		// Freeze inherited allocations before widening an existing team allowance.
		if (update.memberTools?.length && next.toolIds !== undefined) {
			for (const member of next.members) member.toolIds ??= [...next.toolIds];
			next.toolIds = [...new Set([...next.toolIds, ...update.memberTools.flatMap((entry) => entry.toolIds)])];
		}
		const seen = new Set<string>();
		for (const member of update.memberInstructions ?? []) {
			const target = next.members.find((entry) => entry.agentId === member.agentId);
			if (!target || seen.has(member.agentId)) throw new Error("Team update must name unique current members");
			seen.add(member.agentId);
			target.notes = member.instructions.trim() || undefined;
			changes.push(
				`${target.name ?? target.agentId}: ${target.notes ? `${target.notes.slice(0, 240)}${target.notes.length > 240 ? "…" : ""}` : "cleared team-specific instructions"}`,
			);
		}
		if (update.sharedInstructions !== undefined) {
			next.sharedNotes = update.sharedInstructions.trim() || undefined;
			changes.push(
				`Shared instructions: ${next.sharedNotes ? `${next.sharedNotes.slice(0, 240)}${next.sharedNotes.length > 240 ? "…" : ""}` : "cleared"}`,
			);
		}
		for (const [key, value] of Object.entries(update.taskFacts ?? {})) {
			if (value.trim()) facts[key] = value.trim();
			else delete facts[key];
			changes.push(`${key}: ${value.trim().slice(0, 160) || "cleared"}`);
		}
		if (Object.keys(facts).length > 32) throw new Error("Team can retain at most 32 task facts");
	}
	const receipt = `Saved team update · revision ${revision + 1}. Applies to the next assignment and future runs in this team.\n${changes.join("\n")}\n${update.memberTools?.length ? "Tool assignments are saved for this team only." : "You can ask the supervisor to undo the last team update."}`;
	next.chatState = {
		memoryPolicy,
		revision: revision + 1,
		taskFacts: facts,
		lastActionId: actionId,
		receipt,
		previous: update.memberTools?.length ? undefined : before,
	};
	next.updatedAt = Date.now();
	return { definition: next, receipt };
}
