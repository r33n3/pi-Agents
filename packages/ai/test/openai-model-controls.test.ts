import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import { getModelControlCapabilities, type ModelControls } from "../src/model-controls.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";
import type { SimpleStreamOptions } from "../src/types.ts";

const model = OPENAI_MODELS["gpt-5.6-sol"];
const context = { messages: [{ role: "user" as const, content: "Synthetic offline test", timestamp: 0 }] };

function fakeResponse(tier?: string, reasoning?: { mode?: string; effort?: string }) {
	const payloads: ResponseCreateParamsStreaming[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
		payloads.push(JSON.parse(String(init?.body)) as ResponseCreateParamsStreaming);
		return new Response(
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					output: [],
					service_tier: tier,
					reasoning,
					usage: {
						input_tokens: 100,
						output_tokens: 20,
						total_tokens: 120,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 5 },
					},
				},
			})}\n\ndata: [DONE]\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	return { fetch, payloads };
}

const capabilities = getModelControlCapabilities(model);
const combinations = capabilities.reasoningMode!.values.flatMap((reasoningMode) =>
	capabilities.reasoningEffort!.values.flatMap((reasoningEffort) =>
		capabilities.processingTier!.values.map((processingTier) => ({ reasoningMode, reasoningEffort, processingTier })),
	),
);

describe("OpenAI native control serialization", () => {
	it.each(combinations)("sends independent selections unchanged: %j", async (controls) => {
		const fake = fakeResponse("priority", { mode: controls.reasoningMode, effort: controls.reasoningEffort });
		const result = await streamSimple(model, context, { apiKey: "synthetic", fetch: fake.fetch, controls }).result();
		expect(result.stopReason).toBe("stop");
		expect(fake.payloads[0]).toMatchObject({
			reasoning: { mode: controls.reasoningMode, effort: controls.reasoningEffort },
			service_tier: controls.processingTier,
		});
		expect(result.execution?.requested).toEqual(controls);
		expect(result.execution?.sent).toEqual(controls);
		expect(result.execution?.reported?.processingTier).toBe("priority");
	});
	it("mode-only selection preserves the provider effort default and does not enable Fast", async () => {
		const fake = fakeResponse();
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { reasoningMode: "pro" },
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fake.payloads[0].reasoning).toEqual({ mode: "pro" });
		expect(fake.payloads[0].service_tier).toBeUndefined();
		expect(result.execution?.reported?.processingTier).toBeUndefined();
	});
	it.each([{}, { processingTier: "fast" }] satisfies ModelControls[])(
		"native omitted effort preserves the provider default: %j",
		async (controls) => {
			const fake = fakeResponse();
			const result = await streamSimple(model, context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls,
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(fake.payloads[0].reasoning).toBeUndefined();
			expect(result.execution?.sent.reasoningEffort).toBeUndefined();
		},
	);
	it.each(["fast", "priority", "default"])(
		"prices the actual response tier %s, not the requested Fast tier",
		async (tier) => {
			const fake = fakeResponse(tier);
			const result = await stream(model, context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: { processingTier: "fast" },
			}).result();
			const standardCost = (100 * model.cost.input + 20 * model.cost.output) / 1_000_000;
			expect(result.stopReason).toBe("stop");
			expect(result.usage.cost.total).toBeCloseTo(standardCost * (tier === "default" ? 1 : 2));
			expect(result.execution?.reported?.processingTier).toBe(tier);
		},
	);
	it.each([
		{ reasoningEffort: "ultra" },
		{ reasoningBudget: 1024 },
		{ processingTier: "flex" },
	] satisfies ModelControls[])("rejects unsupported options before fetch: %j", async (controls) => {
		const fake = fakeResponse();
		const result = await stream(model, context, { apiKey: "synthetic", fetch: fake.fetch, controls }).result();
		expect(result.stopReason).toBe("error");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("rejects conflicting legacy effort rather than silently clamping or replacing it", async () => {
		const fake = fakeResponse();
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			reasoning: "high",
			controls: { reasoningEffort: "low" },
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("rejects mixing Fast with legacy off instead of silently restoring provider-default effort", async () => {
		const fake = fakeResponse();
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			// Exercise untyped callers; the public simple API represents off by omission.
			reasoning: "off" as unknown as SimpleStreamOptions["reasoning"],
			controls: { processingTier: "fast" },
		}).result();
		expect(result.errorMessage).toContain("Choose native model controls or legacy reasoning");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("rejects request hooks or sampling overrides that change an explicit selection", async () => {
		const fake = fakeResponse();
		const result = await stream(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "default" },
			onPayload: (payload) => ({ ...(payload as ResponseCreateParamsStreaming), service_tier: "fast" }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("uses the actual serialized tier for fallback estimates without claiming it was reported", async () => {
		const fake = fakeResponse();
		const result = await stream(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			samplingParams: { service_tier: "fast" },
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.execution?.sent.processingTier).toBe("fast");
		expect(result.execution?.reported?.processingTier).toBeUndefined();
		expect(result.usage.cost.total).toBeCloseTo(((100 * model.cost.input + 20 * model.cost.output) / 1_000_000) * 2);
	});
});
