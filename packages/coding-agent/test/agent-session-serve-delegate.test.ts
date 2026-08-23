import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { AgentSessionServeDelegate } from "../src/core/serve/agent-session-serve-delegate.ts";

describe("AgentSessionServeDelegate", () => {
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
});
