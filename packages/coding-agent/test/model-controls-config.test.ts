import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, getModelControlCapabilities, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const evidence = { kind: "user-override" as const, reference: "synthetic fixture", checkedAt: "2026-08-31" };
const controls = { reasoningEffort: { values: ["high"], default: "high", evidence } };
const definition = {
	id: "private-model",
	api: "openai-responses",
	baseUrl: "https://private.example.test/v1",
	controls,
	reasoning: true,
};

describe("private model control configuration", () => {
	let directory: string;
	let path: string;
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "pi-model-controls-"));
		path = join(directory, "models.json");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("preserves explicit controls and evidence through custom-model composition", async () => {
		await writeFile(path, JSON.stringify({ providers: { private: { models: [definition] } } }));
		const config = await ModelConfig.load(path);
		expect(config.getError()).toBeUndefined();
		const provider = composeModelProvider("private", undefined, config, undefined);
		const model = provider.getModels()[0];
		expect(model.controls).toEqual(controls);
		expect(getModelControlCapabilities(model)).toEqual(controls);
		expect(Object.isFrozen(config.getProvider("private")?.models?.[0].controls)).toBe(true);
	});

	it("applies user overrides last and allows an empty override to disable native controls", async () => {
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					private: {
						models: [definition],
						modelOverrides: { "private-model": { controls: {} } },
					},
				},
			}),
		);
		const config = await ModelConfig.load(path);
		const provider = composeModelProvider("private", undefined, config, {
			models: [
				{
					...definition,
					name: "Synthetic extension",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10000,
					maxTokens: 1000,
				},
			],
		});
		expect(getModelControlCapabilities(provider.getModels()[0])).toEqual({});
	});

	it.each([
		{ reasoningEffort: { values: ["low"], default: "high", evidence } },
		{ reasoningBudget: { minimum: 200, maximum: 100, evidence } },
		{ reasoningEffort: { values: ["low"], evidence: { ...evidence, checkedAt: "not a date" } } },
	])("rejects invalid capability semantics for definitions and overrides: %j", async (invalid) => {
		for (const provider of [
			{ models: [{ ...definition, controls: invalid }] },
			{ modelOverrides: { "private-model": { controls: invalid } } },
		]) {
			await writeFile(path, JSON.stringify({ providers: { private: provider } }));
			const config = await ModelConfig.load(path);
			expect(config.getError()).toContain("Invalid model controls");
			expect(config.getProviderIds()).toEqual([]);
		}
	});

	it("preflights extension dispatch without silently dropping controls", async () => {
		const config = await ModelConfig.load(undefined);
		const dispatch = vi.fn(() => {
			throw new Error("fixture dispatched");
		});
		const provider = composeModelProvider("private", undefined, config, {
			api: "unimplemented-controls-api",
			streamSimple: dispatch,
			models: [
				{
					...definition,
					api: "unimplemented-controls-api",
					name: "Synthetic extension",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10000,
					maxTokens: 1000,
				},
			],
		});
		const result = await provider
			.streamSimple(
				provider.getModels()[0],
				{ messages: [] },
				{
					controls: { reasoningEffort: "high" },
				},
			)
			.result();
		expect(result.errorMessage).toContain("reasoningEffort is not verified");
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe("ModelRuntime native control preflight", () => {
	it.each(["stream", "streamSimple"] as const)("%s validates before credential resolution", async (method) => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const auth = vi.spyOn(runtime, "getAuth");
		const model = runtime.getModel("openai", "gpt-5.6-sol")!;
		const result = await runtime[method](
			model,
			{ messages: [] },
			{ controls: { reasoningEffort: "ultra" } },
		).result();
		expect(result.errorMessage).toContain("Unsupported reasoningEffort");
		expect(auth).not.toHaveBeenCalled();
	});

	it.each(["stream", "streamSimple"] as const)(
		"%s validates auth endpoint changes before dispatch",
		async (method) => {
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				refreshOnCreate: false,
			});
			vi.spyOn(runtime, "getAuth").mockResolvedValue({
				auth: { apiKey: "synthetic", baseUrl: "https://private.example.test/v1" },
				source: "synthetic",
			});
			const model: Model<Api> = runtime.getModel("openai", "gpt-5.6-sol")!;
			const dispatch = vi.spyOn(runtime.getProvider(model.provider)!, method);
			const result = await runtime[method](
				model,
				{ messages: [] },
				{ controls: { processingTier: "fast" } },
			).result();
			expect(result.errorMessage).toContain("processingTier is not verified");
			expect(dispatch).not.toHaveBeenCalled();
		},
	);
});
