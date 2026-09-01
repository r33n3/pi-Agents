import {
	type Api,
	type Model,
	type ModelCatalogProvenance,
	type ModelsStoreEntry,
	type Provider,
	validateModelCatalog,
	validateModelsStoreEntry,
} from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	validateModelCatalog(providerId, entries);
	return [...entries];
}

function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly Model<Api>[] = [];
	let provenance: ModelCatalogProvenance | undefined;

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		getModelProvenance: (modelId) => {
			if (dynamicModels.some((model) => model.id === modelId)) return provenance && { ...provenance };
			if (!provider.getModels().some((model) => model.id === modelId)) return undefined;
			return localGeneratedAt !== undefined
				? { source: "bundled", generatedAt: localGeneratedAt }
				: provider.getModelProvenance?.(modelId);
		},
		refreshModels: async (context) => {
			let stored = context.stored;
			if (stored !== undefined) {
				try {
					validateModelsStoreEntry(provider.id, stored);
				} catch (cause) {
					context.reportWarning?.(
						new Error("Ignoring invalid cached catalog; retaining last valid models", { cause }),
					);
					stored = undefined;
				}
			}
			const restored = stored ? remoteModels(stored, localGeneratedAt) : dynamicModels;
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
						if (stored)
							provenance = {
								source: "remote-catalog",
								loadedFrom: "cache",
								generatedAt: stored.lastModified || undefined,
								checkedAt: stored.validatedAt,
								refreshIntervalMs: REMOTE_CATALOG_REFRESH_INTERVAL_MS,
							};
					},
				}))
			) {
				return;
			}
			if (!context.allowNetwork || context.signal.aborted) return;
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				stored.checkedAt <= Date.now() &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// Only revalidate when a cached body backs the validator, so a 304 can never
			// leave the overlay empty.
			const validator = stored?.models.length ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// Unchanged: dynamicModels already holds the stored overlay, so only the
			// freshness window moves.
			if (response.status === 304) {
				if (!validator || !stored) throw new Error("Model catalog returned 304 without a valid cached body");
				await context.publish({
					persist: { ...stored, checkedAt, validatedAt: checkedAt },
					update: () => {
						provenance = {
							...provenance,
							source: "remote-catalog",
							loadedFrom: "refresh",
							checkedAt,
							refreshIntervalMs: REMOTE_CATALOG_REFRESH_INTERVAL_MS,
						};
					},
				});
				return;
			}
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? {
							models: dynamicModels,
							lastModified: provenance?.generatedAt ?? 0,
							validatedAt: provenance?.checkedAt,
						}),
						checkedAt,
						etag: undefined,
					},
				});
				context.reportWarning?.(new Error("Remote model catalog is unavailable; retaining last valid models"));
				return;
			}
			if (!response.ok) {
				// Failed checks must not make stale data appear fresh or suppress a retry.
				// Preserve the body and validator for the next revalidation.
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry = {
				models: refreshed,
				checkedAt,
				validatedAt: checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
					provenance = {
						source: "remote-catalog",
						loadedFrom: "refresh",
						generatedAt: entry.lastModified || undefined,
						checkedAt,
						refreshIntervalMs: REMOTE_CATALOG_REFRESH_INTERVAL_MS,
					};
				},
			});
		},
	};
}
