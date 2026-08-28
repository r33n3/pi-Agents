import { describe, expect, it } from "vitest";
import { filterPresentedModels } from "../src/core/serve/browser/model-visibility.ts";

describe("filterPresentedModels", () => {
	it("keeps direct OpenAI and Anthropic models while hiding their Bedrock routes", () => {
		const models = [
			{ provider: "openai", id: "gpt-5.6-luna" },
			{ provider: "anthropic", id: "claude-sonnet-5" },
			{ provider: "amazon-bedrock", id: "global.openai.gpt-5.6-terra" },
			{ provider: "amazon-bedrock", id: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
			{ provider: "bedrock-mantle", id: "openai.gpt-oss-20b" },
			{ provider: "bedrock-mantle-anthropic", id: "anthropic.claude-sonnet-5" },
			{ provider: "bedrock-mantle", id: "qwen.qwen3-coder-next" },
		];

		expect(filterPresentedModels(models)).toEqual([
			{ provider: "openai", id: "gpt-5.6-luna" },
			{ provider: "anthropic", id: "claude-sonnet-5" },
			{ provider: "bedrock-mantle", id: "qwen.qwen3-coder-next" },
		]);
	});
});
