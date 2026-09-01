import { getModelCostStatus, type ModelCost } from "@earendil-works/pi-ai/model-pricing";

const LOCAL_PROVIDER_IDS = new Set(["ollama"]);
const COST_BANDS = [
	{ id: "lowest", label: "Lowest cost", color: "#2dd4bf" },
	{ id: "low", label: "Low cost", color: "#60a5fa" },
	{ id: "moderate", label: "Moderate cost", color: "#facc15" },
	{ id: "high", label: "High cost", color: "#fb923c" },
	{ id: "highest", label: "Highest cost", color: "#e879f9" },
] as const;

interface PricedModel {
	provider: string;
	id: string;
	cost: ModelCost;
}

export interface ModelSelectionCostPresentation {
	band: (typeof COST_BANDS)[number]["id"] | "local" | "unknown";
	color: string;
	title: string;
}

export interface SessionCostPresentation {
	value: string;
	title: string;
}

export function modelSelectionCostKey(provider: string, id: string): string {
	return `${provider}\u0000${id}`;
}

/** Ranks base catalog estimates by a 75% input / 25% output token blend, not verified billed cost. */
export function getModelSelectionCostPresentations(
	models: readonly PricedModel[],
): ReadonlyMap<string, ModelSelectionCostPresentation> {
	const scores = [
		...new Set(
			models
				.filter(
					(model) => !LOCAL_PROVIDER_IDS.has(model.provider) && getModelCostStatus(model.cost) === "estimated",
				)
				.map((model) => blendedTokenPrice(model.cost)),
		),
	].sort((left, right) => left - right);
	const bandForScore = new Map(
		scores.map((score, index) => [
			score,
			COST_BANDS[
				scores.length === 1 ? 2 : Math.round((index / Math.max(1, scores.length - 1)) * (COST_BANDS.length - 1))
			],
		]),
	);
	const presentations = new Map<string, ModelSelectionCostPresentation>();
	for (const model of models) {
		const key = modelSelectionCostKey(model.provider, model.id);
		if (LOCAL_PROVIDER_IDS.has(model.provider)) {
			presentations.set(key, {
				band: "local",
				color: "#a78bfa",
				title: "Local model · API token pricing does not apply",
			});
			continue;
		}
		if (getModelCostStatus(model.cost) === "unknown") {
			presentations.set(key, {
				band: "unknown",
				color: "#6b7280",
				title: "Pricing unavailable for this model",
			});
			continue;
		}
		const band = bandForScore.get(blendedTokenPrice(model.cost)) ?? COST_BANDS[2];
		const cacheRates = [
			model.cost.cacheRead > 0 ? `Cache read ${formatRate(model.cost.cacheRead)}` : undefined,
			model.cost.cacheWrite > 0 ? `Cache write ${formatRate(model.cost.cacheWrite)}` : undefined,
		].filter((entry): entry is string => entry !== undefined);
		presentations.set(key, {
			band: band.id,
			color: band.color,
			title: [
				band.label,
				"Estimated base rates",
				`Input ${formatRate(model.cost.input)}`,
				`Output ${formatRate(model.cost.output)}`,
				...cacheRates,
				...(model.cost.tiers ?? []).map(
					(tier) =>
						`Above ${tier.inputTokensAbove.toLocaleString("en-US")} input tokens: ${getModelCostStatus(tier) === "unknown" ? "pricing unavailable" : `input ${formatRate(tier.input)}, output ${formatRate(tier.output)}`}`,
				),
			].join(" · "),
		});
	}
	return presentations;
}

function blendedTokenPrice(cost: ModelCost): number {
	return cost.input * 0.75 + cost.output * 0.25;
}

function formatRate(rate: number): string {
	return `$${rate < 0.1 && rate > 0 ? rate.toFixed(4) : rate.toFixed(2)} / 1M`;
}

export function getSessionCostPresentation(
	provider: string,
	modelCost: ModelCost | undefined,
	totalCost: number,
	hasUsage: boolean,
	hasUnknownCost = false,
): SessionCostPresentation | undefined {
	if (hasUnknownCost || !Number.isFinite(totalCost) || totalCost < 0) {
		return totalCost > 0 && Number.isFinite(totalCost)
			? { value: `${totalCost.toFixed(3)}+`, title: "Known session subtotal; some request costs are unknown" }
			: { value: "—", title: "Session cost is unknown" };
	}
	if (totalCost > 0) {
		return { value: totalCost.toFixed(3), title: "Estimated session cost in US dollars" };
	}
	if (!hasUsage || LOCAL_PROVIDER_IDS.has(provider)) return undefined;
	if (modelCost && getModelCostStatus(modelCost) === "estimated") {
		return { value: totalCost.toFixed(3), title: "Estimated session cost is below the displayed precision" };
	}
	return { value: "—", title: "Session cost is unknown; token pricing is unavailable" };
}
