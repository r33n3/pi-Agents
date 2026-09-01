import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming as BetaMessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream, streamSimple } from "../src/api/anthropic-messages.ts";
import {
	getModelControlCapabilities,
	getModelControlCapabilityErrors,
	type ModelControls,
	validateModelControls,
} from "../src/model-controls.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "Synthetic offline test", timestamp: 0 }] };
const toolContext: Context = {
	...context,
	tools: [{ name: "fixture", description: "Synthetic tool", parameters: { type: "object", properties: {} } }],
};

function fakeAPI(
	options: {
		startUsage?: Record<string, unknown>;
		finalUsage?: Record<string, unknown>;
		responseModel?: string;
		errorStatus?: number;
	} = {},
) {
	const payloads: BetaMessageCreateParamsStreaming[] = [];
	const headers: Headers[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
		const payload = JSON.parse(String(init?.body)) as BetaMessageCreateParamsStreaming;
		payloads.push(payload);
		headers.push(new Headers(init?.headers));
		if (options.errorStatus)
			return new Response(
				JSON.stringify({ error: { type: "rate_limit_error", message: "Synthetic unavailable Fast capacity" } }),
				{ status: options.errorStatus, headers: { "content-type": "application/json" } },
			);
		const events = [
			{
				type: "message_start",
				message: {
					id: "synthetic-message",
					model: options.responseModel ?? payload.model,
					role: "assistant",
					content: [],
					usage: { input_tokens: 10, output_tokens: 0, ...options.startUsage },
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5, ...options.finalUsage },
			},
			{ type: "message_stop" },
		];
		return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetch, payloads, headers };
}

const nativeCases = Object.values(ANTHROPIC_MODELS).flatMap((model) => {
	const capabilities = getModelControlCapabilities(model);
	return (capabilities.reasoningMode?.values ?? []).flatMap((mode) =>
		[undefined, ...(capabilities.reasoningEffort?.values ?? [])].flatMap((effort) => {
			const controls: ModelControls = {
				reasoningMode: mode,
				...(mode === "enabled" ? { reasoningBudget: 1024 } : {}),
				...(effort ? { reasoningEffort: effort } : {}),
			};
			// These two combinations are explicitly rejected by the reviewed provider table.
			if (model.id === "claude-opus-5" && mode === "disabled" && (effort === "xhigh" || effort === "max")) return [];
			return [undefined, ...(capabilities.processingTier?.values ?? [])].map((processingTier) => ({
				model,
				controls: { ...controls, ...(processingTier ? { processingTier } : {}) },
			}));
		}),
	);
});

const reviewedAnthropicModelIds = new Set([
	"claude-fable-5",
	"claude-haiku-4-5",
	"claude-haiku-4-5-20251001",
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
	"claude-opus-4-6",
	"claude-opus-4-7",
	"claude-opus-4-8",
	"claude-opus-5",
	"claude-sonnet-4-5",
	"claude-sonnet-4-5-20250929",
	"claude-sonnet-4-6",
	"claude-sonnet-5",
]);

