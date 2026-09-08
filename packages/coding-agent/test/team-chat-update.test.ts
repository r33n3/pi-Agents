import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { parseTeamChatUpdate, prepareTeamChatUpdate } from "../src/core/serve/team-chat-update.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("supervisor saves instructions and facts at a turn boundary, restores after restart, and undoes through chat", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-chat-update-"));
	const contexts: AgentExecutionContext[] = [];
	let release = () => {};
	let workerStarted = () => {};
	const started = new Promise<void>((resolve) => {
		workerStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let mode = "work";
	let revision = 0;
	const executor: AgentExecutor = {
		async start(context) {
			contexts.push(context);
			const output: Record<string, unknown> = { outcome: "reply", message: "Done", requestAgentIds: [] };
			if (context.definition.id === "researcher") {
				if (mode === "work") {
					workerStarted();
				}
				output.message = "Observed source evidence";
			} else if (mode === "work") output.requestAgentIds = ["researcher"];
			else if (mode === "update")
				output.updateTeam = {
					expectedRevision: revision,
					memoryStrategy: "team",
					memoryPolicy: { retain: "Trip requirements and dated evidence", observationTtlHours: 2 },
					memberInstructions: [
						{
							agentId: "researcher",
							instructions:
								"Compare Google Flights, airline sites and aggregators using search and scrape. Report access failures.",
						},
					],
					taskFacts: {
						origin: "SGF",
						destination: "LIH (preliminary)",
						departure: "2027-05-28",
						return: "2027-06-12",
						adults: "3",
					},
				};
			else if (mode === "undo") output.updateTeam = { expectedRevision: revision, undo: true };
			else if (mode === "delegate")
				output.requestAgentIds = context.prompt.includes("Observed source evidence") ? [] : ["researcher"];
			return {
				result: (context.definition.id === "researcher" && mode === "work" ? gate : Promise.resolve()).then(() => ({
					output: JSON.stringify(output),
					transcript: [],
				})),
				subscribe: () => () => {},
				abort: async () => {},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	};
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["supervisor", "researcher"])
		await registry.save({
			id,
			name: id,
			description: id,
			persona: "Original role",
			tools: [],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
	let restored: AgentRoomService | undefined;
	try {
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		await rooms.initialize();
		await rooms.save({
			id: "flights",
			name: "Flights",
			purpose: "Flight research",
			supervisorAgentId: "supervisor",
			members: [
				{ agentId: "supervisor", role: "Coordinate" },
				{ agentId: "researcher", role: "Research", notes: "Original team instructions" },
			],
			memoryStrategy: "recent",
		});
		const run = await rooms.message("flights", "Research SGF to LIH for three adults, May 28 to June 12, 2027");
		await started;
		mode = "update";
		await rooms.message(
			"flights",
			"Update the researcher to compare multiple sources and retain my trip details for future requests",
		);
		release();
		const completed = await rooms.waitForCompletion(run.id);
		expect(completed.status, completed.error).toBe("completed");
		expect(completed.result).toContain("Saved team update · revision 1");
		expect(contexts.filter((entry) => entry.definition.id === "researcher")).toHaveLength(1);
		expect(contexts.at(-1)?.prompt).toContain("Update the researcher");
		expect((await registry.get("researcher"))?.persona).toBe("Original role");
		const saved = rooms.getDefinition("flights")!;
		expect(saved.members[1].notes).toContain("Google Flights");
		expect(saved.memoryStrategy).toBe("team");
		expect(saved.chatState?.memoryPolicy?.observationTtlHours).toBe(2);
		expect(saved.chatState?.taskFacts.adults).toBe("3");
		expect(() => prepareTeamChatUpdate(saved, { expectedRevision: 0, sharedInstructions: "stale" }, "new")).toThrow(
			"revision",
		);
		expect(() => parseTeamChatUpdate({ expectedRevision: 1, tools: ["powershell"] })).toThrow();
		expect(() =>
			prepareTeamChatUpdate(
				saved,
				{ expectedRevision: 1, memberInstructions: [{ agentId: "outsider", instructions: "bad" }] },
				"new",
			),
		).toThrow("members");
		const retry = prepareTeamChatUpdate(
			saved,
			completed.rounds.at(-1)!.turns[0].updateTeam!,
			saved.chatState!.lastActionId,
		);
		expect(retry.definition.chatState?.revision).toBe(1);
		restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await restored.initialize();
		expect(restored.getDefinition("flights")?.chatState).toEqual(saved.chatState);
		mode = "delegate";
		const followup = await restored.waitForCompletion(
			(await restored.message("flights", "Continue checking our trip")).id,
		);
		expect(followup.status, followup.error).toBe("completed");
		expect(contexts.at(-1)?.prompt).toContain('"origin":"SGF"');
		expect(contexts.at(-1)?.prompt).toContain("2027-06-12");
		expect(contexts.at(-1)?.prompt).toContain("Observations expire after 2 hours");
		mode = "undo";
		revision = 1;
		const undone = await restored.waitForCompletion(
			(await restored.message("flights", "Undo the last saved team update")).id,
		);
		expect(undone.status, undone.error).toBe("completed");
		expect(undone.result).toContain("revision 2");
		expect(restored.getDefinition("flights")?.members[1].notes).toBe("Original team instructions");
		expect(restored.getDefinition("flights")?.chatState?.taskFacts).toEqual({});
		expect(restored.getDefinition("flights")?.memoryStrategy).toBe("recent");
		expect(restored.getDefinition("flights")?.chatState?.memoryPolicy).toBeUndefined();
		const manual = restored.getDefinition("flights")!;
		manual.members[1].notes = "User edited instructions in team settings";
		await restored.save(manual);
		const afterManual = restored.getDefinition("flights")!;
		expect(afterManual.chatState?.revision).toBe(3);
		expect(afterManual.chatState?.previous).toBeUndefined();
		expect(() => prepareTeamChatUpdate(afterManual, { expectedRevision: 3, undo: true }, "undo-manual")).toThrow(
			"No saved team update",
		);
		await restored.save({ ...afterManual, memoryStrategy: "none" });
		expect(restored.getDefinition("flights")?.chatState?.revision).toBe(4);
	} finally {
		release();
		await restored?.dispose();
		await rooms.dispose();
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
