export interface PresentableModel {
	provider: string;
	id: string;
}

function isBedrockProvider(provider: string): boolean {
	return provider === "amazon-bedrock" || provider.startsWith("bedrock-");
}

function isDirectPlatformModelId(modelId: string): boolean {
	const segments = modelId.split(".");
	return segments.includes("openai") || segments.includes("anthropic");
}

export function filterPresentedModels<T extends PresentableModel>(models: readonly T[]): T[] {
	return models.filter((model) => !isBedrockProvider(model.provider) || !isDirectPlatformModelId(model.id));
}
