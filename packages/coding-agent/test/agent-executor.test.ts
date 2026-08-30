import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { agentExecutionInstructions, agentExecutionResultFromMessages } from "../src/core/serve/agent-executor.ts";

test("agent execution instructions anchor relative dates to host time", () => {
	const instructions = agentExecutionInstructions(
		{
			runId: "run-1",
			workspace: "C:/workspace",
			prompt: "Review the previous calendar day",
			definition: {
				id: "mail",
				revision: 1,
				source: "managed",
				name: "Mail",
				description: "Review mail",
				tools: ["read"],
				capabilities: [],
				memory: "none",
				persona: "Careful",
				executor: "harness",
				permissionPolicy: "read-only",
				projectRoot: "C:/workspace",
				workspace: "C:/workspace",
				delegateAgentIds: [],
				a2a: { enabled: false },
				browserWorkflows: [],
				schedules: [],
			},
		},
		new Date("2026-08-30T13:00:00.000Z"),
		"America/Chicago",
	);
	expect(instructions).toContain("2026-08-30T13:00:00.000Z (America/Chicago)");
	expect(instructions).toContain("Resolve relative dates such as today, yesterday, and previous calendar day");
});

describe("agentExecutionResultFromMessages", () => {
	test("returns the final successful assistant text and complete transcript", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "review" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "complete" }],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		];
		expect(agentExecutionResultFromMessages(messages)).toEqual({ output: "complete", transcript: messages });
	});

	test("rejects a provider error instead of persisting an empty successful result", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [],
				api: "test",
				provider: "test",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "provider rejected model binding",
				timestamp: 1,
			},
		];
		expect(() => agentExecutionResultFromMessages(messages)).toThrow("provider rejected model binding");
	});

	test("rejects a transcript without an assistant response", () => {
		const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "review" }], timestamp: 1 }];
		expect(() => agentExecutionResultFromMessages(messages)).toThrow("no assistant response");
	});
});
