import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import { agentExecutionResultFromMessages } from "../src/core/serve/agent-executor.ts";

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
