import { describe, expect, test } from "vitest";
import { createHermesConnectionModels } from "../src/core/serve/hermes-connection.ts";

describe("createHermesConnectionModels", () => {
	test("offers only the local model without API credentials", () => {
		const result = createHermesConnectionModels({});

		expect(result.models).toEqual([{ provider: "custom", id: "qwen3.6:latest", name: "Qwen 3.6 (local Ollama)" }]);
		expect(result.defaultModel).toBe(result.models[0]);
	});

	test("offers API models backed by platform aliases", () => {
		const result = createHermesConnectionModels({
			OPENAI_PLATFORM_API: "configured",
			ANTHROPIC_PLATFORM_API: "configured",
			HERMES_DEFAULT_MODEL: "anthropic/claude-sonnet-5",
		});

		expect(result.models.map((model) => `${model.provider}/${model.id}`)).toEqual([
			"custom/qwen3.6:latest",
			"openai/gpt-5.6-luna",
			"anthropic/claude-sonnet-5",
		]);
		expect(result.defaultModel).toMatchObject({ provider: "anthropic", id: "claude-sonnet-5" });
	});

	test("honors the configured allowlist and excludes models without credentials", () => {
		const result = createHermesConnectionModels({
			OPENAI_API_KEY: "configured",
			HERMES_MODELS: "openai/gpt-5.6-luna, anthropic/claude-sonnet-5",
			HERMES_DEFAULT_MODEL: "openai/gpt-5.6-luna",
		});

		expect(result.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["openai/gpt-5.6-luna"]);
		expect(result.defaultModel).toMatchObject({ provider: "openai", id: "gpt-5.6-luna" });
	});
});
