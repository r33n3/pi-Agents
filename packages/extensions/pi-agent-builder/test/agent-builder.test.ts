import { describe, expect, test } from "vitest";
import { canonicalAgentModelReference } from "../extensions/agent-builder.ts";

const models = [
	{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
	{ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
] as const;

describe("agent model references", () => {
	test("preserves a canonical provider/model ID", () => {
		expect(canonicalAgentModelReference("openai/gpt-5.6-luna", models)).toBe("openai/gpt-5.6-luna");
	});

	test("normalizes a unique display-name reference", () => {
		expect(canonicalAgentModelReference("openai/GPT5.6 Luna", models)).toBe("openai/gpt-5.6-luna");
	});

	test("rejects an unknown model instead of persisting it", () => {
		expect(() => canonicalAgentModelReference("openai/not-a-model", models)).toThrow(
			"Select an exact provider/model ID",
		);
	});
});
