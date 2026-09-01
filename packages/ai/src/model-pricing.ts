export interface ModelCostRates {
	input: number; // $/million tokens
	output: number; // $/million tokens
	cacheRead: number; // $/million tokens
	cacheWrite: number; // $/million tokens
	/** Explicit zero rates need estimated status to distinguish them from missing-price defaults. */
	status?: "estimated" | "unknown";
}

export interface ModelCostTier extends ModelCostRates {
	/** Use this tier for requests whose total input usage exceeds this token count. */
	inputTokensAbove: number;
}

export interface ModelCost extends ModelCostRates {
	/** Request-wide pricing tiers. The highest matching input threshold applies to the full request. */
	tiers?: ModelCostTier[];
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** Unknown costs are not zero-dollar charges; reported requires explicit provider cost data. */
	status?: "estimated" | "unknown" | "reported";
}

/** Numeric catalog rates are estimates, not proof of a provider charge or account-specific price. */
export function getModelCostStatus(cost: ModelCostRates): "estimated" | "unknown" {
	const rates = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
	if (cost.status === "unknown" || rates.some((rate) => !Number.isFinite(rate) || rate < 0)) return "unknown";
	return cost.status === "estimated" || rates.some((rate) => rate > 0) ? "estimated" : "unknown";
}

/** Keep unknown legacy values unknown when projecting them into non-negative transport schemas. */
export function getUsageCostStatus(cost: UsageCost): "estimated" | "unknown" | "reported" {
	const values = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total];
	if (cost.status === "unknown" || values.some((value) => !Number.isFinite(value) || value < 0)) return "unknown";
	if (cost.status === "reported" || cost.status === "estimated") return cost.status;
	return values.some((value) => value > 0) ? "estimated" : "unknown";
}

function normalizedRates(cost: ModelCostRates): ModelCostRates {
	const status = getModelCostStatus(cost);
	return {
		input: status === "unknown" ? 0 : cost.input,
		output: status === "unknown" ? 0 : cost.output,
		cacheRead: status === "unknown" ? 0 : cost.cacheRead,
		cacheWrite: status === "unknown" ? 0 : cost.cacheWrite,
		status,
	};
}

/** Public cost metadata; preserves threshold pricing and never exposes negative unknown sentinels as rates. */
export function normalizeModelCost(cost: ModelCost): ModelCost {
	return {
		...normalizedRates(cost),
		...(cost.tiers
			? { tiers: cost.tiers.map((tier) => ({ inputTokensAbove: tier.inputTokensAbove, ...normalizedRates(tier) })) }
			: {}),
	};
}
