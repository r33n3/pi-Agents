import { describe, expect, it, vi } from "vitest";
import { getModelAuthConnection } from "../src/auth/connection.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { ModelAuth, ModelAuthConnection } from "../src/auth/types.ts";
import { getModelControlCapabilities, validateModelControls } from "../src/model-controls.ts";
import { createModels, createProvider } from "../src/models.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";

const model = ANTHROPIC_MODELS["claude-opus-5"];

describe("connection-aware native controls", () => {
	it.each([
		[{ apiKey: "synthetic-key" }, "api_key"],
		[{ apiKey: "synthetic-sk-ant-oat-token" }, "oauth"],
		[{ apiKey: "synthetic-key", headers: { AUTHORIZATION: "Bearer synthetic" } }, "bearer"],
		[{ apiKey: "synthetic-key", headers: { authorization: null } }, "api_key"],
		[{ headers: { "x-api-key": "synthetic-key" } }, "api_key"],
		[{}, "unknown"],
	] satisfies [ModelAuth, ModelAuthConnection["type"]][])(
		"classifies auth without returning credentials: %j",
		(auth, type) => {
			expect(getModelAuthConnection("anthropic", auth)).toEqual({ type });
		},
	);
	it("does not confuse OpenAI API bearer headers with Anthropic's different transport", () => {
		expect(
			getModelAuthConnection("openai", { apiKey: "synthetic", headers: { Authorization: "Bearer synthetic" } }),
		).toEqual({ type: "api_key" });
	});
	it.each([model, OPENAI_MODELS["gpt-5.6-sol"]])(
		"keeps catalog support separate from checked connections: $id",
		(source) => {
			expect(getModelControlCapabilities(source).processingTier).toBeDefined();
			for (const type of ["oauth", "bearer", "unknown"] as const) {
				expect(getModelControlCapabilities(source, { type })).toEqual({});
				expect(() => validateModelControls(source, { processingTier: "fast" }, { type })).toThrow("not verified");
				expect(() => validateModelControls(source, {}, { type })).not.toThrow();
			}
			expect(getModelControlCapabilities(source, { type: "api_key" }).processingTier).toBeDefined();
			expect(
				getModelControlCapabilities(source, { type: "api_key", baseUrl: "https://private.example.test" }),
			).toEqual({});
		},
	);
	it("preserves explicit private capabilities without replacing their evidence", () => {
		const privateModel = {
			...model,
			controls: {
				processingTier: {
					values: ["fast"],
					evidence: { kind: "user-override" as const, reference: "synthetic", checkedAt: "2026-08-31" },
				},
			},
		};
		for (const type of ["api_key", "oauth", "bearer", "unknown"] as const) {
			expect(getModelControlCapabilities(privateModel, { type }).processingTier).toEqual(
				privateModel.controls.processingTier,
			);
			expect(() => validateModelControls(privateModel, { processingTier: "fast" }, { type })).not.toThrow();
		}
	});
	it.each(["stream", "streamSimple"] as const)(
		"%s rejects resolved OAuth before dispatch, independent of token spelling",
		async (method) => {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("anthropic", async () => ({
				type: "oauth",
				access: "synthetic-without-prefix",
				refresh: "synthetic",
				expires: Date.now() + 3_600_000,
			}));
			const refresh = vi.fn(async () => {
				throw new Error("No refresh expected");
			});
			const dispatch = vi.fn(() => {
				throw new Error("synthetic dispatch");
			});
			const models = createModels({
				credentials,
				authContext: { env: async () => undefined, fileExists: async () => false },
			});
			models.setProvider(
				createProvider({
					id: "anthropic",
					models: [model],
					auth: {
						oauth: {
							name: "synthetic",
							login: async () => {
								throw new Error("No login expected");
							},
							refresh,
							toAuth: async (credential) => ({ apiKey: credential.access }),
						},
					},
					api: { stream: dispatch, streamSimple: dispatch },
				}),
			);
			expect((await models.checkAuth("anthropic"))?.connection).toEqual({ type: "oauth" });
			const result = await models[method](
				model,
				{ messages: [] },
				{ controls: { processingTier: "fast" } },
			).result();
			expect(result.errorMessage).toContain("not verified");
			expect(refresh).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		},
	);
	it.each(["stream", "streamSimple"] as const)("%s checks final transformed authorization headers", async (method) => {
		const dispatch = vi.fn(() => {
			throw new Error("synthetic dispatch");
		});
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(
			createProvider({
				id: "anthropic",
				models: [model],
				auth: { apiKey: { name: "synthetic", resolve: async () => ({ auth: { apiKey: "synthetic" } }) } },
				api: { stream: dispatch, streamSimple: dispatch },
			}),
		);
		expect((await models.checkAuth("anthropic"))?.connection).toEqual({ type: "api_key" });
		const result = await models[method](
			model,
			{ messages: [] },
			{ controls: { processingTier: "fast" }, transformHeaders: () => ({ AUTHORIZATION: "Bearer synthetic" }) },
		).result();
		expect(result.errorMessage).toContain("not verified");
		expect(dispatch).not.toHaveBeenCalled();
	});
});
