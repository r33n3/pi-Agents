import type { AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProxyAssistantMessageEvent, streamProxy } from "../src/proxy.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy", () => {
	it.each(["done", "error"] as const)("preserves native selections and execution metadata on %s", async (type) => {
		const execution: AssistantMessage["execution"] = {
			requested: { processingTier: "fast", reasoningEffort: "low" },
			sent: { processingTier: "fast", reasoningEffort: "low" },
			reported: { processingTier: "default" },
		};
		const event: ProxyAssistantMessageEvent =
			type === "done"
				? { type, reason: "stop", usage, execution }
				: { type, reason: "error", usage, execution, errorMessage: "Synthetic failure" };
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(`data: ${JSON.stringify(event)}\n\n`));
		vi.stubGlobal("fetch", fetch);
		const result = await streamProxy(
			model,
			{ messages: [] },
			{ authToken: "synthetic", proxyUrl: "https://example.invalid", controls: execution.requested },
		).result();
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).options).toEqual({ controls: execution.requested });
		expect(result.execution).toEqual(execution);
		expect(result.stopReason).toBe(type === "done" ? "stop" : "error");
	});

	it("preserves tool-call metadata received only on toolcall_end", async () => {
		const proxyEvents: ProxyAssistantMessageEvent[] = [
			{ type: "start" },
			{ type: "toolcall_start", contentIndex: 0, id: "call_test|fc_test", toolName: "lookup" },
			{ type: "toolcall_delta", contentIndex: 0, delta: '{"value":"hello"}' },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: "toolCall",
					id: "call_test|fc_test",
					name: "lookup",
					arguments: { value: "hello" },
					namespace: "dynamic_tools",
				},
			},
			{ type: "done", reason: "toolUse", usage },
		];
		const body = proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{
				authToken: "test-token",
				proxyUrl: "https://proxy.example.com",
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		const endEvent = events.find((event) => event.type === "toolcall_end");

		expect(endEvent).toMatchObject({
			type: "toolcall_end",
			toolCall: { namespace: "dynamic_tools" },
		});
		expect(result.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { value: "hello" },
			namespace: "dynamic_tools",
		});
	});
});
