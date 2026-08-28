import type { ExternalConnectionModel } from "./external-connection-manager.ts";

export interface HermesConnectionModels {
	defaultModel: ExternalConnectionModel;
	models: ExternalConnectionModel[];
}

const HERMES_MODEL_CATALOG: Readonly<Record<string, ExternalConnectionModel>> = {
	"custom/qwen3.6:latest": {
		provider: "custom",
		id: "qwen3.6:latest",
		name: "Qwen 3.6 (local Ollama)",
	},
	"openai/gpt-5.6-luna": {
		provider: "openai",
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna (OpenAI API)",
	},
	"anthropic/claude-sonnet-5": {
		provider: "anthropic",
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (Anthropic API)",
	},
};

const LOCAL_MODEL_KEY = "custom/qwen3.6:latest";

/** Builds the Hermes model picker from local configuration without exposing credential values. */
export function createHermesConnectionModels(
	environment: Readonly<Record<string, string | undefined>>,
): HermesConnectionModels {
	const availableKeys = new Set([LOCAL_MODEL_KEY]);
	if (environment.OPENAI_API_KEY?.trim() || environment.OPENAI_PLATFORM_API?.trim()) {
		availableKeys.add("openai/gpt-5.6-luna");
	}
	if (environment.ANTHROPIC_API_KEY?.trim() || environment.ANTHROPIC_PLATFORM_API?.trim()) {
		availableKeys.add("anthropic/claude-sonnet-5");
	}

	const configuredKeys = environment.HERMES_MODELS?.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	const selectedKeys = configuredKeys?.length
		? configuredKeys.filter((key) => availableKeys.has(key) && HERMES_MODEL_CATALOG[key])
		: [...availableKeys];
	if (selectedKeys.length === 0) selectedKeys.push(LOCAL_MODEL_KEY);

	const models = selectedKeys.map((key) => HERMES_MODEL_CATALOG[key]!);
	const preferredKey = environment.HERMES_DEFAULT_MODEL?.trim().toLowerCase();
	const defaultModel =
		(preferredKey ? models.find((model) => `${model.provider}/${model.id}` === preferredKey) : undefined) ??
		models[0]!;
	return { defaultModel, models };
}
