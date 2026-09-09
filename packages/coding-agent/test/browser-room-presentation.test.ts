import { describe, expect, test } from "vitest";
import {
	roomComposerPresentation,
	roomNeedsUserNotice,
	roomRunPresentation,
	roomRunTokenUsage,
} from "../src/core/serve/browser/room-presentation.ts";

describe("room run presentation", () => {
	test("counts reported usage for the selected request and descendant teams once", () => {
		const task = { id: "one", roomRunId: "parent", usage: { inputTokens: 100, outputTokens: 20 } };
		expect(
			roomRunTokenUsage(
				"parent",
				[
					{ id: "child", parentRunId: "parent", taskIds: ["two"] },
					{ id: "parent", taskIds: ["one"] },
				],
				[
					task,
					task,
					{ id: "two", usage: { inputTokens: 200, outputTokens: 30 } },
					{ id: "old", roomRunId: "previous", usage: { inputTokens: 900, outputTokens: 80 } },
					{ id: "pending", roomRunId: "parent" },
				],
			),
		).toEqual({ input: 300, output: 50, reported: true });
		expect(roomRunTokenUsage(undefined, [], [task])).toEqual({ input: 0, output: 0, reported: false });
	});
	test("uses one composer action for execution, stopping and user input", () => {
		expect(roomComposerPresentation("running")).toEqual({ label: "Stop team", isStopping: true, disabled: false });
		expect(roomComposerPresentation("running", true)).toEqual({
			label: "Stopping team",
			isStopping: true,
			disabled: true,
		});
		expect(roomComposerPresentation("needs-user")).toEqual({
			label: "Continue team",
			isStopping: false,
			disabled: false,
		});
		for (const status of [undefined, "completed", "cancelled", "bounded", "failed"] as const)
			expect(roomComposerPresentation(status)).toEqual({
				label: "Send to team",
				isStopping: false,
				disabled: false,
			});
	});

	test("shows the retained question without internal IDs or evidence boilerplate", () => {
		expect(
			roomNeedsUserNotice(
				"local-team-step-3: Which account should I use?\n\nHost evidence: reasoning-only contribution",
				[{ agentId: "local-team-step-3", name: "Coordinator" }],
			),
		).toBe("Coordinator: Which account should I use?");
		for (const question of [undefined, "", "   ", "Host evidence: reasoning-only contribution"])
			expect(roomNeedsUserNotice(question)).toContain("paused without providing a specific question");
	});
	test("presents a safety limit as a neutral terminal state instead of a failure", () => {
		const bounded = roomRunPresentation("bounded");
		expect(bounded.label).toBe("limit reached");
		expect(bounded.activityStatus).toBe("bounded");
		expect(bounded.noticeClassName).toBe("muted");
		expect(bounded).not.toEqual(roomRunPresentation("failed"));
		expect(roomRunPresentation("failed")).toMatchObject({
			activityStatus: "failed",
			noticeClassName: "run-error",
		});
	});

	test("keeps completed, running, and human-decision states distinct", () => {
		expect(roomRunPresentation("completed")).toMatchObject({ label: "completed", activityStatus: "completed" });
		expect(roomRunPresentation("running")).toMatchObject({ label: "running", activityStatus: "running" });
		expect(roomRunPresentation("needs-user")).toMatchObject({
			label: "needs user",
			activityStatus: "waiting_for_input",
		});
		expect(roomRunPresentation("cancelled")).toMatchObject({
			label: "cancelled",
			activityStatus: "cancelled",
			noticeClassName: "muted",
		});
	});
});
