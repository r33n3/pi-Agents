import { createProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_MODELS } from "../../ai/src/providers/anthropic.models.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import * as configValues from "../src/core/resolve-config-value.ts";
import { modelSettingsError } from "../src/core/serve/browser/model-settings.ts";
import { CurrentSessionService } from "../src/core/serve/current-session-service.ts";
import { createHarness } from "./suite/harness.ts";

const model = ANTHROPIC_MODELS["claude-opus-5"];
const fast = { reasoningEffort: "low", processingTier: "fast" };

afterEach(() => {
	vi.restoreAllMocks();
});

describe("connection-aware model runtime", () => {
	it("keeps browser choices and session validation aligned across credential changes", async () => {
		const harness = await createHarness();
		try {
			const runtime = harness.session.modelRuntime;
			const service = new CurrentSessionService(harness.session);
			harness.session.agent.state.model = model;
			await runtime.setRuntimeApiKey("anthropic", "synthetic-api-key");
			harness.session.setModelControls(fast);
			const selection = { model, thinkingLevel: "high" as const, modelControls: fast };
			expect(modelSettingsError(selection, await service.listModels())).toBeUndefined();
			const before = harness.sessionManager.getEntries();
			await runtime.setRuntimeApiKey("anthropic", "synthetic-sk-ant-oat-token");
			const models = await service.listModels();
			expect(models.find((entry) => entry.provider === model.provider && entry.id === model.id)?.controls).toEqual(
				{},
			);
			expect(modelSettingsError(selection, models)).toContain("not supported");
			expect(() => harness.session.setModelControls(fast)).toThrow("not verified");
			expect(harness.session.modelControls).toEqual(fast);
			expect(harness.sessionManager.getEntries()).toEqual(before);
			expect(JSON.stringify(models)).not.toMatch(/synthetic-api-key|synthetic-sk-ant-oat-token|api\.anthropic\.com/);
			harness.session.setModelControls({});
			await runtime.setRuntimeApiKey("anthropic", "synthetic-restored-key");
			expect(modelSettingsError(selection, await service.listModels())).toBeUndefined();
			harness.session.setModelControls(fast);
		} finally {
			harness.cleanup();
		}
	});

	it("inspects expired OAuth without refreshing tokens or deriving request auth", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({
			type: "oauth",
			access: "synthetic",
			refresh: "synthetic",
			expires: 0,
		}));
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
		const oauth = runtime.getProvider("anthropic")!.auth.oauth!;
		const refresh = vi.spyOn(oauth, "refresh").mockRejectedValue(new Error("No refresh permitted"));
		const toAuth = vi.spyOn(oauth, "toAuth").mockRejectedValue(new Error("No derivation permitted"));
		await runtime.getAvailable();
		expect(runtime.getModelControlCapabilities(model)).toEqual({});
		expect(() => runtime.validateModelControls(model, fast)).toThrow("not verified");
		expect(() => runtime.validateModelControls(model, {})).not.toThrow();
		expect(refresh).not.toHaveBeenCalled();
		expect(toAuth).not.toHaveBeenCalled();
	});

	it.each([
		{ headers: { AUTHORIZATION: "!synthetic-never-execute" } },
		{ authHeader: true },
		{ models: [{ ...model, headers: { authorization: "!synthetic-never-execute" } }] },
	])("restricts configured bearer routing without resolving header commands: %j", async (config) => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerProvider("anthropic", { apiKey: "synthetic-key", ...config });
		const resolveHeaders = vi.spyOn(configValues, "resolveHeadersOrThrow").mockImplementation(() => {
			throw new Error("Do not resolve headers during inspection");
		});
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: false });
		expect(runtime.getModelControlCapabilities(runtime.getModel("anthropic", model.id)!)).toEqual({});
		expect(resolveHeaders).not.toHaveBeenCalled();
	});

	it("does not execute configured key commands to populate controls", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const resolveKey = vi.spyOn(configValues, "resolveConfigValueOrThrow").mockImplementation(() => {
			throw new Error("Do not resolve key commands during inspection");
		});
		runtime.registerProvider("anthropic", { apiKey: "!synthetic-never-execute" });
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: false });
		expect((await runtime.checkAuth("anthropic"))?.connection).toEqual({ type: "unknown" });
		expect(runtime.getModelControlCapabilities(model)).toEqual({});
		expect(resolveKey).not.toHaveBeenCalled();
	});

	it("invalidates checked support when a provider is replaced and requires explicit transport facts", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		await runtime.setRuntimeApiKey("anthropic", "synthetic-key");
		expect(runtime.getModelControlCapabilities(model).processingTier).toBeDefined();
		const resolve = vi.fn(async () => ({
			auth: { apiKey: "synthetic-key", headers: { Authorization: "Bearer synthetic" } },
		}));
		const dispatch = vi.fn(() => {
			throw new Error("No provider calls permitted");
		});
		runtime.registerNativeProvider(
			createProvider({
				id: "anthropic",
				models: [model],
				auth: { apiKey: { name: "synthetic", check: async () => ({ type: "api_key" }), resolve } },
				api: { stream: dispatch, streamSimple: dispatch },
			}),
		);
		expect(runtime.getModelControlCapabilities(model)).toEqual({});
		await runtime.refresh({ providers: ["anthropic"], allowNetwork: false });
		expect(runtime.getModelControlCapabilities(model)).toEqual({});
		expect(resolve).not.toHaveBeenCalled();
	});

	it.each(["stream", "streamSimple"] as const)(
		"%s checks final request routing and permits explicit key overrides",
		async (method) => {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("anthropic", async () => ({
				type: "oauth",
				access: "synthetic-without-prefix",
				refresh: "synthetic",
				expires: Date.now() + 3_600_000,
			}));
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
			const dispatch = vi.fn(() => {
				throw new Error("synthetic dispatch reached");
			});
			runtime.registerProvider("anthropic", {
				api: "anthropic-messages",
				streamSimple: dispatch,
				oauth: {
					name: "Synthetic OAuth",
					login: async () => {
						throw new Error("No login permitted");
					},
					refreshToken: async () => {
						throw new Error("No refresh permitted");
					},
					getApiKey: (credential) => credential.access,
				},
			});
			await runtime.refresh({ providers: ["anthropic"], allowNetwork: false });
			const oauth = await runtime[method](model, { messages: [] }, { controls: fast }).result();
			expect(oauth.errorMessage).toContain("not verified");
			expect(dispatch).not.toHaveBeenCalled();
			const key = await runtime[method](
				model,
				{ messages: [] },
				{ controls: fast, apiKey: "synthetic-key" },
			).result();
			expect(key.errorMessage).toBe("synthetic dispatch reached");
			expect(dispatch).toHaveBeenCalledOnce();
			const bearer = await runtime[method](
				model,
				{ messages: [] },
				{
					controls: fast,
					apiKey: "synthetic-key",
					transformHeaders: () => ({ authorization: "Bearer synthetic" }),
				},
			).result();
			expect(bearer.errorMessage).toContain("not verified");
			expect(dispatch).toHaveBeenCalledOnce();
		},
	);
});
