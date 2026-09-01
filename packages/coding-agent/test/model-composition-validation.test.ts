import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type OAuthCredentials,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelConfig, type ModelsJsonProvider } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import {
	composeModelProvider,
	type ProviderConfigInput,
	validateExtensionProvider,
} from "../src/core/provider-composer.ts";

const id = "synthetic-composition";
const model: Model<"openai-completions"> = {
	provider: id,
	id: "model",
	name: "Synthetic",
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const credential: OAuthCredentials = {
	access: "synthetic-access",
	refresh: "synthetic-refresh",
	expires: 9_000_000_000_000,
};
const directories: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function baseProvider(models: Model<Api>[] = [structuredClone(model)]): Provider {
	return {
		id,
		name: id,
		auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: {} }) } },
		getModels: () => models,
		getModelProvenance: () => ({ source: "provider", loadedFrom: "refresh", checkedAt: 1000 }),
		stream: () => {
			throw new Error("No provider requests allowed");
		},
		streamSimple: () => {
			throw new Error("No provider requests allowed");
		},
	};
}

function oauth(
	modifyModels: NonNullable<NonNullable<ProviderConfigInput["oauth"]>["modifyModels"]>,
): NonNullable<ProviderConfigInput["oauth"]> {
	return {
		name: "Synthetic OAuth",
		login: async () => {
			throw new Error("No login allowed");
		},
		refreshToken: async (value) => value,
		getApiKey: (value) => value.access,
		modifyModels,
	};
}

async function configSnapshot(config?: ModelsJsonProvider): Promise<ModelConfig> {
	const snapshot = await ModelConfig.load(undefined);
	vi.spyOn(snapshot, "getProvider").mockReturnValue(config);
	return snapshot;
}

function refreshContext(): RefreshModelsContext {
	return {
		allowNetwork: false,
		signal: new AbortController().signal,
		credential: { type: "oauth", ...credential },
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	};
}

function createConfigPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-composition-validation-"));
	directories.push(directory);
	return join(directory, "models.json");
}

describe("complete composed catalog validation", () => {
	it.each([{ maxTokens: 0 }, { contextWindow: 1.5 }, { input: [] }])(
		"rejects invalid final private overrides %j",
		async (override) => {
			const config = { modelOverrides: { model: override } };
			const snapshot = await configSnapshot(config);
			expect(() => composeModelProvider(id, baseProvider(), snapshot, undefined)).toThrow("Invalid model catalog");
			expect(() => validateExtensionProvider(id, baseProvider(), config, {})).toThrow("Invalid model catalog");
		},
	);

	it("rejects duplicate extension IDs during registration", async () => {
		const config = await configSnapshot();
		expect(() => composeModelProvider(id, baseProvider(), config, { models: [model, model] })).toThrow(
			"Duplicate model ID",
		);
	});

	it("validates after OAuth and private overrides, retaining models and provenance on failure", async () => {
		let invalid = false;
		const extension: ProviderConfigInput = {
			refreshModels: async () => [{ ...model, id: invalid ? "bad" : "good" }],
			oauth: oauth((models) => models.map((entry) => ({ ...entry, maxTokens: 200 }))),
		};
		const provider = composeModelProvider(
			id,
			baseProvider(),
			await configSnapshot({ modelOverrides: { bad: { maxTokens: 0 }, good: { maxTokens: 50 } } }),
			extension,
		);
		await provider.refreshModels?.(refreshContext());
		expect(provider.getModels()[0].maxTokens).toBe(50);
		const previous = provider.getModels();
		const provenance = provider.getModelProvenance?.("good");
		invalid = true;
		await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow("maxTokens");
		expect(provider.getModels()).toEqual(previous);
		expect(provider.getModelProvenance?.("good")).toEqual(provenance);
		expect(provider.getModelProvenance?.("bad")).toBeUndefined();
	});

	it.each(["duplicate", "provider", "limits", "throw"] as const)(
		"rejects an OAuth %s failure without mutating the baseline or credentials",
		async (failure) => {
			const baselineModels: Model<Api>[] = [structuredClone(model)];
			let fail = false;
			const modifier = vi.fn((models: Model<Api>[], token: OAuthCredentials) => {
				models[0].cost.input = 7;
				token.access = "changed";
				if (!fail) return models;
				if (failure === "duplicate") return [models[0], models[0]];
				if (failure === "provider") models[0].provider = "wrong";
				if (failure === "limits") models[0].maxTokens = 0;
				if (failure === "throw") throw new Error("Synthetic callback failure");
				return models;
			});
			const provider = composeModelProvider(id, baseProvider(baselineModels), await configSnapshot(), {
				oauth: oauth(modifier),
			});
			const context = refreshContext();
			await provider.refreshModels?.(context);
			const previous = provider.getModels();
			fail = true;
			expect(provider.getModels()).toEqual(previous);
			expect(modifier).toHaveBeenCalledTimes(1);
			await expect(provider.refreshModels?.(context)).rejects.toThrow();
			expect(provider.getModels()).toEqual(previous);
			expect(baselineModels).toEqual([model]);
			expect(context.credential).toEqual({ type: "oauth", ...credential });
		},
	);

	it("detaches published data from readers, callbacks, and extension-owned arrays", async () => {
		const definitions = [structuredClone(model)];
		let callbackInput: Model<Api>[] | undefined;
		const provider = composeModelProvider(id, baseProvider(), await configSnapshot(), {
			refreshModels: async () => definitions,
			oauth: oauth((models) => {
				callbackInput = models;
				return models;
			}),
		});
		await provider.refreshModels?.(refreshContext());
		definitions[0].maxTokens = 0;
		callbackInput![0].cost.input = 999;
		provider.getModels()[0].input.push("image");
		expect(provider.getModels()[0]).toMatchObject({ maxTokens: 100, cost: { input: 1 }, input: ["text"] });
	});

	it("keeps a previously published base update out of the composed snapshot when the final layer fails", async () => {
		let baseModels = [structuredClone(model)];
		const base = baseProvider();
		base.getModels = () => baseModels;
		base.refreshModels = async (context) => {
			await context.publish({
				update: () => {
					baseModels = [{ ...model, name: "new base" }];
				},
			});
		};
		const provider = composeModelProvider(id, base, await configSnapshot(), {
			oauth: oauth(() => {
				throw new Error("Synthetic invalid final layer");
			}),
		});
		const before = provider.getModels();
		const provenance = provider.getModelProvenance?.("model");
		await expect(provider.refreshModels?.(refreshContext())).rejects.toThrow("invalid final layer");
		expect(base.getModels()[0].name).toBe("new base");
		expect(provider.getModels()).toEqual(before);
		expect(provider.getModelProvenance?.("model")).toEqual(provenance);
	});

	it("does not publish a superseded composition", async () => {
		const provider = composeModelProvider(id, baseProvider(), await configSnapshot(), {
			refreshModels: async () => [{ ...model, name: "late" }],
		});
		const context = refreshContext();
		context.publish = async () => false;
		await provider.refreshModels?.(context);
		expect(provider.getModels()[0].name).toBe(model.name);
		expect(provider.getModelProvenance?.("model")).toEqual({
			source: "provider",
			loadedFrom: "refresh",
			checkedAt: 1000,
		});
	});
});

