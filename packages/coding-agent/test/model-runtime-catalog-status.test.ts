import {
	createProvider,
	InMemoryModelsStore,
	type ModelsStoreEntry,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function provider(id: string, refreshModels?: Provider["refreshModels"]): Provider {
	return {
		...createProvider({
			id,
			auth: {
				apiKey: {
					name: "Synthetic",
					check: async () => ({ type: "api_key", source: "test" }),
					resolve: async () => ({ auth: {} }),
				},
			},
			models: [
				{
					id: "model",
					name: "Synthetic",
					provider: id,
					api: "openai-completions",
					baseUrl: "https://example.test",
					reasoning: false,
					input: ["text"],
					contextWindow: 1000,
					maxTokens: 100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			api: {
				stream: () => {
					throw new Error("No requests allowed");
				},
				streamSimple: () => {
					throw new Error("No requests allowed");
				},
			},
		}),
		refreshModels,
	};
}

async function runtimeWith(registered: Provider): Promise<ModelRuntime> {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network allowed in catalog status tests"));
	const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	runtime.registerNativeProvider(registered);
	await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
	return runtime;
}

afterEach(() => vi.restoreAllMocks());

describe("ModelRuntime retained catalog status", () => {
	it("retains ignored cache warnings from initial creation without leaking diagnostics", async () => {
		const modelsStore = new InMemoryModelsStore();
		await modelsStore.write("openai", { models: null } as unknown as ModelsStoreEntry);
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, modelsStore });
		expect(runtime.getCatalogRefreshStatus("openai")).toEqual({
			mode: "cache-only",
			completedAt: expect.any(Number),
			failed: false,
			warning: true,
		});
		expect(runtime.getModels("openai").length).toBeGreaterThan(0);
	});
	it("retains failure and warning flags, clears them after repair, and returns detached snapshots", async () => {
		let broken = false;
		const registered = provider("catalog-status", async (context) => {
			if (broken) {
				context.reportWarning?.(new Error("private cache path", { cause: "token=secret" }));
				throw new Error("https://private.test/?token=secret");
			}
		});
		const runtime = await runtimeWith(registered);
		broken = true;
		const result = await runtime.refresh({ allowNetwork: true, providers: [registered.id] });
		expect(result.errors.get(registered.id)?.message).toContain("token=secret");
		expect(runtime.getCatalogRefreshStatus(registered.id)).toEqual({
			mode: "network-allowed",
			completedAt: expect.any(Number),
			failed: true,
			warning: true,
		});
		expect(JSON.stringify(runtime.getCatalogRefreshStatus(registered.id))).not.toMatch(/private|secret|token/);
		const detached = runtime.getCatalogRefreshStatus(registered.id)!;
		detached.warning = false;
		expect(runtime.getCatalogRefreshStatus(registered.id)?.warning).toBe(true);
		broken = false;
		await runtime.refresh({ allowNetwork: false, providers: [registered.id] });
		expect(runtime.getCatalogRefreshStatus(registered.id)).toMatchObject({
			mode: "cache-only",
			failed: false,
			warning: false,
		});
	});
	it("records network permission even when unconfigured auth skips the network phase", async () => {
		const phases: boolean[] = [];
		const registered = provider("no-access", async (context) => {
			phases.push(context.allowNetwork);
		});
		registered.auth.apiKey!.check = async () => undefined;
		registered.auth.apiKey!.resolve = async () => undefined;
		const runtime = await runtimeWith(registered);
		phases.length = 0;
		await runtime.refresh({ allowNetwork: true, providers: [registered.id] });
		expect(phases).toEqual([false]);
		expect(runtime.getCatalogRefreshStatus(registered.id)?.mode).toBe("network-allowed");
		expect(runtime.hasConfiguredAuth(registered.id)).toBe(false);
	});
	it("does not manufacture status for static or unknown providers", async () => {
		const registered = provider("static-catalog");
		const runtime = await runtimeWith(registered);
		expect(runtime.getCatalogRefreshStatus(registered.id)).toBeUndefined();
		expect(runtime.getCatalogRefreshStatus("absent")).toBeUndefined();
	});
	it("keeps the previous result during and after cancellation, including late warnings", async () => {
		const started = deferred();
		const finish = deferred();
		let block = false;
		const registered = provider("cancelled-catalog", async (context) => {
			if (!block) return;
			started.resolve();
			await finish.promise;
			context.reportWarning?.(new Error("late warning"));
		});
		const runtime = await runtimeWith(registered);
		const previous = runtime.getCatalogRefreshStatus(registered.id);
		block = true;
		const controller = new AbortController();
		const refresh = runtime.refresh({ allowNetwork: true, providers: [registered.id], signal: controller.signal });
		await started.promise;
		expect(runtime.getCatalogRefreshStatus(registered.id)).toEqual(previous);
		controller.abort();
		await expect(refresh).resolves.toMatchObject({ aborted: true });
		finish.resolve();
		await Promise.resolve();
		expect(runtime.getCatalogRefreshStatus(registered.id)).toEqual(previous);
	});
	it("does not let a superseded pass overwrite a newer result for the same provider object", async () => {
		const started = deferred();
		const finish = deferred();
		let first = true;
		let enabled = false;
		const registered = provider("overlapping-catalog", async (context) => {
			if (!enabled || !context.allowNetwork) return;
			if (first) {
				first = false;
				started.resolve();
				await finish.promise;
				context.reportWarning?.(new Error("late warning"));
			} else throw new Error("latest failure");
		});
		const runtime = await runtimeWith(registered);
		enabled = true;
		const older = runtime.refresh({ allowNetwork: true, providers: [registered.id] });
		await started.promise;
		await runtime.refresh({ allowNetwork: true, providers: [registered.id] });
		const latest = runtime.getCatalogRefreshStatus(registered.id);
		expect(latest).toMatchObject({ failed: true, warning: false });
		finish.resolve();
		await older;
		expect(runtime.getCatalogRefreshStatus(registered.id)).toEqual(latest);
	});
	it("preserves unrelated provider status on a targeted refresh", async () => {
		const first = provider("first-catalog", async (context) => {
			context.reportWarning?.(new Error("warning"));
		});
		const runtime = await runtimeWith(first);
		const second = provider("second-catalog", async () => {});
		runtime.registerNativeProvider(second);
		await runtime.refresh({ allowNetwork: false });
		const previous = runtime.getCatalogRefreshStatus(first.id);
		await runtime.refresh({ allowNetwork: true, providers: [second.id] });
		expect(runtime.getCatalogRefreshStatus(first.id)).toEqual(previous);
	});
	it("invalidates old status immediately when a provider is replaced or removed", async () => {
		const id = "replaced-catalog";
		const runtime = await runtimeWith(
			provider(id, async (context) => {
				context.reportWarning?.(new Error("old"));
			}),
		);
		expect(runtime.getCatalogRefreshStatus(id)?.warning).toBe(true);
		runtime.registerNativeProvider(provider(id, async () => {}));
		expect(runtime.getCatalogRefreshStatus(id)).toBeUndefined();
		await runtime.refresh({ allowNetwork: false, providers: [id] });
		expect(runtime.getCatalogRefreshStatus(id)?.warning).toBe(false);
		runtime.unregisterProvider(id);
		expect(runtime.getCatalogRefreshStatus(id)).toBeUndefined();
	});
	it("retains cache warnings during credential synchronization without a network request", async () => {
		let warn = false;
		const refresh = vi.fn(async (context: RefreshModelsContext) => {
			if (warn) context.reportWarning?.(new Error("cache warning"));
		});
		const registered = provider("credential-catalog", refresh);
		const runtime = await runtimeWith(registered);
		refresh.mockClear();
		warn = true;
		await runtime.setRuntimeApiKey(registered.id, "synthetic-key");
		expect(refresh.mock.calls.map(([context]) => context.allowNetwork)).toEqual([false]);
		expect(runtime.getCatalogRefreshStatus(registered.id)).toMatchObject({
			mode: "cache-only",
			failed: false,
			warning: true,
		});
	});
});
