import type { ModelCost } from "@earendil-works/pi-ai";

const BEDROCK_PROVIDER_IDS = new Set(["amazon-bedrock", "bedrock-mantle"]);

export interface SessionCostPresentation {
	value: string;
	title: string;
}

export function getSessionCostPresentation(
	provider: string,
	modelCost: ModelCost | undefined,
	totalCost: number,
	hasUsage: boolean,
): SessionCostPresentation | undefined {
	if (totalCost > 0) {
		return { value: totalCost.toFixed(3), title: "Estimated session cost in US dollars" };
	}
	if (!hasUsage || !BEDROCK_PROVIDER_IDS.has(provider)) return undefined;
	if (modelCost && Object.values(modelCost).some((rate) => rate > 0)) {
		return { value: totalCost.toFixed(3), title: "Estimated session cost is below the displayed precision" };
	}
	return { value: "—", title: "No verified Bedrock token price is configured for this model" };
}
