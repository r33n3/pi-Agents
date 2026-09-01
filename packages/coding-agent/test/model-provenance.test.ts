import {
	createProvider,
	InMemoryCredentialStore,
	type Model,
	type ModelCatalogProvenance,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ModelConfig, type ModelsJsonProvider } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const model: Model<"openai-completions"> = {
	provider: "synthetic",
	id: "model",
	name: "Synthetic",
	api: "openai-completions",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function baseline() {
	return withRemoteCatalog(
		createProvider({
			id: model.provider,
			models: [model],
			auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
			api: {
				stream: () => {
					throw new Error("No requests allowed");
				},
				streamSimple: () => {
					throw new Error("No requests allowed");
				},
			},
		}),
		"https://catalog.example.test",
		1000,
	);
}

async function composed(config?: ModelsJsonProvider, extension?: ProviderConfigInput) {
	const modelConfig = await ModelConfig.load(undefined);
	vi.spyOn(modelConfig, "getProvider").mockReturnValue(config);
	return composeModelProvider("synthetic", baseline(), modelConfig, extension);
}

describe("composed catalog provenance", () => {
	it("preserves bundle origin through credential-only configuration", async () => {
		const provider = await composed({ apiKey: "synthetic-secret" });
		expect(provider.getModelProvenance?.("model")).toMatchObject({ source: "bundled", generatedAt: 1000 });
		expect(provider.getModelProvenance?.("model")?.overrides).toBeUndefined();
		expect(provider.getModelProvenance?.("missing")).toBeUndefined();
	});
	it("records partial private overrides without giving them the bundle's date", async () => {
		const provider = await composed({ modelOverrides: { model: { contextWindow: 2000 } } });
		expect(provider.getModels()[0].contextWindow).toBe(2000);
		expect(provider.getModelProvenance?.("model")).toMatchObject({
			source: "bundled",
			generatedAt: 1000,
			overrides: ["user-config"],
		});
	});
	it("treats a replacement model as private configuration, not a reviewed bundle entry", async () => {
		const provider = await composed({ models: [{ id: "model", name: "Private replacement" }] });
		expect(provider.getModelProvenance?.("model")).toEqual({ source: "user-config" });
	});
	it("records extension replacement and topmost private overrides in application order", async () => {
		const provider = await composed({ modelOverrides: { model: { maxTokens: 50 } } }, { models: [model] });
		expect(provider.getModelProvenance?.("model")).toEqual({ source: "extension", overrides: ["user-config"] });
		expect(provider.getModels()[0].maxTokens).toBe(50);
		const snapshot = provider.getModelProvenance?.("model");
		snapshot?.overrides?.push("extension");
		expect(provider.getModelProvenance?.("model")?.overrides).toEqual(["user-config"]);
	});
	it("records endpoint/transport changes even when the model data comes from a bundle", async () => {
		const provider = await composed({ baseUrl: "https://private.test" }, { baseUrl: "https://extension.test" });
		expect(provider.getModels()[0].baseUrl).toBe("https://extension.test");
		expect(provider.getModelProvenance?.("model")).toMatchObject({
			source: "bundled",
			overrides: ["user-config", "extension"],
		});
	});
	it("updates extension provenance only with published model changes", async () => {
		const provider = await composed(undefined, { refreshModels: async () => [{ ...model, id: "refreshed" }] });
		const signal = new AbortController().signal;
		const context: RefreshModelsContext = {
			allowNetwork: false,
			signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		};
		await provider.refreshModels?.(context);
		expect(provider.getModelProvenance?.("refreshed")).toMatchObject({
			source: "extension",
			loadedFrom: "refresh",
			checkedAt: expect.any(Number),
		});
		expect(provider.getModelProvenance?.("model")).toBeUndefined();
	});
	it("rejects invalid extension refreshes without replacing last-good models or their source dates", async () => {
		let invalid = false;
		const provider = await composed(undefined, {
			refreshModels: async () => [{ ...model, maxTokens: invalid ? 0 : 100 }],
		});
		const context: RefreshModelsContext = {
			allowNetwork: false,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		};
		await provider.refreshModels?.(context);
		const previous = provider.getModelProvenance?.("model");
		invalid = true;
		await expect(provider.refreshModels?.(context)).rejects.toThrow("maxTokens");
		expect(provider.getModels()[0].maxTokens).toBe(100);
		expect(provider.getModelProvenance?.("model")).toEqual(previous);
	});
});

describe("runtime catalog provenance", () => {
	it("reports bundle generation separately from capability review and freshness", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const models = runtime.getModels().filter((entry) => entry.provider !== "radius");
		expect(models.length).toBeGreaterThan(1000);
		for (const entry of models)
			expect(runtime.getModelProvenance(entry.provider, entry.id)).toEqual({
				source: "bundled",
				generatedAt: expect.any(Number),
				freshness: "unknown",
			});
		expect(runtime.getModelProvenance("openai", "not-a-model")).toBeUndefined();
	});
	it("does not leak arbitrary provider metadata or let broken optional provenance disable models", async () => {
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
		const provider = baseline();
		provider.getModelProvenance = () =>
			({
				source: "provider",
				endpoint: "https://private.test",
				token: "secret",
				freshness: "verified",
			}) as unknown as ModelCatalogProvenance;
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false, providers: [provider.id] });
		expect(runtime.getModelProvenance(provider.id, "model")).toEqual({ source: "provider", freshness: "unknown" });
		provider.getModelProvenance = () => {
			throw new Error("private path");
		};
		expect(runtime.getModelProvenance(provider.id, "model")).toBeUndefined();
		expect(runtime.getModel(provider.id, "model")).toEqual(model);
	});
});
