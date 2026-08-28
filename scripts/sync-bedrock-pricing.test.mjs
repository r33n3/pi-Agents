import assert from "node:assert/strict";
import test from "node:test";
import { applyBedrockPricing } from "./sync-bedrock-pricing.mjs";

test("applies catalog rates to explicit Mantle models and Bedrock overrides", () => {
	const config = {
		providers: {
			"bedrock-mantle": { models: [{ id: "model-a" }, { id: "unpriced" }] },
		},
	};
	const catalog = {
		models: {
			"model-a": {
				providers: ["amazon-bedrock", "bedrock-mantle"],
				input: 0.5,
				output: 1.2,
				cacheRead: 0,
				cacheWrite: 0,
			},
		},
	};
	const result = applyBedrockPricing(config, catalog);
	const expectedCost = { input: 0.5, output: 1.2, cacheRead: 0, cacheWrite: 0 };
	assert.deepEqual(result.providers["bedrock-mantle"].models, [
		{ id: "model-a", cost: expectedCost },
		{ id: "unpriced" },
	]);
	assert.deepEqual(result.providers["amazon-bedrock"].modelOverrides["model-a"], { cost: expectedCost });
	assert.deepEqual(config.providers["bedrock-mantle"].models, [{ id: "model-a" }, { id: "unpriced" }]);
});
