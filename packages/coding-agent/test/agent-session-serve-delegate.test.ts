import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { encodeServerMessage } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	AgentSessionServeDelegate,
	runSupervisedSessionPrompt,
} from "../src/core/serve/agent-session-serve-delegate.ts";

describe("AgentSessionServeDelegate", () => {
	test("aborts a session turn that stops producing events", async () => {
		let aborted = false;
		const session = {
			subscribe: () => () => {},
			abort: async () => {
				aborted = true;
			},
		} as unknown as AgentSession;
		await expect(runSupervisedSessionPrompt(session, () => new Promise<void>(() => {}), 20)).rejects.toThrow(
			"made no progress",
		);
		expect(aborted).toBe(true);
	});

	test("projects live subagent progress into protocol snapshots", () => {
		let eventListener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionId: "session-1",
			sessionName: "test",
			sessionManager: { getCwd: () => "C:\\workspace" },
			model: { provider: "openai", id: "gpt-5.6-luna" },
			thinkingLevel: "medium",
			isIdle: false,
			isCompacting: false,
			retryAttempt: 0,
			messages: [],
			pendingMessageCount: 0,
			getSteeringMessages: () => [],
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				eventListener = listener;
				return () => {};
			},
		} as unknown as AgentSession;
		const delegate = new AgentSessionServeDelegate(session, 100);
		delegate.subscribe(() => {});

		eventListener?.({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "subagent",
			args: { agent: "documenter", task: "Write a report" },
		});
		expect(delegate.snapshot().transcript).toContainEqual(
			expect.objectContaining({
				role: "tool",
				toolCallId: "call-1",
				toolName: "subagent",
				status: "running",
				input: { agent: "documenter", task: "Write a report" },
			}),
		);

		const partialResult: AgentToolResult<{ mode: string; results: unknown[] }> = {
			content: [{ type: "text", text: "Reading sources" }],
			details: { mode: "single", results: [{ agent: "documenter", messages: [] }] },
		};
		eventListener?.({
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "subagent",
			args: { agent: "documenter", task: "Write a report" },
			partialResult,
		});
		expect(delegate.snapshot().transcript).toContainEqual(
			expect.objectContaining({
				status: "running",
				content: [{ type: "text", text: "Reading sources" }],
				details: { mode: "single", results: [{ agent: "documenter", messages: [] }] },
			}),
		);

		eventListener?.({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "subagent",
			result: partialResult,
			isError: false,
		});
		expect(delegate.snapshot().transcript).toEqual([]);
	});

	test("removes provider-specific usage fields from protocol snapshots", () => {
		const session = {
			sessionId: "session-1",
			sessionName: "test",
			sessionManager: { getCwd: () => "C:\\workspace" },
			model: { provider: "anthropic", id: "claude-haiku-4-5" },
			thinkingLevel: "medium",
			isIdle: true,
			isCompacting: false,
			retryAttempt: 0,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					provider: "anthropic",
					model: "claude-haiku-4-5-20251001",
					usage: {
						input: 10,
						output: 4,
						cacheRead: 100,
						cacheWrite: 50,
						totalTokens: 164,
						cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
						cacheWrite1h: 50,
					},
					stopReason: "stop",
					timestamp: 100,
				},
			],
			pendingMessageCount: 0,
			getSteeringMessages: () => [],
		} as unknown as AgentSession;
		const snapshot = new AgentSessionServeDelegate(session, 100).snapshot();
		const transcriptItem = snapshot.transcript[0];
		expect(transcriptItem?.role).toBe("assistant");
		if (transcriptItem?.role !== "assistant") throw new Error("Expected an assistant transcript item");

		expect(transcriptItem.usage).toEqual({
			input: 10,
			output: 4,
			cacheRead: 100,
			cacheWrite: 50,
			totalTokens: 164,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		});
		expect(() => encodeServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).not.toThrow();
	});
});
