import { afterEach, describe, expect, it, vi } from "vitest";
import { getModelCatalogSnapshot } from "../src/model-provenance.ts";
import { validateModelsStoreEntry } from "../src/model-validation.ts";
import { createModels, createProvider } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import type { Model } from "../src/types.ts";

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
afterEach(() => vi.restoreAllMocks());

describe("catalog provenance", () => {
	it("flags future source dates without claiming freshness even when the check time is recent", () => {
		expect(
			getModelCatalogSnapshot(
				{ source: "remote-catalog", checkedAt: 100, generatedAt: 200, refreshIntervalMs: 10 },
				105,
			),
		).toMatchObject({ freshness: "unknown", timestampWarning: "future" });
	});
	it("allowlists metadata and returns independent override arrays", () => {
		const input = {
			source: "remote-catalog",
			loadedFrom: "cache",
			checkedAt: 100,
			refreshIntervalMs: 10,
			overrides: ["user-config"],
			endpoint: "https://private.test",
			headers: { token: "secret" },
			freshness: "verified",
		};
		const result = getModelCatalogSnapshot(input, 105)!;
		expect(result).toEqual({
			source: "remote-catalog",
			loadedFrom: "cache",
			checkedAt: 100,
			refreshIntervalMs: 10,
			overrides: ["user-config"],
			freshness: "within-refresh-window",
		});
		result.overrides?.push("extension");
		expect(input.overrides).toEqual(["user-config"]);
		expect(JSON.stringify(result)).not.toMatch(/private|secret|verified/);
	});
	it.each([
		[99, "unknown"],
		[100, "within-refresh-window"],
		[109, "within-refresh-window"],
		[110, "refresh-due"],
		[10000, "refresh-due"],
		[NaN, "unknown"],
		[Infinity, "unknown"],
	])("uses the source window at time %s without trusting future timestamps", (now, freshness) => {
		expect(
			getModelCatalogSnapshot({ source: "remote-catalog", checkedAt: 100, refreshIntervalMs: 10 }, now)?.freshness,
		).toBe(freshness);
	});
	it.each([
		{ source: "bundled", generatedAt: 100 },
		{ source: "remote-catalog", checkedAt: 100 },
		{ source: "user-config" },
		{ source: "extension" },
	])("does not infer freshness from incomplete or configured provenance: %j", (value) => {
		expect(getModelCatalogSnapshot(value, 101)?.freshness).toBe("unknown");
	});
	it.each([
		null,
		[],
		{ source: "verified" },
		{ source: "provider", checkedAt: -1 },
		{ source: "provider", checkedAt: Infinity },
		{ source: "provider", generatedAt: 9e15 },
		{ source: "provider", refreshIntervalMs: 0 },
		{ source: "provider", loadedFrom: "network-verified" },
		{ source: "provider", overrides: ["private-secret"] },
	])("rejects malformed optional provenance: %j", (value) => {
		expect(getModelCatalogSnapshot(value)).toBeUndefined();
	});
	it("validates successful catalog timestamps in persisted entries", () => {
		expect(() => validateModelsStoreEntry("synthetic", { models: [model], validatedAt: 100 })).not.toThrow();
		for (const validatedAt of [-1, Infinity, "100", 1.5])
			expect(() => validateModelsStoreEntry("synthetic", { models: [model], validatedAt })).toThrow("validatedAt");
	});
	it("tracks factory dynamic overlays atomically and leaves static entries undated", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		let invalid = false;
		const store = new InMemoryModelsStore();
		const build = () =>
			createProvider({
				id: "synthetic",
				models: [{ ...model, id: "static" }],
				auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
				fetchModels: async () => [{ ...model, maxTokens: invalid ? 0 : 100 }],
				api: {
					stream: () => {
						throw new Error("No requests allowed");
					},
					streamSimple: () => {
						throw new Error("No requests allowed");
					},
				},
			});
		const provider = build();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		expect(provider.getModelProvenance?.("static")).toEqual({ source: "provider" });
		expect(provider.getModelProvenance?.("model")).toBeUndefined();
		await models.refresh();
		expect(provider.getModelProvenance?.("model")).toEqual({
			source: "provider",
			loadedFrom: "refresh",
			checkedAt: 1000,
		});
		expect((await store.read("synthetic"))?.validatedAt).toBe(1000);
		vi.mocked(Date.now).mockReturnValue(2000);
		invalid = true;
		expect((await models.refresh()).errors.size).toBe(1);
		expect(provider.getModelProvenance?.("model")).toEqual({
			source: "provider",
			loadedFrom: "cache",
			checkedAt: 1000,
		});
		expect(provider.getModels().find((entry) => entry.id === "model")?.maxTokens).toBe(100);
		const restored = build();
		models.setProvider(restored);
		await models.refresh({ allowNetwork: false });
		expect(restored.getModelProvenance?.("model")).toEqual({
			source: "provider",
			loadedFrom: "cache",
			checkedAt: 1000,
		});
	});
});
