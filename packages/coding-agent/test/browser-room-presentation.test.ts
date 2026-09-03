import { describe, expect, test } from "vitest";
import { roomRunPresentation } from "../src/core/serve/browser/room-presentation.ts";

describe("room run presentation", () => {
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
