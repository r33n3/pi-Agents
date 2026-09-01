import type { ModelMetadata } from "@earendil-works/pi-protocol";

const evidence = {
	kind: "user-override",
	reference: "Synthetic UI fixture, not provider verification",
	checkedAt: "2026-08-31",
} as const;
const catalogRefresh = {
	mode: "cache-only",
	completedAt: Date.parse("2026-08-31T12:00:00Z"),
	failed: false,
	warning: true,
} as const;
export const NATIVE_UI_MODELS: ModelMetadata[] = [
	{
		provider: "fixture",
		id: "native",
		name: "Synthetic native model",
		api: "fixture",
		reasoning: true,
		input: ["text"],
		contextWindow: 4096,
		maxTokens: 1024,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, status: "estimated" },
		supportedThinkingLevels: ["off", "low", "high"],
		authenticated: true,
		catalogRefresh,
		catalog: {
			source: "remote-catalog",
			loadedFrom: "cache",
			generatedAt: Date.parse("2026-08-28T12:00:00Z"),
			checkedAt: Date.parse("2026-08-29T12:00:00Z"),
			refreshIntervalMs: 14_400_000,
			freshness: "refresh-due",
			overrides: ["user-config"],
		},
		controls: {
			reasoningMode: { values: ["adaptive", "enabled", "disabled"], evidence },
			reasoningEffort: { values: ["low", "high"], default: "high", evidence },
			reasoningBudget: { minimum: 512, maximum: 4096, automaticValue: -1, disabledValue: 0, evidence },
			processingTier: {
				values: ["default", "fast"],
				guidance:
					"Synthetic preview: access requires provider approval. A configured credential does not verify eligibility. Fast changes processing speed, not reasoning effort. Premium rates are estimates, not your account price. Unset inherits the service default; choose default explicitly for Standard. This fixture sends no provider requests.",
				evidence,
			},
		},
	},
	{
		provider: "fixture",
		id: "connection-unverified",
		name: "Synthetic unverified connection",
		api: "fixture",
		reasoning: true,
		input: ["text"],
		contextWindow: 4096,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, status: "unknown" },
		supportedThinkingLevels: ["off", "low", "high"],
		authenticated: true,
		controls: {},
	},
	{
		provider: "fixture",
		id: "legacy",
		name: "Synthetic legacy-only model",
		api: "fixture",
		reasoning: false,
		input: ["text"],
		contextWindow: 4096,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, status: "unknown" },
		supportedThinkingLevels: ["off"],
		authenticated: true,
		catalogRefresh,
		catalog: { source: "bundled", generatedAt: Date.parse("2026-08-28T12:00:00Z"), freshness: "unknown" },
	},
];
