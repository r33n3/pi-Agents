import type { ThinkingConfig } from "@google/genai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/google-generative-ai.ts";
import {
	getModelControlCapabilities,
	getModelControlCapabilityErrors,
	type ModelControls,
	validateModelControls,
} from "../src/model-controls.ts";
import { GOOGLE_MODELS } from "../src/providers/google.models.ts";
import type { Model, SimpleStreamOptions } from "../src/types.ts";

const context = { messages: [{ role: "user" as const, content: "Synthetic offline test", timestamp: 0 }] };
const payloads: Array<{ model?: string; generationConfig?: { thinkingConfig?: ThinkingConfig } }> = [];
const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
	payloads.push(JSON.parse(String(init?.body)));
	return new Response(
		`data: ${JSON.stringify({
			responseId: "synthetic-response",
			candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, totalTokenCount: 15 },
		})}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
});

beforeEach(() => {
	payloads.length = 0;
	fetch.mockClear();
	vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());

const reviewed = Object.values(GOOGLE_MODELS).filter((model) => {
	const controls = getModelControlCapabilities(model);
	return controls.reasoningEffort || controls.reasoningBudget;
});
const effortCases = reviewed.flatMap((model) =>
	(getModelControlCapabilities(model).reasoningEffort?.values ?? []).map((effort) => ({ model, effort })),
);

describe("Google native controls", () => {
	it.each(effortCases)("serializes $model.id effort $effort through the real SDK", async ({ model, effort }) => {
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			controls: { reasoningEffort: effort },
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(payloads[0].generationConfig?.thinkingConfig).toEqual({
			includeThoughts: true,
			thinkingLevel: effort.toUpperCase(),
		});
		expect(result.execution).toEqual({
			requested: { reasoningEffort: effort },
			sent: { reasoningEffort: effort.toUpperCase() },
		});
		expect(result.usage.reasoning).toBe(3);
		expect(result.execution?.reported).toBeUndefined();
	});
	it("locks reviewed coverage and per-model differences", () => {
		expect(reviewed).toHaveLength(11);
		expect(getModelControlCapabilities(GOOGLE_MODELS["gemini-3.1-pro-preview"]).reasoningEffort?.values).toEqual([
			"low",
			"medium",
			"high",
		]);
		expect(getModelControlCapabilities(GOOGLE_MODELS["gemini-3.7-flash"]).reasoningEffort?.values).not.toContain(
			"minimal",
		);
		for (const model of reviewed)
			expect(getModelControlCapabilityErrors(getModelControlCapabilities(model))).toEqual([]);
	});
	it.each([
		{ id: "gemini-2.5-pro", budgets: [-1, 128, 32768] },
		{ id: "gemini-2.5-flash", budgets: [-1, 0, 1, 24576] },
		{ id: "gemini-2.5-flash-lite", budgets: [-1, 0, 512, 24576] },
	])("preserves $id budgets and documented sentinels", async ({ id, budgets }) => {
		const model = GOOGLE_MODELS[id as keyof typeof GOOGLE_MODELS];
		for (const budget of budgets) {
			const controls = { reasoningBudget: budget };
			const result = await streamSimple(model, context, { apiKey: "synthetic", controls }).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(payloads.at(-1)?.generationConfig?.thinkingConfig).toEqual({
				thinkingBudget: budget,
				...(budget !== 0 ? { includeThoughts: true } : {}),
			});
			expect(result.execution).toEqual({ requested: controls, sent: controls });
		}
	});
	it.each([
		{ id: "gemini-2.5-pro", controls: { reasoningBudget: 0 } },
		{ id: "gemini-2.5-pro", controls: { reasoningBudget: 127 } },
		{ id: "gemini-2.5-pro", controls: { reasoningBudget: 32769 } },
		{ id: "gemini-2.5-flash-lite", controls: { reasoningBudget: 1 } },
		{ id: "gemini-2.5-flash-lite", controls: { reasoningBudget: 511 } },
		{ id: "gemini-2.5-flash", controls: { reasoningBudget: -2 } },
		{ id: "gemini-2.5-flash", controls: { reasoningBudget: 24577 } },
		{ id: "gemini-2.5-flash", controls: { reasoningBudget: 1.5 } },
		{ id: "gemini-2.5-flash", controls: { reasoningEffort: "low" } },
		{ id: "gemini-3.7-flash", controls: { reasoningBudget: 1024 } },
		{ id: "gemini-3.7-flash", controls: { reasoningEffort: "minimal" } },
		{ id: "gemini-3.1-pro-preview", controls: { reasoningEffort: "none" } },
		{ id: "gemini-3.1-flash-lite-image", controls: { reasoningEffort: "low" } },
		{ id: "gemini-3.1-flash-lite-image", controls: { reasoningEffort: "medium" } },
		{ id: "gemini-3.7-flash", controls: { processingTier: "fast" } },
	])("rejects invalid $id controls $controls before auth or fetch", async ({ id, controls }) => {
		const model = GOOGLE_MODELS[id as keyof typeof GOOGLE_MODELS];
		const result = await streamSimple(model, context, { controls }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("API key");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(["gemini-3.7-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"] as const)(
		"preserves provider defaults for $0",
		async (id) => {
			const result = await streamSimple(GOOGLE_MODELS[id], context, { apiKey: "synthetic", controls: {} }).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(payloads[0].generationConfig?.thinkingConfig).toBeUndefined();
			expect(result.execution).toEqual({ requested: {}, sent: {} });
		},
	);
	it("does not transfer public API evidence to Vertex, gateways, aliases, or future models", () => {
		const model = GOOGLE_MODELS["gemini-3.7-flash"];
		for (const overrides of [
			{ provider: "google-vertex", api: "google-vertex" },
			{ provider: "gateway" },
			{ baseUrl: "https://generativelanguage.googleapis.com.example.test/v1beta" },
			{ baseUrl: "https://generativelanguage.googleapis.com/v1" },
			{ id: "gemini-flash-latest" },
			{ id: "gemini-3.8-flash" },
			{ controls: {} },
		])
			expect(getModelControlCapabilities({ ...model, ...overrides })).toEqual({});
	});
	it("rejects level plus budget even when private capabilities declare both", () => {
		const model: Model<"google-generative-ai"> = {
			...GOOGLE_MODELS["gemini-3.7-flash"],
			controls: {
				reasoningEffort: getModelControlCapabilities(GOOGLE_MODELS["gemini-3.7-flash"]).reasoningEffort,
				reasoningBudget: getModelControlCapabilities(GOOGLE_MODELS["gemini-2.5-pro"]).reasoningBudget,
			},
		};
		expect(() => validateModelControls(model, { reasoningEffort: "low", reasoningBudget: 1024 })).toThrow("not both");
	});
	it.each([
		{ reasoning: "low" },
		{ reasoning: "off" as unknown as SimpleStreamOptions["reasoning"] },
		{ thinkingBudgets: { low: 2048 } },
	] satisfies SimpleStreamOptions[])("rejects mixed legacy simple controls %j", async (legacy) => {
		const result = await streamSimple(GOOGLE_MODELS["gemini-3.7-flash"], context, {
			apiKey: "synthetic",
			controls: {},
			...legacy,
		}).result();
		expect(result.errorMessage).toContain("not both");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("rejects direct legacy thinking mixed with native selections", async () => {
		const result = await stream(GOOGLE_MODELS["gemini-3.7-flash"], context, {
			apiKey: "synthetic",
			controls: {},
			thinking: { enabled: false },
		}).result();
		expect(result.errorMessage).toContain("not both");
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each(["change", "remove", "add-budget", "change-model", "mutate"])(
		"rejects native payload override %s",
		async (mutation) => {
			const controls: ModelControls = { reasoningEffort: "low" };
			const result = await stream(GOOGLE_MODELS["gemini-3.7-flash"], context, {
				apiKey: "synthetic",
				controls,
				onPayload: (payload) => {
					const params = payload as { model: string; config: { thinkingConfig?: Record<string, unknown> } };
					if (mutation === "change-model") params.model = "gemini-3.1-pro-preview";
					else if (mutation === "remove") delete params.config.thinkingConfig;
					else if (mutation === "add-budget") params.config.thinkingConfig!.thinkingBudget = 1024;
					else params.config.thinkingConfig!.thinkingLevel = "HIGH";
					if (mutation === "mutate") controls.reasoningEffort = "high";
					return params;
				},
			}).result();
			expect(result.errorMessage).toContain("Payload changes conflict");
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("records hidden legacy thinking honestly instead of labeling it off", async () => {
		const result = await streamSimple(GOOGLE_MODELS["gemini-3.1-pro-preview"], context, {
			apiKey: "synthetic",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(result.execution?.sent).toEqual({ reasoningEffort: "LOW" });
		expect(result.execution?.reported).toBeUndefined();
	});
});
