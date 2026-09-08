import { setTimeout as delay } from "node:timers/promises";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { BrowserPolicy, browserAccessForUrl } from "./browser-policy.ts";

const searchParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 500 }),
	categories: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 })),
	language: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })),
	timeRange: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("month"), Type.Literal("year")])),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
});

const MAX_RESPONSE_BYTES = 2_000_000;

interface SearxngResult {
	title: string;
	url: string;
	content?: string;
	engine?: string;
	score?: number;
}

/** Creates a search tool that resolves its explicitly configured SearXNG service for each call. */
export function createSearxngTools(baseUrl: string | undefined | (() => string | undefined)): ToolDefinition[] {
	if (typeof baseUrl !== "function") {
		if (!baseUrl?.trim()) return [];
		searchEndpoint(baseUrl);
	}
	let queue = Promise.resolve();
	let pending = 0;
	let nextRequestAt = 0;
	const cooldowns = new Map<string, number>();
	const cache = new Map<string, { expires: number; record: Record<string, unknown> }>();
	return [
		{
			name: "searxng_search",
			label: "searxng_search",
			description: "Search the web through the configured private SearXNG provider.",
			promptSnippet:
				"Use flight_search for flight prices and flight_status for tracking when assigned. Use searxng_search for general discovery. If engines are blocked, do not repeat queries: use an assigned browser or a dedicated data provider. Firecrawl can read known URLs but cannot recover missing search results.",
			parameters: searchParameters,
			executionMode: "parallel",
			async execute(_toolCallId, { query, categories, language, timeRange, maxResults = 10 }, signal) {
				const configured = typeof baseUrl === "function" ? baseUrl() : baseUrl;
				if (!configured?.trim()) throw new Error("SearXNG is not configured in Settings > Connections");
				const endpoint = searchEndpoint(configured);
				const policy = new BrowserPolicy(browserAccessForUrl(endpoint.href));
				const url = new URL(endpoint);
				url.searchParams.set("q", query);
				url.searchParams.set("format", "json");
				if (categories?.length) url.searchParams.set("categories", categories.join(","));
				if (language) url.searchParams.set("language", language);
				if (timeRange) url.searchParams.set("time_range", timeRange);
				const cacheKey = url.href;
				if (pending >= 20) throw new Error("Search queue is full. Reuse existing research and retry later.");
				pending++;
				const previous = queue;
				let release = () => {};
				queue = new Promise<void>((resolve) => {
					release = resolve;
				});
				try {
					await previous;
					signal?.throwIfAborted();
					const cached = cache.get(cacheKey);
					if (cached && cached.expires > Date.now())
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(
										{
											...cached.record,
											cached: true,
											results: (cached.record.results as SearxngResult[]).slice(0, maxResults),
										},
										null,
										2,
									),
								},
							],
							details: { cached: true },
						};
					const retryAt = cooldowns.get(endpoint.href) ?? 0;
					if (retryAt > Date.now())
						throw new Error(
							`SearXNG engines are temporarily unavailable. Retry after ${new Date(retryAt).toISOString()}. Use an assigned browser or flight API; do not interpret this as no matching results.`,
						);
					await delay(Math.max(0, nextRequestAt - Date.now()), undefined, { signal });
					nextRequestAt = Date.now() + 5000;
					await policy.assertResolvedNavigation(url.href);
					const response = await fetch(url, {
						redirect: "manual",
						signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
						headers: { accept: "application/json" },
					});
					if (response.status >= 300 && response.status < 400) {
						throw new Error("SearXNG redirects are not allowed; configure its canonical base URL");
					}
					if (!response.ok) {
						if ([403, 429].includes(response.status)) cooldowns.set(endpoint.href, Date.now() + 60_000);
						throw new Error(
							`SearXNG request failed with HTTP ${response.status}. This is not an empty search result. Do not repeatedly retry; use an assigned browser or dedicated data API.`,
						);
					}
					const payload: unknown = JSON.parse(await boundedText(response));
					const record = objectRecord(payload, "SearXNG response");
					if (!Array.isArray(record.results)) throw new Error("Malformed SearXNG response: missing results array");
					const results = record.results.slice(0, 20).map(normalizeResult);
					const failures = Array.isArray(record.unresponsive_engines)
						? record.unresponsive_engines
								.filter(
									(entry): entry is string[] =>
										Array.isArray(entry) && entry.every((part) => typeof part === "string"),
								)
								.map(([engine, reason]) => ({ engine, reason }))
						: [];
					if (!results.length && failures.length) {
						cooldowns.set(endpoint.href, Date.now() + 60_000);
						throw new Error(
							`SearXNG search unavailable: ${failures.map((entry) => `${entry.engine}: ${entry.reason}`).join("; ")}. No conclusion about matching results is possible. Search is paused for 60 seconds. Use an assigned browser or dedicated flight API; do not repeat the search or ask Firecrawl to crawl nonexistent results.`,
						);
					}
					const output = {
						query,
						results,
						source: endpoint.origin,
						observedAt: new Date().toISOString(),
						status: failures.length ? "partial" : results.length ? "ok" : "empty",
						engineFailures: failures,
					};
					if (cache.size >= 100) cache.clear();
					cache.set(cacheKey, { expires: Date.now() + 300_000, record: output });
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{ ...output, results: results.slice(0, maxResults), cached: false },
									null,
									2,
								),
							},
						],
						details: undefined,
					};
				} finally {
					pending--;
					release();
				}
			},
		},
	];
}

function searchEndpoint(baseUrl: string): URL {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("SEARXNG_BASE_URL must be an absolute HTTP(S) URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("SEARXNG_BASE_URL must use HTTP or HTTPS");
	}
	if (url.username || url.password) throw new Error("SEARXNG_BASE_URL must not contain credentials");
	url.search = "";
	url.hash = "";
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
	return url;
}

async function boundedText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("SearXNG response exceeds 2 MB");
	if (!response.body) throw new Error("SearXNG response is empty");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error("SearXNG response exceeds 2 MB");
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		await reader.cancel();
	}
}

function normalizeResult(value: unknown): SearxngResult {
	const result = objectRecord(value, "SearXNG result");
	if (typeof result.title !== "string" || typeof result.url !== "string") {
		throw new Error("SearXNG result is missing a title or URL");
	}
	return {
		title: result.title,
		url: result.url,
		content: typeof result.content === "string" ? result.content : undefined,
		engine: typeof result.engine === "string" ? result.engine : undefined,
		score: typeof result.score === "number" && Number.isFinite(result.score) ? result.score : undefined,
	};
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}
