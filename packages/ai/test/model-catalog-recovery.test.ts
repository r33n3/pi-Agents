import { describe, expect, it, vi } from "vitest";
import { validateModelCatalog, validateModelsStoreEntry } from "../src/model-validation.ts";
import { createModels, createProvider, type RefreshModelsContext } from "../src/models.ts";
import { InMemoryModelsStore, type ModelsStoreEntry } from "../src/models-store.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "fixture",
	provider: "fixture",
	api: "openai-responses",
	baseUrl: "https://fixture.test/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

const api = {
	stream: () => {
		throw new Error("No request permitted");
	},
	streamSimple: () => {
		throw new Error("No request permitted");
	},
};
const auth = { apiKey: { name: "fixture", resolve: async () => ({ auth: {} }) } };

describe("shared catalog integrity", () => {
	it.each([
		{ models: [model, model] },
		{ models: [{ ...model, provider: "other" }] },
		{ models: [{ ...model, contextWindow: 0 }] },
		{ models: [model], checkedAt: -1 },
		{ models: [model], lastModified: Number.NaN },
		{ models: [model], etag: "unsafe\r\nHeader: value" },
		null,
		{ models: "not an array" },
	])("rejects invalid cache snapshots: %j", (entry) => {
		expect(() => validateModelsStoreEntry("fixture", entry)).toThrow();
	});
	it("validates catalog shape without disclosing invalid values", () => {
		expect(() => validateModelCatalog("fixture", [{ ...model, maxTokens: "synthetic-sensitive-data" }])).toThrow(
			"maxTokens",
		);
		try {
			validateModelCatalog("fixture", [{ ...model, maxTokens: "synthetic-sensitive-data" }]);
		} catch (error) {
			expect(String(error)).not.toContain("synthetic-sensitive-data");
		}
	});
});

describe("dynamic provider catalog recovery", () => {
	it("validates provider-owned publications before storage or synchronous state changes", async () => {
		const store = new InMemoryModelsStore();
		await store.write("fixture", { models: [model] });
		const update = vi.fn();
		const provider = {
			...createProvider({ id: "fixture", models: [model], auth, api }),
			refreshModels: async (context: RefreshModelsContext) => {
				if (!context.allowNetwork) return;
				await context.publish({ persist: { models: [{ ...model, maxTokens: 0 }] }, update });
			},
		};
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		const result = await models.refresh();
		expect(result.errors.get("fixture")?.message).toContain("maxTokens");
		expect(update).not.toHaveBeenCalled();
		expect((await store.read("fixture"))?.models).toEqual([model]);
	});
	it("ignores a bad cache offline and repairs it online without blocking the network phase", async () => {
		const store = new InMemoryModelsStore();
		const invalid = { models: [{ ...model, maxTokens: 0 }], checkedAt: Date.now() };
		await store.write("fixture", invalid);
		const fetchModels = vi.fn(async (context: RefreshModelsContext) => {
			expect(context.stored).toBeUndefined();
			return [{ ...model, id: "fresh" }];
		});
		const provider = createProvider({ id: "fixture", models: [model], auth, api, fetchModels });
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		const offline = await models.refresh({ allowNetwork: false });
		expect(offline.errors.size).toBe(0);
		expect(offline.warnings?.get("fixture")?.message).toContain("Cached catalog could not be loaded");
		expect(fetchModels).not.toHaveBeenCalled();
		expect(provider.getModels()).toEqual([model]);
		expect(await store.read("fixture")).toEqual(invalid);
		const online = await models.refresh();
		expect(online.errors.size).toBe(0);
		expect(online.warnings?.size).toBe(1);
		expect(fetchModels).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["fixture", "fresh"]);
		expect((await store.read("fixture"))?.models[0].id).toBe("fresh");
		expect((await models.refresh({ allowNetwork: false })).warnings).toBeUndefined();
	});

	it("retains the last valid overlay when cached and newly fetched data become invalid", async () => {
		const store = new InMemoryModelsStore();
		let refreshed = [{ ...model, id: "last-good" }];
		const provider = createProvider({
			id: "fixture",
			models: [model],
			auth,
			api,
			fetchModels: async () => refreshed,
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		await models.refresh();
		await store.write("fixture", { models: [{ ...model, provider: "wrong" }] });
		refreshed = [{ ...model, id: "bad", maxTokens: 0 }];
		const result = await models.refresh();
		expect(result.errors.get("fixture")?.message).toContain("maxTokens");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["fixture", "last-good"]);
		expect((await store.read("fixture"))?.models[0].provider).toBe("wrong");
	});

	it("direct factory refresh never gives invalid cached metadata to its fetcher", async () => {
		const fetchModels = vi.fn(async (context: RefreshModelsContext) => {
			expect(context.stored).toBeUndefined();
			return [model];
		});
		const provider = createProvider({ id: "fixture", models: [], auth, api, fetchModels });
		const reportWarning = vi.fn();
		await provider.refreshModels!({
			stored: { models: null } as unknown as ModelsStoreEntry,
			reportWarning,
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		expect(reportWarning).toHaveBeenCalledTimes(1);
		expect(provider.getModels()).toEqual([model]);
	});
});
