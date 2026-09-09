import { describe, expect, test } from "vitest";
import {
	roomComposerPresentation,
	roomNeedsUserNotice,
	roomRunPresentation,
} from "../src/core/serve/browser/room-presentation.ts";

describe("room run presentation", () => {
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
