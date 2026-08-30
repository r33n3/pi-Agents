import { describe, expect, test } from "vitest";
import {
	buildAgentScheduleTrigger,
	planAgentSchedule,
	type AgentScheduleManifest,
} from "../extensions/agent-schedule.ts";
import { canonicalAgentModelReference } from "../extensions/agent-builder.ts";

const models = [
	{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
	{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
] as const;

describe("agent model references", () => {
	test("preserves a canonical provider/model ID", () => {
		expect(canonicalAgentModelReference("openai/gpt-5.6-luna", models)).toBe("openai/gpt-5.6-luna");
	});

	test("normalizes a unique display-name reference", () => {
		expect(canonicalAgentModelReference("openai/GPT5.6 Luna", models)).toBe("openai/gpt-5.6-luna");
	});

	test("rejects an unknown model instead of persisting it", () => {
		expect(() => canonicalAgentModelReference("openai/not-a-model", models)).toThrow(
			"Select an exact provider/model ID",
		);
	});
});

describe("agent schedule cadence", () => {
	test("builds daily and weekly Windows triggers", () => {
		expect(buildAgentScheduleTrigger("daily 9:05")).toBe('New-ScheduledTaskTrigger -Daily -At "09:05"');
		expect(buildAgentScheduleTrigger("weekly Mon 08:00")).toBe(
			'New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "08:00"',
		);
	});

	test("rejects invalid clock values", () => {
		expect(() => buildAgentScheduleTrigger("daily 24:00")).toThrow("Unrecognized cadence");
		expect(() => buildAgentScheduleTrigger("daily 09:60")).toThrow("Unrecognized cadence");
	});

	test("reuses an identical schedule instead of creating a duplicate", () => {
		const existing: AgentScheduleManifest = {
			taskName: "pi-agent-daily-mail-agent-123abc",
			agent: "daily-mail-agent",
			task: "Review yesterday's mail",
			cadence: "daily 09:00",
			createdAt: "2026-08-30T00:00:00.000Z",
		};
		const plan = planAgentSchedule(
			[existing],
			"daily-mail-agent",
			"Review yesterday's mail",
			"daily 09:00",
			"replace",
			"pi-agent-daily-mail-agent-unused",
		);
		expect(plan.unchanged).toBe(existing);
		expect(plan.replaced).toEqual([]);
	});

	test("updates the newest schedule and removes stale duplicates", () => {
		const older: AgentScheduleManifest = {
			taskName: "pi-agent-daily-mail-agent-111111",
			agent: "daily-mail-agent",
			task: "Old task",
			cadence: "daily 06:30",
			createdAt: "2026-08-29T00:00:00.000Z",
		};
		const newer: AgentScheduleManifest = {
			...older,
			taskName: "pi-agent-daily-mail-agent-222222",
			cadence: "daily 09:00",
			createdAt: "2026-08-30T00:00:00.000Z",
		};
		const plan = planAgentSchedule(
			[older, newer],
			"daily-mail-agent",
			"New task",
			"daily 08:00",
			"replace",
			"pi-agent-daily-mail-agent-unused",
		);
		expect(plan.taskName).toBe(newer.taskName);
		expect(plan.replaced).toEqual([older]);
	});
});
