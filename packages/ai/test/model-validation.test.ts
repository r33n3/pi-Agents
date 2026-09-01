import { describe, expect, it } from "vitest";
import { getModelMetadataErrors } from "../src/model-validation.ts";
import { MODELS } from "../src/models.generated.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	provider: "test",
	api: "openai-responses",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

describe("model metadata validation", () => {
	it("accepts the complete bundled catalog without provider requests", () => {
		for (const catalog of Object.values(MODELS))
			for (const entry of Object.values(catalog)) {
				expect(getModelMetadataErrors(entry), `${entry.provider}/${entry.id}`).toEqual([]);
			}
	});

	it.each([
		["id", "", "id"],
		["reasoning", "true", "reasoning"],
		["input", ["audio"], "input"],
		["contextWindow", 0, "contextWindow"],
		["maxTokens", 0.5, "maxTokens"],
		["maxTokens", Infinity, "maxTokens"],
		["cost", { ...model.cost, input: "1" }, "cost.input"],
		["cost", { ...model.cost, output: NaN }, "cost.output"],
		["thinkingLevelMap", { high: false }, "thinkingLevelMap"],
		["thinkingLevelMap", { ultra: "ultra" }, "unknown Pi level"],
		["thinkingLevelMap", { off: null, minimal: null, low: null, medium: null, high: null }, "at least one level"],
		["headers", { Authorization: 12 }, "headers"],
		["compat", [], "compat"],
	] as const)("rejects invalid %s metadata (%j)", (field, value, message) => {
		expect(getModelMetadataErrors({ ...model, [field]: value }).join("; ")).toContain(message);
	});

	it("allows wire aliases but does not treat them as verified provider support", () => {
		expect(getModelMetadataErrors({ ...model, thinkingLevelMap: { high: "vendor-specific-effort" } })).toEqual([]);
	});

	it("rejects ambiguous or invalid pricing tiers", () => {
		const tier = { ...model.cost, inputTokensAbove: 500 };
		expect(getModelMetadataErrors({ ...model, cost: { ...model.cost, tiers: [tier, tier] } }).join("; ")).toContain(
			"duplicate threshold",
		);
		expect(
			getModelMetadataErrors({ ...model, cost: { ...model.cost, tiers: [{ ...tier, output: Infinity }] } }).join(
				"; ",
			),
		).toContain("cost.tiers[0].output");
	});

	it("does not echo field values in validation errors", () => {
		expect(getModelMetadataErrors({ ...model, thinkingLevelMap: { "private-value": 1 } }).join("; ")).not.toContain(
			"private-value",
		);
	});
});