describe("runtime last-good composition", () => {
	it("retains accepted dynamic inputs when private overrides change and the next fetch fails", async () => {
		const path = createConfigPath();
		writeFileSync(path, JSON.stringify({ providers: {} }));
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: path,
			modelsStore: new InMemoryModelsStore(),
		});
		let fail = false;
		runtime.registerProvider(id, {
			api: model.api,
			baseUrl: model.baseUrl,
			refreshModels: async () => {
				if (fail) throw new Error("Synthetic refresh failure");
				return [model];
			},
		});
		await runtime.refresh({ allowNetwork: false, providers: [id] });
		const previous = runtime.getModelProvenance(id, model.id);
		writeFileSync(
			path,
			JSON.stringify({ providers: { [id]: { modelOverrides: { [model.id]: { maxTokens: 50 } } } } }),
		);
		fail = true;
		const result = await runtime.refresh({ allowNetwork: false, providers: [id] });
		expect(result.errors.get(id)?.message).toContain("Synthetic refresh failure");
		expect(runtime.getModel(id, model.id)?.maxTokens).toBe(50);
		expect(runtime.getModelProvenance(id, model.id)).toEqual({ ...previous, overrides: ["user-config"] });
	});

	it("isolates accepted registration data from caller and reader mutation", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const input: ProviderConfigInput = {
			api: model.api,
			baseUrl: model.baseUrl,
			apiKey: "synthetic",
			headers: { "x-synthetic": "original" },
			models: [structuredClone(model)],
		};
		runtime.registerProvider(id, input);
		input.models![0].cost.input = 99;
		input.headers!["x-synthetic"] = "changed";
		const read = runtime.getRegisteredProviderConfig(id)!;
		read.models![0].maxTokens = 0;
		read.headers!["x-synthetic"] = "reader";
		await runtime.refresh({ allowNetwork: false, providers: [id] });
		expect(runtime.getModel(id, model.id)).toMatchObject({ maxTokens: 100, cost: { input: 1 } });
		expect(await runtime.getAuth(id)).toMatchObject({ auth: { headers: { "x-synthetic": "original" } } });
	});

	it("retains a dynamic extension snapshot and reports failure across full refresh/recomposition", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		let invalid = false;
		runtime.registerProvider(id, {
			api: model.api,
			baseUrl: model.baseUrl,
			refreshModels: async () => [{ ...model, maxTokens: invalid ? 0 : 100 }],
		});
		await runtime.refresh({ allowNetwork: false });
		const provider = runtime.getProvider(id);
		const provenance = runtime.getModelProvenance(id, model.id);
		invalid = true;
		const result = await runtime.refresh({ allowNetwork: false });
		expect(result.errors.get(id)?.message).toContain("maxTokens");
		expect(runtime.getProvider(id)).toBe(provider);
		expect(runtime.getModel(id, model.id)?.maxTokens).toBe(100);
		expect(runtime.getModelProvenance(id, model.id)).toEqual(provenance);
		expect(runtime.getCatalogRefreshStatus(id)).toMatchObject({ failed: true });
	});

	it("leaves the existing registration untouched when replacement metadata is invalid", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider(id, { api: model.api, baseUrl: model.baseUrl, models: [model] });
		await runtime.refresh({ allowNetwork: false, providers: [id] });
		const registered = runtime.getRegisteredProviderConfig(id);
		expect(() => runtime.registerProvider(id, { models: [{ ...model, maxTokens: 0 }] })).toThrow("maxTokens");
		expect(runtime.getRegisteredProviderConfig(id)).toEqual(registered);
		expect(() => runtime.registerNativeProvider(baseProvider([{ ...model, provider: "wrong" }]))).toThrow(
			"provider mismatch",
		);
		expect(runtime.getRegisteredProviderConfig(id)).toEqual(registered);
		expect(runtime.getModel(id, model.id)?.maxTokens).toBe(100);
	});

	it("retains model/auth/header configuration after invalid private edits, then applies a valid repair", async () => {
		const path = createConfigPath();
		const write = (maxTokens: number, value: string) =>
			writeFileSync(
				path,
				JSON.stringify({
					providers: {
						[id]: {
							api: model.api,
							baseUrl: model.baseUrl,
							apiKey: value,
							models: [{ id: model.id }],
							modelOverrides: { [model.id]: { maxTokens, headers: { "x-synthetic": value } } },
						},
						other: {
							api: model.api,
							baseUrl: model.baseUrl,
							models: [{ id: "other", maxTokens: value === "old" ? 10 : 20 }],
						},
					},
				}),
			);
		write(100, "old");
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: path,
			modelsStore: new InMemoryModelsStore(),
		});
		const previous = runtime.getProvider(id);
		write(0, "new");
		const invalid = await runtime.refresh({ allowNetwork: false });
		expect(invalid.errors.get(id)?.message).toContain("maxTokens");
		expect(runtime.getProvider(id)).toBe(previous);
		expect(runtime.getModel(id, model.id)?.maxTokens).toBe(100);
		expect(await runtime.getAuth(runtime.getModel(id, model.id)!)).toMatchObject({
			auth: { apiKey: "old", headers: { "x-synthetic": "old" } },
		});
		expect(runtime.getModel("other", "other")?.maxTokens).toBe(20);
		expect(runtime.getError()).toContain("maxTokens");
		expect(runtime.getCatalogRefreshStatus(id)).toMatchObject({ failed: true });
		write(200, "repaired");
		expect((await runtime.refresh({ allowNetwork: false })).errors.size).toBe(0);
		expect(runtime.getModel(id, model.id)?.maxTokens).toBe(200);
		expect(await runtime.getAuth(runtime.getModel(id, model.id)!)).toMatchObject({
			auth: { apiKey: "repaired", headers: { "x-synthetic": "repaired" } },
		});
		expect(runtime.getError()).toBeUndefined();
	});

	it("retains private definitions on whole-file parse failure and removes them only after a valid empty edit", async () => {
		const path = createConfigPath();
		writeFileSync(
			path,
			JSON.stringify({
				providers: { [id]: { api: model.api, baseUrl: model.baseUrl, models: [{ id: model.id }] } },
			}),
		);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: path,
			modelsStore: new InMemoryModelsStore(),
		});
		writeFileSync(path, "{");
		const result = await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel(id, model.id)).toBeDefined();
		expect(runtime.getError()).toContain("parse models.json");
		expect(result.warnings?.has(id)).toBe(true);
		expect(runtime.getCatalogRefreshStatus(id)).toMatchObject({ warning: true });
		writeFileSync(path, JSON.stringify({ providers: {} }));
		await runtime.refresh({ allowNetwork: false });
		expect(runtime.getModel(id, model.id)).toBeUndefined();
		expect(runtime.getError()).toBeUndefined();
	});
});
