import { describe, expect, it } from "vitest";
import {
	getModelSelectionCostPresentations,
	getSessionCostPresentation,
	modelSelectionCostKey,
} from "../src/core/serve/browser/model-pricing.ts";

const cost = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

describe("getModelSelectionCostPresentations", () => {
	it("ranks configured remote models and describes per-million-token rates", () => {
		const presentations = getModelSelectionCostPresentations([
			{ provider: "openai", id: "budget", cost: cost(0.1, 0.4) },
			{ provider: "anthropic", id: "balanced", cost: cost(3, 15, 0.3, 3.75) },
			{ provider: "anthropic", id: "premium", cost: cost(15, 75) },
		]);

		expect(presentations.get(modelSelectionCostKey("openai", "budget"))).toMatchObject({ band: "lowest" });
		expect(presentations.get(modelSelectionCostKey("anthropic", "balanced"))).toMatchObject({
			band: "moderate",
		});
		expect(presentations.get(modelSelectionCostKey("anthropic", "premium"))).toMatchObject({ band: "highest" });
		expect(presentations.get(modelSelectionCostKey("anthropic", "balanced"))?.title).toBe(
			"Moderate cost · Input $3.00 / 1M · Output $15.00 / 1M · Cache read $0.30 / 1M · Cache write $3.75 / 1M",
		);
	});

	it("keeps local and unknown-price models outside the remote cost ranking", () => {
		const presentations = getModelSelectionCostPresentations([
			{ provider: "ollama", id: "local", cost: cost(0, 0) },
			{ provider: "custom", id: "unknown", cost: cost(0, 0) },
		]);

		expect(presentations.get(modelSelectionCostKey("ollama", "local"))).toMatchObject({ band: "local" });
		expect(presentations.get(modelSelectionCostKey("custom", "unknown"))).toMatchObject({ band: "unknown" });
	});
});

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
