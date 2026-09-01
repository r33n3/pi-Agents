import { describe, expect, it, vi } from "vitest";
import type { ModelControls } from "../src/model-controls.ts";
import { createModels, createProvider } from "../src/models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";

const model = OPENAI_MODELS["gpt-5.6-sol"];

describe("model controls request preflight", () => {
	it.each(["stream", "streamSimple"] as const)("%s rejects invalid controls before auth", async (method) => {
		const resolve = vi.fn(async () => ({ auth: { apiKey: "fixture" }, source: "fixture" }));
		const dispatch = vi.fn(() => {
			throw new Error("fixture dispatched");
		});
		const provider = createProvider({
			id: model.provider,
			models: [model],
			auth: { apiKey: { name: "fixture", resolve } },
			api: { stream: dispatch, streamSimple: dispatch },
		});
		const models = createModels();
		models.setProvider(provider);
		for (const controls of [{ reasoningEffort: "ultra" }, null] as ModelControls[]) {
			const result = await models[method](model, { messages: [] }, { controls }).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).not.toContain("fixture dispatched");
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each(["stream", "streamSimple"] as const)("%s revalidates after an auth endpoint override", async (method) => {
		const dispatch = vi.fn(() => {
			throw new Error("fixture dispatched");
		});
		const models = createModels();
		models.setProvider(
			createProvider({
				id: model.provider,
				models: [model],
				auth: {
					apiKey: {
						name: "fixture",
						resolve: async () => ({
							auth: { apiKey: "fixture", baseUrl: "https://custom.example.test/v1" },
							source: "fixture",
						}),
					},
				},
				api: { stream: dispatch, streamSimple: dispatch },
			}),
		);
		const result = await models[method](model, { messages: [] }, { controls: { processingTier: "fast" } }).result();
		expect(result.errorMessage).toContain("processingTier is not verified");
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each(["stream", "streamSimple"] as const)(
		"direct provider %s rejects unsupported adapter controls",
		async (method) => {
			const custom = { ...model, api: "custom-api", compat: undefined };
			const dispatch = vi.fn(() => {
				throw new Error("fixture dispatched");
			});
			const provider = createProvider({
				id: model.provider,
				models: [custom],
				auth: { apiKey: { name: "fixture", resolve: async () => undefined } },
				api: { stream: dispatch, streamSimple: dispatch },
			});
			const result = await provider[method](
				custom,
				{ messages: [] },
				{ controls: { reasoningEffort: "high" } },
			).result();
			expect(result.errorMessage).toContain("reasoningEffort is not verified");
			expect(dispatch).not.toHaveBeenCalled();
		},
	);
});