describe("Anthropic native model controls", () => {
	it.each(nativeCases)("serializes $model.id $controls through the real SDK", async ({ model, controls }) => {
		const fake = fakeAPI();
		const result = await streamSimple(model, context, { apiKey: "synthetic", fetch: fake.fetch, controls }).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fake.payloads[0].thinking).toEqual({
			type: controls.reasoningMode,
			...(controls.reasoningBudget !== undefined ? { budget_tokens: controls.reasoningBudget } : {}),
		});
		expect(fake.payloads[0].output_config?.effort).toBe(controls.reasoningEffort);
		expect(fake.payloads[0].speed).toBe(controls.processingTier);
		if (controls.processingTier) expect(fake.headers[0].get("anthropic-beta")).toContain("fast-mode-2026-02-01");
		expect(fake.payloads[0]).not.toHaveProperty("service_tier");
		expect(result.execution).toEqual({ requested: controls, sent: controls });
		expect(result.execution?.reported).toBeUndefined();
	});
	it("covers all bundled Anthropic entries without generic effort inheritance", () => {
		const bundledModels = Object.values(ANTHROPIC_MODELS);
		expect(
			new Set(
				bundledModels
					.filter((model) => Object.keys(getModelControlCapabilities(model)).length > 0)
					.map((model) => model.id),
			),
		).toEqual(reviewedAnthropicModelIds);
		for (const model of bundledModels) {
			const controls = getModelControlCapabilities(model);
			if (!reviewedAnthropicModelIds.has(model.id)) {
				expect(controls).toEqual({});
				continue;
			}
			expect(controls.reasoningMode?.values.length).toBeGreaterThan(0);
			expect(controls.reasoningEffort?.values ?? []).not.toContain("minimal");
			expect(getModelControlCapabilityErrors(controls)).toEqual([]);
		}
		expect(getModelControlCapabilities(ANTHROPIC_MODELS["claude-haiku-4-5"]).reasoningEffort).toBeUndefined();
		expect(getModelControlCapabilities(ANTHROPIC_MODELS["claude-sonnet-4-5"]).reasoningEffort).toBeUndefined();
	});
	it.each(Object.values(ANTHROPIC_MODELS))("preserves all provider defaults for $id", async (model) => {
		const fake = fakeAPI();
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: {},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fake.payloads[0].thinking).toBeUndefined();
		expect(fake.payloads[0].output_config).toBeUndefined();
		expect(result.execution).toEqual({ requested: {}, sent: {} });
	});
	it("supports Opus 4.5 effort without enabling thinking", async () => {
		const fake = fakeAPI();
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-4-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { reasoningEffort: "low" },
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fake.payloads[0].thinking).toBeUndefined();
		expect(fake.payloads[0].output_config).toEqual({ effort: "low" });
	});
	it.each([
		{ id: "claude-fable-5", controls: { reasoningMode: "disabled" } },
		{ id: "claude-fable-5", controls: { reasoningMode: "enabled", reasoningBudget: 1024 } },
		{ id: "claude-opus-5", controls: { reasoningMode: "disabled", reasoningEffort: "xhigh" } },
		{ id: "claude-opus-5", controls: { reasoningMode: "disabled", reasoningEffort: "max" } },
		{ id: "claude-opus-4-7", controls: { reasoningMode: "enabled", reasoningBudget: 1024 } },
		{ id: "claude-opus-4-6", controls: { reasoningEffort: "xhigh" } },
		{ id: "claude-opus-4-5", controls: { reasoningEffort: "max" } },
		{ id: "claude-sonnet-4-5", controls: { reasoningEffort: "low" } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "adaptive" } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "enabled" } },
		{ id: "claude-haiku-4-5", controls: { reasoningBudget: 1024 } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "disabled", reasoningBudget: 1024 } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "enabled", reasoningBudget: 1023 } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "enabled", reasoningBudget: 0 } },
		{ id: "claude-haiku-4-5", controls: { reasoningMode: "enabled", reasoningBudget: -1 } },
		{ id: "claude-opus-4-7", controls: { processingTier: "fast" } },
		{ id: "claude-opus-4-6", controls: { processingTier: "fast" } },
		{ id: "claude-opus-5", controls: { processingTier: "priority" } },
		{ id: "claude-opus-5", controls: { processingTier: "auto" } },
	] satisfies { id: keyof typeof ANTHROPIC_MODELS; controls: ModelControls }[])(
		"rejects $id $controls before auth/fetch",
		async ({ id, controls }) => {
			const fake = fakeAPI();
			const result = await streamSimple(ANTHROPIC_MODELS[id], context, { fetch: fake.fetch, controls }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).not.toContain("API key");
			expect(fake.fetch).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ id: "claude-haiku-4-5", tools: false, interleaved: true, allowed: false },
		{ id: "claude-haiku-4-5", tools: true, interleaved: true, allowed: false },
		{ id: "claude-opus-4-6", tools: true, interleaved: true, allowed: false },
		{ id: "claude-sonnet-4-6", tools: true, interleaved: true, allowed: true },
		{ id: "claude-opus-4-5", tools: true, interleaved: true, allowed: true },
		{ id: "claude-opus-4-5", tools: false, interleaved: true, allowed: false },
		{ id: "claude-opus-4-5", tools: true, interleaved: false, allowed: false },
	] satisfies { id: keyof typeof ANTHROPIC_MODELS; tools: boolean; interleaved: boolean; allowed: boolean }[])(
		"validates the manual budget ceiling: %j",
		async ({ id, tools, interleaved, allowed }) => {
			const fake = fakeAPI();
			const result = await stream(ANTHROPIC_MODELS[id], tools ? toolContext : context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				maxTokens: 2048,
				interleavedThinking: interleaved,
				controls: { reasoningMode: "enabled", reasoningBudget: 4096 },
				headers: { "anthropic-beta": "synthetic-beta" },
			}).result();
			expect(result.stopReason, result.errorMessage).toBe(allowed ? "stop" : "error");
			if (allowed) {
				expect(fake.payloads[0].max_tokens).toBe(2048);
				expect(fake.headers[0].get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
				expect(fake.headers[0].get("anthropic-beta")).toContain("synthetic-beta");
			} else expect(fake.fetch).not.toHaveBeenCalled();
		},
	);
	it.each([1024, 1025])("checks budget against the final output cap %i without raising it", async (maxTokens) => {
		const fake = fakeAPI();
		const result = await streamSimple(ANTHROPIC_MODELS["claude-haiku-4-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			maxTokens,
			controls: { reasoningMode: "enabled", reasoningBudget: 1024 },
		}).result();
		expect(result.stopReason).toBe(maxTokens === 1024 ? "error" : "stop");
		if (maxTokens > 1024) expect(fake.payloads[0].max_tokens).toBe(maxTokens);
		else expect(fake.fetch).not.toHaveBeenCalled();
	});
	it.each([
		{ controls: { reasoningMode: "adaptive" }, temperature: 0 },
		{ controls: {}, temperature: 0 },
		{ controls: { reasoningMode: "adaptive" }, toolChoice: "any" },
		{ controls: {}, toolChoice: { type: "tool", name: "fixture" } },
	] satisfies AnthropicOptions[])("rejects incompatible native request options %j", async (options) => {
		const fake = fakeAPI();
		const result = await stream(ANTHROPIC_MODELS["claude-sonnet-5"], toolContext, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			...options,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("keeps thought-display suppression separate from disabling thinking", async () => {
		const fake = fakeAPI();
		const result = await stream(ANTHROPIC_MODELS["claude-fable-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { reasoningMode: "adaptive" },
			thinkingDisplay: "omitted",
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(fake.payloads[0].thinking).toEqual({ type: "adaptive", display: "omitted" });
		expect(result.execution?.sent.reasoningMode).toBe("adaptive");
		expect(result.execution?.reported).toBeUndefined();
	});
	it.each([
		{ thinkingEnabled: false },
		{ thinkingBudgetTokens: 1024 },
		{ effort: "high" },
	] satisfies AnthropicOptions[])("rejects legacy direct controls mixed with native %j", async (legacy) => {
		const fake = fakeAPI();
		const result = await stream(ANTHROPIC_MODELS["claude-opus-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: {},
			...legacy,
		}).result();
		expect(result.errorMessage).toContain("not both");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it.each([{ reasoning: "high" }, { thinkingBudgets: { high: 1024 } }] satisfies SimpleStreamOptions[])(
		"rejects mixed legacy simple controls %j",
		async (legacy) => {
			const fake = fakeAPI();
			const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: {},
				...legacy,
			}).result();
			expect(result.errorMessage).toContain("not both");
			expect(fake.fetch).not.toHaveBeenCalled();
		},
	);
	it("does not transfer first-party claims to other providers, endpoints, or future models", () => {
		const model = ANTHROPIC_MODELS["claude-opus-5"];
		for (const override of [
			{ provider: "gateway" },
			{ api: "bedrock-converse-stream" },
			{ baseUrl: "https://api.anthropic.com.example.test" },
			{ baseUrl: "https://example.test" },
			{ id: "claude-opus-6" },
			{ controls: {} },
		])
			expect(getModelControlCapabilities({ ...model, ...override })).toEqual({});
	});
	it("checks OAuth and an injected client's real endpoint before dispatch", async () => {
		const fake = fakeAPI();
		const model = ANTHROPIC_MODELS["claude-opus-5"];
		for (const options of [
			{ apiKey: "synthetic-sk-ant-oat" },
			{ apiKey: "synthetic", headers: { Authorization: "Bearer synthetic" } },
			{ client: new Anthropic({ apiKey: "synthetic", baseURL: "https://example.test", fetch: fake.fetch }) },
		]) {
			const result = await stream(model, context, {
				fetch: fake.fetch,
				...options,
				controls: { reasoningEffort: "low" },
			}).result();
			expect(result.stopReason).toBe("error");
		}
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("preserves explicit private capability overrides and clips only unimplemented syntax", () => {
		const model: Model<"anthropic-messages"> = {
			...ANTHROPIC_MODELS["claude-opus-5"],
			provider: "custom",
			controls: {
				reasoningMode: {
					values: ["enabled", "invented"],
					evidence: { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" },
				},
				reasoningBudget: {
					minimum: 0,
					maximum: 4096,
					automaticValue: -1,
					disabledValue: 0,
					default: 0,
					evidence: { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" },
				},
			},
		};
		expect(getModelControlCapabilities(model).reasoningMode?.values).toEqual(["enabled"]);
		expect(getModelControlCapabilities(model).reasoningBudget).toMatchObject({ minimum: 1024, maximum: 4096 });
		expect(getModelControlCapabilities(model).reasoningBudget?.automaticValue).toBeUndefined();
		expect(model.controls?.reasoningBudget?.automaticValue).toBe(-1);
		expect(() => validateModelControls(model, { reasoningMode: "enabled", reasoningBudget: 1024 })).not.toThrow();
	});
	it.each(["mode", "effort", "model", "tier", "speed", "adaptive-budget", "mutation"])(
		"rejects payload-hook changes to native selection: %s",
		async (change) => {
			const fake = fakeAPI();
			const controls: ModelControls = { reasoningMode: "adaptive", reasoningEffort: "low" };
			const result = await stream(ANTHROPIC_MODELS["claude-opus-5"], context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls,
				onPayload: (payload) => {
					const params = payload as MessageCreateParamsStreaming;
					if (change === "mode") params.thinking = { type: "disabled" };
					else if (change === "model") params.model = "claude-opus-4-8";
					else if (change === "tier") params.service_tier = "auto";
					else if (change === "speed") Object.assign(params, { speed: "fast" });
					else if (change === "adaptive-budget") Object.assign(params.thinking ?? {}, { budget_tokens: 1024 });
					else params.output_config = { effort: "high" };
					if (change === "mutation") controls.reasoningEffort = "high";
					return params;
				},
			}).result();
			expect(result.errorMessage).toContain("Payload changes conflict");
			expect(fake.fetch).not.toHaveBeenCalled();
		},
	);
});

describe("Anthropic Fast speed and costs", () => {
	it.each(["claude-opus-4-8", "unreviewed-model"])(
		"uses the actual fallback model for Fast cost: %s",
		async (responseModel) => {
			const fake = fakeAPI({ responseModel, startUsage: { speed: "fast", inference_geo: "global" } });
			const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: { processingTier: "fast" },
			}).result();
			expect(result.model).toBe(responseModel);
			expect(result.usage.cost.status).toBe(responseModel === "claude-opus-4-8" ? "estimated" : "unknown");
			if (responseModel === "claude-opus-4-8") expect(result.usage.cost.total).toBeCloseTo(0.00035, 10);
		},
	);
	it("accounts for a legacy Opus 4.6 Fast request reporting standard without advertising Fast support", async () => {
		const fake = fakeAPI({ startUsage: { speed: "standard", inference_geo: "global" } });
		const result = await stream(ANTHROPIC_MODELS["claude-opus-4-6"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			onPayload: (payload) => Object.assign(payload as MessageCreateParamsStreaming, { speed: "fast" }),
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.execution).toEqual({
			requested: {},
			sent: { processingTier: "fast" },
			reported: { processingTier: "standard" },
		});
		expect(result.usage.cost.total).toBeCloseTo(0.000175, 10);
	});
	it("rejects Fast on OAuth and alternate client endpoints before fetching", async () => {
		const fake = fakeAPI();
		for (const options of [
			{ apiKey: "synthetic-sk-ant-oat" },
			{ client: new Anthropic({ apiKey: "synthetic", baseURL: "https://example.test", fetch: fake.fetch }) },
		]) {
			const result = await stream(ANTHROPIC_MODELS["claude-opus-5"], context, {
				...options,
				fetch: fake.fetch,
				controls: { processingTier: "fast" },
			}).result();
			expect(result.stopReason).toBe("error");
		}
		expect(fake.fetch).not.toHaveBeenCalled();
	});
	it("does not apply public Fast rates to an explicitly configured private connection", async () => {
		const fake = fakeAPI({ startUsage: { speed: "fast", inference_geo: "global" } });
		const model = {
			...ANTHROPIC_MODELS["claude-opus-5"],
			provider: "private",
			baseUrl: "https://example.test",
			controls: {
				processingTier: {
					values: ["standard", "fast"],
					evidence: { kind: "user-override" as const, reference: "synthetic", checkedAt: "2026-08-31" },
				},
			},
		};
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.execution?.reported).toEqual({ processingTier: "fast" });
		expect(result.usage.cost.status).toBe("unknown");
	});
	it("does not infer speed from priority capacity or an unrecognized response speed", async () => {
		for (const speed of [undefined, "future-speed"]) {
			const fake = fakeAPI({ startUsage: { service_tier: "priority", speed, inference_geo: "global" } });
			const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: {},
			}).result();
			expect(result.execution?.reported).toBeUndefined();
			expect(result.usage.cost.status).toBe(speed ? "unknown" : "estimated");
		}
	});
	it("advertises only reviewed Fast models, not priority capacity", () => {
		for (const model of Object.values(ANTHROPIC_MODELS)) {
			const control = getModelControlCapabilities(model).processingTier;
			if (["claude-opus-5", "claude-opus-4-8"].includes(model.id))
				expect(control).toMatchObject({
					values: ["standard", "fast"],
					default: "standard",
					evidence: { checkedAt: "2026-08-31" },
				});
			else expect(control).toBeUndefined();
		}
	});
	it.each(["standard", "fast", undefined])("keeps requested, sent, and reported speed distinct: %s", async (speed) => {
		const fake = fakeAPI({ startUsage: { speed, service_tier: "priority", inference_geo: "global" } });
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.execution).toEqual({
			requested: { processingTier: "fast" },
			sent: { processingTier: "fast" },
			...(speed ? { reported: { processingTier: speed } } : {}),
		});
		expect(result.usage.cost.status).toBe("estimated");
		expect(result.usage.cost.total).toBeCloseTo(speed === "standard" ? 0.000175 : 0.00035, 10);
	});
	it.each(["global", "us"])("prices Fast cache tokens and updated 1h writes for %s inference", async (geo) => {
		const fake = fakeAPI({
			startUsage: {
				speed: "fast",
				inference_geo: geo,
				input_tokens: 1_000_000,
				cache_read_input_tokens: 1_000_000,
				cache_creation_input_tokens: 1_000_000,
			},
			finalUsage: {
				output_tokens: 1_000_000,
				cache_creation: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
			},
		});
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-4-8"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.usage.cacheWrite1h).toBe(400_000);
		expect(result.usage.cost.status).toBe("estimated");
		const multiplier = geo === "us" ? 1.1 : 1;
		expect(result.usage.cost.input).toBeCloseTo(10 * multiplier, 10);
		expect(result.usage.cost.output).toBeCloseTo(50 * multiplier, 10);
		expect(result.usage.cost.cacheRead).toBeCloseTo(multiplier, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(15.5 * multiplier, 10);
		expect(result.usage.cost.total).toBeCloseTo(76.5 * multiplier, 10);
	});
	it("updates speed and cost from the final event without confusing capacity tier", async () => {
		const fake = fakeAPI({
			startUsage: { speed: "fast", inference_geo: "global" },
			finalUsage: { speed: "standard", service_tier: "priority" },
		});
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.execution?.reported).toEqual({ processingTier: "standard" });
		expect(result.usage.cost.total).toBeCloseTo(0.000175, 10);
	});
	it.each([undefined, "unreviewed-region"])(
		"marks Fast cost unknown for missing or unreviewed geography: %s",
		async (geo) => {
			const fake = fakeAPI({ startUsage: { speed: "fast", inference_geo: geo } });
			const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: { processingTier: "fast" },
			}).result();
			expect(result.usage.cost.status).toBe("unknown");
		},
	);
	it("does not replace private rates with the reviewed public Fast price", async () => {
		const fake = fakeAPI({ startUsage: { speed: "fast", inference_geo: "global" } });
		const model = {
			...ANTHROPIC_MODELS["claude-opus-5"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		};
		const result = await streamSimple(model, context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.usage.cost.status).toBe("unknown");
		expect(model.cost.input).toBe(1);
	});
	it("preserves caller beta headers along with the required Fast and fallback betas", async () => {
		const fake = fakeAPI();
		const result = await streamSimple(
			{ ...ANTHROPIC_MODELS["claude-opus-5"], headers: { "Anthropic-Beta": "model-beta" } },
			context,
			{
				apiKey: "synthetic",
				fetch: fake.fetch,
				controls: { processingTier: "fast" },
				headers: { "anthropic-beta": "caller-beta" },
			},
		).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(fake.headers[0].get("anthropic-beta")?.split(",")).toEqual(
			expect.arrayContaining([
				"model-beta",
				"caller-beta",
				"fast-mode-2026-02-01",
				"server-side-fallback-2026-07-01",
			]),
		);
	});
	it.each([429, 529])("does not retry Fast at standard speed after HTTP %i", async (errorStatus) => {
		const fake = fakeAPI({ errorStatus });
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			maxRetries: 0,
			controls: { processingTier: "fast" },
		}).result();
		expect(result.stopReason).toBe("error");
		expect(fake.payloads.map((payload) => payload.speed)).toEqual(["fast"]);
		expect(result.execution?.reported).toBeUndefined();
	});
	it.each(["remove", "change", "null"])("rejects native speed changes through payload hooks: %s", async (change) => {
		const fake = fakeAPI();
		const result = await streamSimple(ANTHROPIC_MODELS["claude-opus-5"], context, {
			apiKey: "synthetic",
			fetch: fake.fetch,
			controls: { processingTier: "fast" },
			onPayload: (payload) => {
				const params = payload as BetaMessageCreateParamsStreaming;
				if (change === "remove") delete params.speed;
				else params.speed = change === "null" ? null : "standard";
			},
		}).result();
		expect(result.errorMessage).toContain("Payload changes conflict");
		expect(fake.fetch).not.toHaveBeenCalled();
	});
});
