import { expect, test } from "vitest";
import type { AgentRoomDefinition, AgentRoomRun, TeamMemoryEntry } from "../src/core/serve/agent-room-service.ts";
import { parseTeamChatUpdate, prepareTeamChatUpdate } from "../src/core/serve/team-chat-update.ts";
import { projectTeamMemory, teamMemoryEntrySchema } from "../src/core/serve/team-memory.ts";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

const definition: AgentRoomDefinition = {
	version: 1,
	id: "flights",
	name: "Flights",
	purpose: "Find verifiable offers",
	members: [{ agentId: "researcher", role: "Research" }],
	conversationId: "chat",
	memoryStrategy: "team",
	createdAt: 1,
	updatedAt: 1,
	limits: {
		maxRounds: 3,
		maxMessages: 12,
		maxConcurrency: 1,
		maxDurationMs: 60000,
		maxTotalTokens: 10000,
		maxCostUsd: 1,
	},
};

test("an invalid observation can be corrected before a team turn is committed", async () => {
	const turn = createTeamTurnTool({
		type: "object",
		properties: { remember: { type: "array", items: teamMemoryEntrySchema } },
		required: ["remember"],
	});
	const entry = { key: "report", text: "Created report.html", kind: "observation", scope: "team" };
	await expect(turn.tool.execute("invalid", { remember: [entry] }, undefined, undefined, {} as never)).rejects.toThrow(
		"schema",
	);
	expect(turn.result()).toBeUndefined();
	await turn.tool.execute(
		"corrected",
		{ remember: [{ ...entry, kind: "decision" }] },
		undefined,
		undefined,
		{} as never,
	);
	expect(turn.result()).toContain("decision");
});
function run(
	id: string,
	timestamp: number,
	memories: TeamMemoryEntry[],
	status: AgentRoomRun["status"] = "completed",
): AgentRoomRun {
	return {
		version: 1,
		id,
		roomId: "flights",
		status,
		goal: "Research",
		createdAt: timestamp,
		deadlineAt: timestamp + 1000,
		workflowRunIds: [],
		taskIds: [id],
		messageCount: 1,
		totalTokens: 0,
		costUsd: 0,
		rounds: [
			{
				id: "round",
				number: 1,
				workflowRunId: id,
				status: "completed",
				startedAt: timestamp,
				finishedAt: timestamp,
				turns: [
					{
						memberIndex: 0,
						agentId: "researcher",
						taskId: id,
						status: "reply",
						message: "Result",
						totalTokens: 0,
						costUsd: 0,
						remember: memories,
					},
				],
			},
		],
	};
}
test("memory corrections, expiry, failed runs and reset never resurrect obsolete evidence", () => {
	const runs = [
		run("first", 100, [
			{ key: "destination", text: "HNL", scope: "team" },
			{ key: "fare", text: "Old fare", scope: "team" },
		]),
		run("corrected", 200, [
			{ key: "destination", text: "LIH", scope: "team" },
			{
				key: "fare",
				text: "$500 observed",
				scope: "team",
				kind: "observation",
				sourceUrl: "https://example.com/flights",
			},
			{ key: "method", text: "Private method", scope: "private" },
		]),
		run("failed", 300, [{ key: "destination", text: "Wrong", scope: "team" }], "failed"),
	];
	const current = projectTeamMemory(definition, runs, 1000);
	expect(current.find((entry) => entry.key === "destination")?.text).toBe("LIH");
	expect(current.find((entry) => entry.key === "fare")).toMatchObject({
		observedAt: 200,
		expiresAt: 86400200,
		runId: "corrected",
		sourceUrl: "https://example.com/flights",
	});
	expect(current.find((entry) => entry.key === "method")?.agentId).toBe("researcher");
	expect(projectTeamMemory(definition, runs, 86400200).map((entry) => entry.text)).toEqual(["LIH", "Private method"]);
	expect(projectTeamMemory({ ...definition, memoryResetAt: 300 }, runs)).toEqual([]);
	expect(projectTeamMemory({ ...definition, memoryStrategy: "none" }, runs)).toEqual([]);
});
test("chat policy validates, changes expiry, and can be undone", () => {
	expect(() =>
		parseTeamChatUpdate({ expectedRevision: 0, memoryPolicy: { retain: "Fares", observationTtlHours: -1 } }),
	).toThrow();
	const updated = prepareTeamChatUpdate(
		definition,
		{ expectedRevision: 0, memoryPolicy: { retain: "Trip preferences; fares for one hour", observationTtlHours: 1 } },
		"policy",
	).definition;
	const evidence = run("observation", 100, [
		{ key: "fare", text: "Observed", scope: "team", kind: "observation", sourceUrl: "https://example.com" },
	]);
	expect(projectTeamMemory(updated, [evidence], 3600100)).toEqual([]);
	const undone = prepareTeamChatUpdate(updated, { expectedRevision: 1, undo: true }, "undo").definition;
	expect(undone.chatState?.memoryPolicy).toBeUndefined();
	expect(projectTeamMemory(undone, [evidence], 3600100)).toHaveLength(1);
});
