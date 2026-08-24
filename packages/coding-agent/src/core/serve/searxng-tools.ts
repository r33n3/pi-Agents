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

/** Creates a search tool bound to one explicitly configured SearXNG service. */
export function createSearxngTools(baseUrl: string | undefined): ToolDefinition[] {
	if (!baseUrl?.trim()) return [];
	const endpoint = searchEndpoint(baseUrl);
	const policy = new BrowserPolicy(browserAccessForUrl(endpoint.href));
	return [
		{
			name: "searxng_search",
			label: "searxng_search",
			description: "Search the web through the configured private SearXNG provider.",
			promptSnippet:
				"Use searxng_search for routine web discovery. Use a scrape or browser tool only when a result page needs deeper inspection.",
			parameters: searchParameters,
			executionMode: "parallel",
			async execute(_toolCallId, { query, categories, language, timeRange, maxResults = 10 }, signal) {
				const url = new URL(endpoint);
				url.searchParams.set("q", query);
				url.searchParams.set("format", "json");
				if (categories?.length) url.searchParams.set("categories", categories.join(","));
				if (language) url.searchParams.set("language", language);
				if (timeRange) url.searchParams.set("time_range", timeRange);
				await policy.assertResolvedNavigation(url.href);
				const response = await fetch(url, {
					redirect: "manual",
					signal,
					headers: { accept: "application/json" },
				});
				if (response.status >= 300 && response.status < 400) {
					throw new Error("SearXNG redirects are not allowed; configure its canonical base URL");
				}
				if (!response.ok) throw new Error(`SearXNG request failed with HTTP ${response.status}`);
				const payload: unknown = JSON.parse(await boundedText(response));
				const record = objectRecord(payload, "SearXNG response");
				const rawResults = Array.isArray(record.results) ? record.results : [];
				const results = rawResults.slice(0, maxResults).map(normalizeResult);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ query, results, source: endpoint.origin }, null, 2),
						},
					],
					details: undefined,
				};
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
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("SearXNG response exceeds 2 MB");
	return new TextDecoder().decode(bytes);
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
