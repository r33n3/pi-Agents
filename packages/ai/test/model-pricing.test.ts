import { describe, expect, it } from "vitest";
import { getModelCostStatus, getUsageCostStatus, normalizeModelCost } from "../src/model-pricing.ts";
import { calculateCost } from "../src/models.ts";
import type { Model, ModelCost, Usage } from "../src/types.ts";

const cost: ModelCost = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
const model: Model<"openai-responses"> = {
	id: "fixture",
	provider: "fixture",
	api: "openai-responses",
	name: "fixture",
	baseUrl: "https://fixture.test/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000000,
	maxTokens: 1000,
	cost,
};

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

describe("explicit pricing status", () => {
	it.each([
		{ input: -1000000, output: -1000000, cacheRead: 0, cacheWrite: 0 },
		{ ...cost, cacheRead: -1 },
		{ ...cost, output: Number.POSITIVE_INFINITY },
		{ ...cost, status: "unknown" as const },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	])("never turns unknown rates into savings or zero-dollar claims: %j", (rates) => {
		const result = calculateCost({ ...model, cost: rates }, usage());
		expect(result).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, status: "unknown" });
		expect(getModelCostStatus(rates)).toBe("unknown");
	});
	it("distinguishes explicitly configured zero pricing from missing prices", () => {
		const result = calculateCost(
			{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, status: "estimated" } },
			usage(),
		);
		expect(result.total).toBe(0);
		expect(result.status).toBe("estimated");
	});
	it("uses the highest matching full-input tier including cached tokens", () => {
		const tiered = {
			...model,
			cost: {
				...cost,
				tiers: [
					{ ...cost, inputTokensAbove: 200, input: 4 },
					{ ...cost, inputTokensAbove: 100, input: 2 },
				],
			},
		};
		expect(calculateCost(tiered, usage({ input: 100, cacheRead: 100 })).input).toBeCloseTo(0.0002);
		expect(calculateCost(tiered, usage({ input: 100, cacheRead: 101 })).input).toBeCloseTo(0.0004);
		expect(calculateCost(tiered, usage({ input: 100, cacheRead: 101 })).status).toBe("estimated");
	});
	it("marks a request unknown when the selected context tier has unknown pricing", () => {
		expect(
			calculateCost(
				{ ...model, cost: { ...cost, tiers: [{ ...cost, inputTokensAbove: 50, status: "unknown" }] } },
				usage(),
			).status,
		).toBe("unknown");
	});
	it("does not calculate negative or infinite costs from malformed usage", () => {
		for (const input of [-1, Number.POSITIVE_INFINITY, Number.NaN])
			expect(calculateCost(model, usage({ input }))).toMatchObject({ total: 0, status: "unknown" });
		expect(calculateCost(model, usage({ cacheWrite: 1, cacheWrite1h: 2 })).status).toBe("unknown");
	});
	it("projects immutable non-negative rates while preserving context tiers and their status", () => {
		const source: ModelCost = { ...cost, tiers: [{ ...cost, inputTokensAbove: 200000, output: -1 }] };
		const normalized = normalizeModelCost(source);
		expect(normalized.status).toBe("estimated");
		expect(normalized.tiers?.[0]).toEqual({
			inputTokensAbove: 200000,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			status: "unknown",
		});
		expect(source.tiers?.[0].output).toBe(-1);
	});
	it("only labels cost as reported when explicitly supplied as reported", () => {
		expect(getUsageCostStatus({ ...usage().cost, total: 1 })).toBe("estimated");
		expect(getUsageCostStatus({ ...usage().cost, total: 1, status: "reported" })).toBe("reported");
		expect(getUsageCostStatus({ ...usage().cost, total: -1, status: "reported" })).toBe("unknown");
		expect(getUsageCostStatus(usage().cost)).toBe("unknown");
	});
});
