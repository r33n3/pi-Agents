import { getModelCostStatus, type ModelCost } from "./model-pricing.ts";
import type { Api, Model } from "./types.ts";

/** Exact public-API IDs reviewed against Anthropic Fast mode on 2026-08-31. */
export const ANTHROPIC_FAST_MODELS: readonly string[] = ["claude-opus-5", "claude-opus-4-8"];

/**
 * Speed is not Anthropic's priority-capacity service_tier. Apply reviewed public
 * speed/residency rates only to matching base prices; private prices are not
 * silently replaced or assumed to carry the same premium. These remain estimates.
 */
export function getAnthropicProcessingCost(
	model: Model<Api>,
	speed: unknown,
	inferenceGeo: unknown,
	publicApi: boolean,
): ModelCost {
	const cost = model.cost;
	const unknown: ModelCost = { ...cost, tiers: undefined, status: "unknown" };
	if (speed != null && speed !== "standard" && speed !== "fast") return unknown;
	if (speed !== "fast" && (inferenceGeo == null || inferenceGeo === "global")) return cost;
	if (
		!publicApi ||
		!ANTHROPIC_FAST_MODELS.includes(model.id) ||
		getModelCostStatus(cost) === "unknown" ||
		cost.tiers?.length ||
		cost.input !== 5 ||
		cost.output !== 25 ||
		cost.cacheRead !== 0.5 ||
		cost.cacheWrite !== 6.25 ||
		(inferenceGeo !== "global" && inferenceGeo !== "us")
	)
		return unknown;
	// https://platform.claude.com/docs/en/build-with-claude/fast-mode
	// https://platform.claude.com/docs/en/manage-claude/data-residency
	const multiplier = (speed === "fast" ? 2 : 1) * (inferenceGeo === "us" ? 1.1 : 1);
	return {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
		status: "estimated",
	};
}
