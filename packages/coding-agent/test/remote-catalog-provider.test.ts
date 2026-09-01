import {
	createModels,
	createProvider,
	InMemoryModelsStore,
	type Model,
	type ModelsPublication,
	type ModelsStoreEntry,
	type Provider,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { withRemoteCatalog } from "../src/core/remote-catalog-provider.ts";

const neverAbortedSignal = new AbortController().signal;

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function testProvider(localGeneratedAt?: number) {
	return withRemoteCatalog(
		createProvider({
			id: "test-provider",
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			models: [model("static")],
			api: {
				stream: () => {
					throw new Error("not used");
				},
				streamSimple: () => {
					throw new Error("not used");
				},
			},
		}),
		"https://pi.dev",
		localGeneratedAt,
	);
}

async function refreshProvider(
	provider: Provider,
	store: InMemoryModelsStore,
	overrides: Partial<Pick<RefreshModelsContext, "allowNetwork" | "force" | "signal" | "reportWarning">> = {},
): Promise<void> {
	const publish = async (publication: ModelsPublication): Promise<boolean> => {
		if (publication.persist === null) await store.delete(provider.id);
		else if (publication.persist !== undefined) await store.write(provider.id, publication.persist);
		publication.update?.();
		return true;
	};
	await provider.refreshModels?.({
		credential: { type: "api_key" },
		stored: await store.read(provider.id),
		publish,
		allowNetwork: overrides.allowNetwork ?? true,
		force: overrides.force,
		signal: overrides.signal ?? neverAbortedSignal,
		reportWarning: overrides.reportWarning,
	});
}

afterEach(() => vi.restoreAllMocks());

describe("remote catalog provider", () => {
	it.each([404, 501])("keeps last-good body age across unavailable status %s and offline restart", async (status) => {
		const generatedAt = Date.parse("2026-08-01T00:00:00Z");
		const modifiedAt = generatedAt + 1000;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify([model("cached")]), {
					headers: { "last-modified": new Date(modifiedAt).toUTCString(), etag: '"good"' },
				}),
			)
			.mockResolvedValue(new Response(null, { status }));
		vi.spyOn(Date, "now").mockReturnValue(generatedAt + 5000);
		const provider = testProvider(generatedAt);
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const original = await store.read(provider.id);
		expect(provider.getModelProvenance?.("cached")).toMatchObject({
			source: "remote-catalog",
			loadedFrom: "refresh",
			generatedAt: modifiedAt,
			checkedAt: generatedAt + 5000,
		});
		expect(provider.getModelProvenance?.("static")).toEqual({ source: "bundled", generatedAt });
		vi.mocked(Date.now).mockReturnValue(generatedAt + 10000);
		const reportWarning = vi.fn();
		await refreshProvider(provider, store, { force: true, reportWarning });
		expect(reportWarning).toHaveBeenCalledOnce();
		expect(await store.read(provider.id)).toMatchObject({
			models: original?.models,
			lastModified: modifiedAt,
			validatedAt: generatedAt + 5000,
			checkedAt: generatedAt + 10000,
		});
		const offline = testProvider(generatedAt);
		await refreshProvider(offline, store, { allowNetwork: false });
		expect(offline.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		expect(offline.getModelProvenance?.("cached")).toMatchObject({
			source: "remote-catalog",
			loadedFrom: "cache",
			generatedAt: modifiedAt,
			checkedAt: generatedAt + 5000,
		});
		await refreshProvider(offline, store);
		expect(fetch).toHaveBeenCalledTimes(2); // An unavailable-endpoint check still suppresses immediate retries.
	});
	it("retains last-good in-memory models when an invalid cache cannot be repaired from the endpoint", async () => {
		const generatedAt = Date.parse("2026-08-01T00:00:00Z");
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify([model("cached")]), {
					headers: { "last-modified": new Date(generatedAt + 1000).toUTCString() },
				}),
			)
			.mockResolvedValue(new Response(null, { status: 404 }));
		const provider = testProvider(generatedAt);
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const original = provider.getModelProvenance?.("cached");
		await store.write(provider.id, { models: null } as unknown as ModelsStoreEntry);
		await refreshProvider(provider, store, { force: true });
		const offline = testProvider(generatedAt);
		await refreshProvider(offline, store, { allowNetwork: false });
		expect(offline.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		expect(offline.getModelProvenance?.("cached")?.checkedAt).toBe(original?.checkedAt);
	});
	it("does not infer a successful body check from a legacy cache check timestamp", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("old")], checkedAt: Date.now(), lastModified: 1 });
		await refreshProvider(provider, store, { allowNetwork: false });
		expect(provider.getModelProvenance?.("old")?.checkedAt).toBeUndefined();
	});
	it("ignores invalid cached bodies and validators, retains prior models, and repairs on refresh", async () => {
		const responses = [
			new Response(JSON.stringify([model("last-good")])),
			new Response(JSON.stringify([model("repaired")]), { headers: { etag: '"repaired"' } }),
		];
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const invalid = {
			models: [{ ...model("bad"), contextWindow: 0 }],
			checkedAt: Date.now(),
			lastModified: 1,
			etag: '"bad"',
		};
		await store.write(provider.id, invalid);
		const reportWarning = vi.fn();
		await refreshProvider(provider, store, { allowNetwork: false, reportWarning });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "last-good"]);
		expect(await store.read(provider.id)).toEqual(invalid);
		expect(reportWarning).toHaveBeenCalledTimes(1);
		await refreshProvider(provider, store, { reportWarning });
		expect(fetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "repaired"]);
		expect((await store.read(provider.id))?.etag).toBe('"repaired"');
	});
	it("allows the Models offline phase to report corrupt cache and continue to online repair", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: null } as unknown as ModelsStoreEntry);
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("repaired")])));
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);
		const result = await models.refresh();
		expect(result.errors.size).toBe(0);
		expect(result.warnings?.size).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "repaired"]);
	});
	it("does not accept 304 without a valid cached body and sent validator", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await expect(refreshProvider(provider, store)).rejects.toThrow("304 without a valid cached body");
		expect(await store.read(provider.id)).toBeUndefined();
	});
	it("does not postpone refresh because a cached check timestamp is in the future", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await store.write(provider.id, { models: [model("cached")], checkedAt: Date.now() + 60000, lastModified: 1 });
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([model("fresh")])));
		await refreshProvider(provider, store);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "fresh"]);
	});
	it("does not advance freshness metadata after a failed network check", async () => {
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const stored = { models: [model("cached")], checkedAt: 1, lastModified: 1, etag: '"last-good"' };
		await store.write(provider.id, stored);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
		await expect(refreshProvider(provider, store)).rejects.toThrow("403");
		expect(await store.read(provider.id)).toEqual(stored);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
	});
	it.each([
		["missing fields", [{ id: "incomplete" }]],
		["mixed valid and invalid entries", [model("new-valid"), { ...model("invalid"), maxTokens: 0 }]],
		["invalid pricing", [{ ...model("invalid"), cost: { input: "1", output: 0, cacheRead: 0, cacheWrite: 0 } }]],
		["unknown thinking level", [{ ...model("invalid"), thinkingLevelMap: { ultra: "ultra" } }]],
		["provider mismatch", [{ ...model("invalid"), provider: "another-provider" }]],
		["duplicate IDs", [model("duplicate"), model("duplicate")]],
		["malformed wrapper", { models: "not-an-array" }],
	] as const)("rejects %s atomically without replacing the last-known-good catalog", async (_label, invalid) => {
		const responses = [
			new Response(JSON.stringify([model("cached")]), { headers: { etag: '"valid"' } }),
			new Response(JSON.stringify(invalid), { headers: { etag: '"invalid"' } }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		const saved = await store.read(provider.id);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow();
		expect(await store.read(provider.id)).toEqual(saved);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "cached"]);
		const offline = testProvider();
		await refreshProvider(offline, store, { allowNetwork: false });
		expect(offline.getModels()).toEqual(provider.getModels());
	});

	it("accepts the supported array wrapper and preserves model-specific options", async () => {
		const source = { ...model("wrapped"), reasoning: true, thinkingLevelMap: { off: null, high: "max" } };
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ models: [source] })));
		const provider = testProvider();
		await refreshProvider(provider, new InMemoryModelsStore());
		expect(provider.getModels()[1]).toEqual(source);
	});

	it("parses keyed catalogs, sends version headers, observes the refresh TTL, and supports forced refreshes", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			async () =>
				new Response(JSON.stringify({ dynamic: model("dynamic") }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		await refreshProvider(provider, store);
		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
			"User-Agent": expect.stringContaining(`pi/${VERSION}`),
		});
	});

	it("prefers the newer of the generated and remote catalogs", async () => {
		const localGeneratedAt = Date.parse("2026-07-23T10:00:00.000Z");
		const newerHeader = new Date(localGeneratedAt + 60_000).toUTCString();
		const responses = [
			new Response(JSON.stringify({ old: model("old") }), {
				headers: { "last-modified": new Date(localGeneratedAt - 60_000).toUTCString() },
			}),
			new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "last-modified": newerHeader },
			}),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider(localGeneratedAt);
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);

		await refreshProvider(provider, store, { force: true });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect(await store.read(provider.id)).toMatchObject({ lastModified: Date.parse(newerHeader) });
	});

	it("revalidates a stored catalog with its etag and keeps the overlay on 304", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		expect(fetchSpy.mock.calls[0]?.[1]?.headers).not.toHaveProperty("if-none-match");
		expect(await store.read(provider.id)).toMatchObject({ etag: '"catalog-1"' });

		const checkedAt = (await store.read(provider.id))?.checkedAt;
		await refreshProvider(provider, store, { force: true });

		expect(fetchSpy.mock.calls[1]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
		const stored = await store.read(provider.id);
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.checkedAt).toBeGreaterThanOrEqual(checkedAt ?? 0);
		expect(stored?.validatedAt).toBe(stored?.checkedAt);
		expect(provider.getModelProvenance?.("dynamic")).toMatchObject({
			source: "remote-catalog",
			loadedFrom: "refresh",
			checkedAt: stored?.validatedAt,
		});
	});

	it("drops a stale etag when the overlay becomes unavailable", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("not implemented", { status: 501 }),
		];
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await refreshProvider(provider, store, { force: true });

		expect((await store.read(provider.id))?.etag).toBeUndefined();
	});

	it("keeps the etag and overlay after a transient failure", async () => {
		const responses = [
			new Response(JSON.stringify({ dynamic: model("dynamic") }), {
				headers: { "content-type": "application/json", etag: '"catalog-1"' },
			}),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response("rate limited", { status: 429 }),
			new Response(null, { status: 304, headers: { etag: '"catalog-1"' } }),
		];
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => responses.shift() as Response);
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await refreshProvider(provider, store);
		await expect(refreshProvider(provider, store, { force: true })).rejects.toThrow(/429/);

		const stored = await store.read(provider.id);
		expect(stored?.etag).toBe('"catalog-1"');
		expect(stored?.models.map((entry) => entry.id)).toEqual(["dynamic"]);

		await refreshProvider(provider, store, { force: true });
		expect(fetchSpy.mock.calls[4]?.[1]?.headers).toMatchObject({ "if-none-match": '"catalog-1"' });
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "dynamic"]);
	});

	it("lets a newer catalog request bypass a stalled older request without stale publication", async () => {
		let calls = 0;
		let markFirstStarted: (() => void) | undefined;
		let finishFirst: ((response: Response) => void) | undefined;
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve;
		});
		const firstResponse = new Promise<Response>((resolve) => {
			finishFirst = resolve;
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			calls++;
			if (calls === 1) {
				markFirstStarted?.();
				return firstResponse;
			}
			return new Response(JSON.stringify({ newer: model("newer") }), {
				headers: { "content-type": "application/json" },
			});
		});
		const provider = testProvider();
		const store = new InMemoryModelsStore();
		const models = createModels({ modelsStore: store });
		models.setProvider(provider);

		const first = models.refresh({ providers: [provider.id], force: true });
		await firstStarted;
		const second = models.refresh({ providers: [provider.id], force: true });
		await second;
		await first;
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		const latestProvenance = provider.getModelProvenance?.("newer");

		finishFirst?.(
			new Response(JSON.stringify({ older: model("older") }), {
				headers: { "content-type": "application/json" },
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static", "newer"]);
		expect((await store.read(provider.id))?.models.map((entry) => entry.id)).toEqual(["newer"]);
		expect(provider.getModelProvenance?.("newer")).toEqual(latestProvenance);
		expect(provider.getModelProvenance?.("older")).toBeUndefined();
	});

	it("treats unimplemented pi.dev catalog routes as an unavailable overlay", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not implemented", { status: 501 }));
		const provider = testProvider();
		const store = new InMemoryModelsStore();

		await expect(refreshProvider(provider, store)).resolves.toBeUndefined();
		expect(provider.getModels().map((entry) => entry.id)).toEqual(["static"]);
		expect(await store.read(provider.id)).toMatchObject({ models: [], checkedAt: expect.any(Number) });
	});
});
