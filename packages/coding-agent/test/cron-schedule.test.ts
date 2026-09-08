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
	test("monthly dates skip short months and yearly dates keep local time across daylight saving", () => {
		expect(nextCronRun("0 9 31 * *", "America/Chicago", Date.parse("2026-01-31T15:00:00Z"))).toBe(
			Date.parse("2026-03-31T14:00:00Z"),
		);
		expect(nextCronRun("0 9 15 12 *", "America/Chicago", Date.parse("2026-09-08T14:00:00Z"))).toBe(
			Date.parse("2026-12-15T15:00:00Z"),
		);
	}, 15000);
});
