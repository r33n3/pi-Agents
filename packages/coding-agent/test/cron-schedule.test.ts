import { describe, expect, test } from "vitest";
import { nextCronRun, validateCron } from "../src/core/serve/cron-schedule.ts";

describe("cron schedule", () => {
	test("calculates the next matching minute in the selected timezone", () => {
		const after = Date.parse("2026-08-22T13:58:30Z");
		expect(nextCronRun("0 9 * * *", "America/Chicago", after)).toBe(Date.parse("2026-08-22T14:00:00Z"));
	});

	test("rejects invalid expressions and timezones", () => {
		expect(() => validateCron("not cron", "UTC")).toThrow("five fields");
		expect(() => validateCron("* * * * *", "Invalid/Timezone")).toThrow("Unsupported timezone");
	});
});
