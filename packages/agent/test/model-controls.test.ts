import {
	type Api,
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ModelControls,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopTurnUpdate, AgentMessage, StreamFn } from "../src/types.ts";

const evidence = { kind: "user-override", reference: "synthetic offline fixture", checkedAt: "2026-08-31" } as const;
const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	provider: "fixture",
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	controls: {
		reasoningMode: { values: ["standard", "pro"], evidence },
		reasoningEffort: { values: ["low", "high"], evidence },
		processingTier: { values: ["default", "fast"], evidence },
	},
};
const controls: ModelControls = { reasoningMode: "standard", reasoningEffort: "low", processingTier: "default" };
const context: AgentContext = {
	systemPrompt: "Offline fixture",
	messages: [],
	tools: [
		{
			name: "fixture",
			label: "Fixture",
			description: "Synthetic tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
		},
	],
};
const prompt: AgentMessage = { role: "user", content: "Offline fixture", timestamp: 0 };

function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message): message is Message =>
			message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

function fakeStream(toolTurns = 0) {
	const requests: { model: Model<Api>; options: SimpleStreamOptions }[] = [];
	const stream = vi.fn<StreamFn>((requestModel, _context, options) => {
		requests.push({ model: requestModel, options: { ...options } });
		const message: AssistantMessage = {
			role: "assistant",
			api: requestModel.api,
			provider: requestModel.provider,
			model: requestModel.id,
			timestamp: 0,
			content:
				requests.length <= toolTurns
					? [{ type: "toolCall", id: `fixture-${requests.length}`, name: "fixture", arguments: {} }]
					: [],
			stopReason: requests.length <= toolTurns ? "toolUse" : "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const result = createAssistantMessageEventStream();
		result.push({ type: "done", reason: requests.length <= toolTurns ? "toolUse" : "stop", message });
		return result;
	});
	return { stream, requests };
}

describe("native agent controls", () => {
	it.each([null, [], "high", { reasoningBudget: 1.5 }])(
		"rejects malformed state without changing selections: %j",
		(invalid) => {
			const fake = fakeStream();
			expect(
				() =>
					new Agent({ streamFn: fake.stream, initialState: { model, modelControls: invalid as ModelControls } }),
			).toThrow("Invalid model controls");
			const agent = new Agent({ streamFn: fake.stream, initialState: { model, modelControls: controls } });
			expect(() => {
				agent.state.modelControls = invalid as ModelControls;
			}).toThrow("Invalid model controls");
			expect(agent.state.modelControls).toEqual(controls);
			expect(fake.stream).not.toHaveBeenCalled();
		},
	);
	it.each([{}, controls])("keeps native selections distinct from legacy thinking: %j", async (selection) => {
		const fake = fakeStream();
		const agent = new Agent({
			streamFn: fake.stream,
			initialState: { model, thinkingLevel: "high", modelControls: selection },
			thinkingBudgets: { high: 4096 },
		});
		await agent.prompt(prompt);
		await agent.prompt(prompt);
		for (const request of fake.requests) {
			expect(request.options.controls).toEqual(selection);
			expect(request.options.reasoning).toBeUndefined();
			expect(request.options.thinkingBudgets).toBeUndefined();
		}
		expect(agent.state.thinkingLevel).toBe("high");
	});
	it("copies selections on assignment and read, then explicitly returns to legacy", async () => {
		const fake = fakeStream();
		const initial = { ...controls };
		const agent = new Agent({
			streamFn: fake.stream,
			initialState: { model, modelControls: initial, thinkingLevel: "low" },
			thinkingBudgets: { low: 2048 },
		});
		initial.processingTier = "fast";
		const read = agent.state.modelControls;
		if (read) read.processingTier = "fast";
		await agent.prompt(prompt);
		expect(fake.requests[0].options.controls).toEqual(controls);
		const next = { reasoningEffort: "high" };
		agent.state.modelControls = next;
		next.reasoningEffort = "low";
		await agent.prompt(prompt);
		expect(fake.requests[1].options.controls).toEqual({ reasoningEffort: "high" });
		agent.state.modelControls = undefined;
		await agent.prompt(prompt);
		expect(fake.requests[2].options).toMatchObject({ reasoning: "low", thinkingBudgets: { low: 2048 } });
		expect(fake.requests[2].options.controls).toBeUndefined();
	});
	it("rejects unsupported model changes before auth without replacing the selection", async () => {
		const fake = fakeStream();
		const getApiKey = vi.fn(() => "synthetic");
		const agent = new Agent({ streamFn: fake.stream, getApiKey, initialState: { model, modelControls: controls } });
		await agent.prompt(prompt);
		agent.state.model = { ...model, id: "unsupported-fixture", controls: {} };
		await agent.prompt(prompt);
		expect(fake.stream).toHaveBeenCalledTimes(1);
		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(agent.state.errorMessage).toContain("not verified or implemented");
		expect(agent.state.modelControls).toEqual(controls);
		expect(agent.state.isStreaming).toBe(false);
	});
	it("keeps a run's selection stable when state changes during credential resolution", async () => {
		const fake = fakeStream();
		const agent = new Agent({ streamFn: fake.stream, initialState: { model, modelControls: controls } });
		agent.getApiKey = () => {
			agent.state.modelControls = { processingTier: "fast" };
			return "synthetic";
		};
		await agent.prompt(prompt);
		expect(fake.requests[0].options.controls).toEqual(controls);
	});
	it("keeps native controls across tool turns and validates explicit replacements", async () => {
		const fake = fakeStream(2);
		const updates: AgentLoopTurnUpdate[] = [{ context }, { modelControls: { reasoningEffort: "high" } }];
		await runAgentLoop(
			[prompt],
			context,
			{ model, controls, convertToLlm, prepareNextTurn: () => updates.shift() },
			() => {},
			undefined,
			fake.stream,
		);
		expect(fake.requests.map((request) => request.options.controls)).toEqual([
			controls,
			controls,
			{ reasoningEffort: "high" },
		]);
	});
	it("switches legacy/native/legacy explicitly at turn boundaries", async () => {
		const fake = fakeStream(2);
		const updates: AgentLoopTurnUpdate[] = [
			{ modelControls: {} },
			{ modelControls: null, thinkingLevel: "low", thinkingBudgets: { low: 2048 } },
		];
		await runAgentLoop(
			[prompt],
			context,
			{
				model,
				reasoning: "high",
				thinkingBudgets: { high: 4096 },
				convertToLlm,
				prepareNextTurn: () => updates.shift(),
			},
			() => {},
			undefined,
			fake.stream,
		);
		expect(fake.requests[0].options).toMatchObject({ reasoning: "high", thinkingBudgets: { high: 4096 } });
		expect(fake.requests[1].options).toMatchObject({
			controls: {},
			reasoning: undefined,
			thinkingBudgets: undefined,
		});
		expect(fake.requests[2].options).toMatchObject({
			controls: undefined,
			reasoning: "low",
			thinkingBudgets: { low: 2048 },
		});
	});
	it("ends an incompatible model-switch turn with a normal error event sequence", async () => {
		const fake = fakeStream(1);
		const events: AgentEvent[] = [];
		const getApiKey = vi.fn(() => "synthetic");
		await runAgentLoop(
			[prompt],
			context,
			{
				model,
				controls,
				getApiKey,
				convertToLlm,
				prepareNextTurn: () => ({ model: { ...model, controls: {} } }),
			},
			(event) => {
				events.push(event);
			},
			undefined,
			fake.stream,
		);
		expect(fake.stream).toHaveBeenCalledTimes(1);
		expect(getApiKey).toHaveBeenCalledTimes(1);
		expect(events.slice(-4).map((event) => event.type)).toEqual([
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		expect(events.at(-2)).toMatchObject({ type: "turn_end", message: { stopReason: "error" } });
	});
	it.each([{ reasoning: "high" }, { thinkingBudgets: { high: 4096 } }] satisfies SimpleStreamOptions[])(
		"rejects explicit mixed low-level controls %j",
		async (legacy) => {
			const fake = fakeStream();
			const getApiKey = vi.fn(() => "synthetic");
			const messages = await runAgentLoop(
				[prompt],
				context,
				{ model, controls: {}, ...legacy, getApiKey, convertToLlm },
				() => {},
				undefined,
				fake.stream,
			);
			expect(messages.at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage: "Choose native model controls or legacy reasoning, not both",
			});
			expect(fake.stream).not.toHaveBeenCalled();
			expect(getApiKey).not.toHaveBeenCalled();
		},
	);
});
