import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { CurrentSessionService } from "../src/core/serve/current-session-service.ts";

describe("CurrentSessionService", () => {
	it("projects tiered model costs into the strict protocol shape", async () => {
		const session = {
			modelRuntime: {
				getAvailableSnapshot: () => [
					{
						provider: "test",
						id: "tiered-model",
						name: "Tiered model",
						api: "test-api",
						reasoning: true,
						input: ["text"],
						contextWindow: 100_000,
						maxTokens: 10_000,
						cost: {
							input: 1,
							output: 2,
							cacheRead: 0.1,
							cacheWrite: 1.25,
							tiers: [
								{
									inputTokensAbove: 200_000,
									input: 2,
									output: 3,
									cacheRead: 0.2,
									cacheWrite: 2.5,
								},
							],
						},
					},
				],
			},
		} as unknown as AgentSession;

		const [model] = await new CurrentSessionService(session).listModels();

		expect(model?.cost).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
		expect(model?.cost).not.toHaveProperty("tiers");
	});
});
