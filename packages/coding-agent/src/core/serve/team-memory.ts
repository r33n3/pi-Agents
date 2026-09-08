import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { AgentRoomDefinition, AgentRoomRun, TeamMemoryEntry } from "./agent-room-service.ts";

const memoryFields = {
	key: Type.String({ minLength: 1, maxLength: 64 }),
	text: Type.String({ minLength: 1, maxLength: 1024 }),
	scope: Type.Union([Type.Literal("team"), Type.Literal("private")]),
};
const sourceUrl = Type.String({ maxLength: 2048, pattern: "^https?://[^/?#\\s@]+(?:[/?#][^\\s]*)?$" });
export const teamMemoryEntrySchema = Type.Union([
	Type.Object(
		{ ...memoryFields, kind: Type.Optional(Type.Literal("decision")), sourceUrl: Type.Optional(sourceUrl) },
		{ additionalProperties: false },
	),
	Type.Object({ ...memoryFields, kind: Type.Literal("observation"), sourceUrl }, { additionalProperties: false }),
]);

export const teamMemoryPolicySchema = Type.Object(
	{
		retain: Type.String({ minLength: 1, maxLength: 2048 }),
		observationTtlHours: Type.Number({ minimum: 0.01, maximum: 8760 }),
	},
	{ additionalProperties: false },
);
export type TeamMemoryPolicy = Static<typeof teamMemoryPolicySchema>;
const validator = Compile(teamMemoryPolicySchema);

export function parseTeamMemoryPolicy(value: unknown): TeamMemoryPolicy | undefined {
	if (value === undefined) return undefined;
	if (!validator.Check(value)) throw new Error("Invalid team memory policy");
	return structuredClone(value);
}

/** Latest keys replace earlier versions even when the replacement has expired. */
export function projectTeamMemory(definition: AgentRoomDefinition | undefined, runs: AgentRoomRun[], now = Date.now()) {
	const entries = new Map<
		string,
		TeamMemoryEntry & {
			agentId: string;
			runId: string;
			taskId?: string;
			observedAt: number;
			expiresAt?: number;
		}
	>();
	if (definition?.memoryStrategy !== "team") return [];
	for (const run of [...runs].sort((a, b) => a.createdAt - b.createdAt)) {
		if (run.status !== "completed" || run.createdAt <= (definition.memoryResetAt ?? 0)) continue;
		for (const round of run.rounds)
			for (const turn of round.turns) {
				if (turn.status !== "reply" && turn.status !== "pass") continue;
				for (const memory of turn.remember ?? []) {
					const key = `${memory.scope}:${memory.scope === "private" ? turn.agentId : ""}:${memory.key}`;
					entries.delete(key);
					const expiresAt =
						memory.kind === "observation"
							? round.finishedAt + (definition.chatState?.memoryPolicy?.observationTtlHours ?? 24) * 3600000
							: undefined;
					entries.set(key, {
						...memory,
						agentId: turn.agentId,
						runId: run.id,
						taskId: turn.taskId,
						observedAt: round.finishedAt,
						expiresAt,
					});
				}
			}
	}
	return [...entries.values()].filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now).slice(-32);
}
