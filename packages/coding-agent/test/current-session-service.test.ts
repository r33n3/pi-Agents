import {
	getModelControlCapabilities,
	getSupportedThinkingLevels,
	InMemoryModelsStore,
	type Model,
	ModelControlsError,
	type ModelsStoreEntry,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelMetadataSchema } from "@earendil-works/pi-protocol";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { CurrentSessionService } from "../src/core/serve/current-session-service.ts";

describe("CurrentSessionService", () => {
	it("translates native errors thrown during construction without publishing a helper", async () => {
		const session = {
			sessionId: "host",
			sessionManager: { getCwd: () => "synthetic" },
		} as unknown as AgentSession;
		const service = new CurrentSessionService(session, 0, async () => {
			throw new ModelControlsError("Unsupported fixture selection");
		});
		await expect(service.createSession({ id: "helper" })).rejects.toMatchObject({
			code: "invalid_request",
			message: "Unsupported fixture selection",
		});
		expect(await service.listSessions()).toHaveLength(1);
	});
	it("does not misclassify unexpected factory errors as user selections", async () => {
		const failure = new Error("Synthetic storage failure");
		const service = new CurrentSessionService({ sessionId: "host" } as AgentSession, 0, async () => {
			throw failure;
		});
		await expect(service.createSession({ id: "helper" })).rejects.toBe(failure);
	});
	it("projects retained catalog warnings from the runtime, without implying account verification", async () => {
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("openai", { models: null } as unknown as ModelsStoreEntry);
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			modelsStore,
		});
		await modelRuntime.setRuntimeApiKey("openai", "synthetic-only");
		const session = { modelRuntime } as unknown as AgentSession;
		const models = await new CurrentSessionService(session).listModels();
		const openai = models.filter((entry) => entry.provider === "openai");
		expect(openai.length).toBeGreaterThan(0);
		const check = Compile(ModelMetadataSchema);
		for (const model of openai) {
			expect(check.Check(model)).toBe(true);
			expect(model.catalogRefresh).toEqual({
				mode: "cache-only",
				completedAt: expect.any(Number),
				failed: false,
				warning: true,
			});
			expect(model.authenticated).toBe(true); // Configured, not a provider API access check.
			expect(model.catalog).toMatchObject({
				source: "bundled",
				generatedAt: expect.any(Number),
				freshness: "unknown",
			});
		}
		await modelsStore.delete("openai");
		await modelRuntime.refresh({ allowNetwork: false, providers: ["openai"] });
		expect(
			(await new CurrentSessionService(session).listModels()).find((entry) => entry.provider === "openai")
				?.catalogRefresh?.warning,
		).toBe(false);
	});

	it.each([
		{ off: null, minimal: null, low: null, medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
		{ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
	] satisfies ThinkingLevelMap[])(
		"uses model-specific thinking choices, including custom overrides: %j",
		async (thinkingLevelMap) => {
			const source: Model<"openai-responses"> = {
				provider: "test",
				id: "test-model",
				name: "Test model",
				api: "openai-responses",
				baseUrl: "https://example.test",
				reasoning: true,
				thinkingLevelMap,
				input: ["text"],
				contextWindow: 1000,
				maxTokens: 100,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			};
			const session = {
				modelRuntime: {
					getModelControlCapabilities,
					getAvailableSnapshot: () => [source],
					getCatalogRefreshStatus: () => undefined,
					getModelProvenance: () => undefined,
				},
			} as unknown as AgentSession;
			const service = new CurrentSessionService(session);
			expect((await service.listModels())[0].supportedThinkingLevels).toEqual(getSupportedThinkingLevels(source));
			// A catalog refresh or private override must be reflected without rebuilding the service.
			source.thinkingLevelMap = {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			};
			expect((await service.listModels())[0].supportedThinkingLevels).toEqual(["high"]);
		},
	);

	it("projects every bundled model's runtime thinking choices without a separate browser policy", async () => {
		const sources = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
		const session = {
			modelRuntime: {
				getModelControlCapabilities,
				getAvailableSnapshot: () => sources,
				getCatalogRefreshStatus: () => undefined,
				getModelProvenance: () => undefined,
			},
		} as unknown as AgentSession;
		const metadata = await new CurrentSessionService(session).listModels();
		expect(metadata.length).toBe(sources.length);
		const checkMetadata = Compile(ModelMetadataSchema);
		for (const [index, source] of sources.entries()) {
			expect(checkMetadata.Check(metadata[index]), `${source.provider}/${source.id} metadata`).toBe(true);
			expect(metadata[index].supportedThinkingLevels, `${source.provider}/${source.id}`).toEqual(
				getSupportedThinkingLevels(source),
			);
		}
		const router = metadata.find((entry) => entry.provider === "openrouter" && entry.id === "auto");
		expect(router?.cost.status).toBe("unknown");
		expect(router?.cost.input).toBe(0);
	});

	it("projects tiered model costs into the strict protocol shape", async () => {
		const session = {
			sessionId: "session-main",
			modelRuntime: {
				getModelControlCapabilities,
				getCatalogRefreshStatus: () => undefined,
				getModelProvenance: () => undefined,
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

		const service = new CurrentSessionService(session);
		const [model] = await service.listModels();

		expect(model?.cost).toEqual({
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 1.25,
			status: "estimated",
			tiers: [
				{
					inputTokensAbove: 200000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
					status: "estimated",
				},
			],
		});
		expect(service.isActive("session-main")).toBe(true);
		expect(service.isActive("missing")).toBe(false);
		expect(() => service.assertActive("missing")).toThrow("Unknown session: missing");
	});
});
