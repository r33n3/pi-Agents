import { describe, expect, it } from "vitest";
import { getSessionCostPresentation } from "../src/core/serve/browser/model-pricing.ts";

describe("getSessionCostPresentation", () => {
	it("marks used Bedrock models without verified rates as unpriced", () => {
		expect(
			getSessionCostPresentation("bedrock-mantle", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0, true),
		).toEqual({ value: "—", title: "No verified Bedrock token price is configured for this model" });
	});

	it("shows a sub-cent precision value when a verified rate rounds to zero", () => {
		expect(
			getSessionCostPresentation(
				"amazon-bedrock",
				{ input: 0.5, output: 1.2, cacheRead: 0, cacheWrite: 0 },
				0,
				true,
			),
		).toEqual({ value: "0.000", title: "Estimated session cost is below the displayed precision" });
	});

	it("does not label zero-cost local models as unpriced", () => {
		expect(
			getSessionCostPresentation("ollama", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 0, true),
		).toBeUndefined();
	});
});
