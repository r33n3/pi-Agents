import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARACTERS = 50_000;
const MAX_ERROR_CHARACTERS = 2_000;

type CredentialResolver = (name: string) => string | undefined;
type Authorization = "none" | "bearer" | "token" | "finnhub";

interface JsonRequestOptions {
	provider: string;
	apiKey?: string;
	authorization: Authorization;
	method?: "GET" | "POST";
	body?: unknown;
	signal?: AbortSignal;
}

/** Creates data-service tools whose credentials are resolved from the encrypted vault for each call. */
export function createCredentialApiTools(credential: CredentialResolver): ToolDefinition[] {
	return [
		...createFirecrawlTools(credential),
		{
			name: "currents_search_news",
			label: "Currents News Search",
			description: "Search recent news articles through Currents API.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 500 }),
				language: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			}),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const input = params as { query: string; language?: string; limit?: number };
				const url = new URL("https://api.currentsapi.services/v1/search");
				url.searchParams.set("keywords", input.query);
				url.searchParams.set("limit", String(input.limit ?? 10));
				if (input.language) url.searchParams.set("language", input.language);
				return textResult(
					"currents",
					await requestJson(url, {
						provider: "Currents",
						apiKey: requiredCredential(credential, "CURRENTS_NEW_API_KEY", "Currents"),
						authorization: "bearer",
						signal,
					}),
				);
			},
		},
		{
			name: "finnhub_quote",
			label: "Finnhub Quote",
			description: "Get the current Finnhub quote snapshot for a stock symbol.",
			parameters: Type.Object({ symbol: Type.String({ minLength: 1, maxLength: 32 }) }),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const { symbol: rawSymbol } = params as { symbol: string };
				const symbol = rawSymbol.trim().toUpperCase();
				if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) throw new Error("Invalid stock symbol");
				const url = new URL("https://finnhub.io/api/v1/quote");
				url.searchParams.set("symbol", symbol);
				return textResult(
					"finnhub",
					await requestJson(url, {
						provider: "Finnhub",
						apiKey: requiredCredential(credential, "FINNHUB_API_KEY", "Finnhub"),
						authorization: "finnhub",
						signal,
					}),
				);
			},
		},
		{
			name: "tiingo_price",
			label: "Tiingo Price",
			description: "Get the latest IEX price snapshot for a stock ticker through Tiingo.",
			parameters: Type.Object({ ticker: Type.String({ minLength: 1, maxLength: 32 }) }),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const { ticker: rawTicker } = params as { ticker: string };
				const ticker = rawTicker.trim().toUpperCase();
				if (!/^[A-Z0-9._-]{1,32}$/.test(ticker)) throw new Error("Invalid stock ticker");
				return textResult(
					"tiingo",
					await requestJson(new URL(`https://api.tiingo.com/iex/${encodeURIComponent(ticker)}`), {
						provider: "Tiingo",
						apiKey: requiredCredential(credential, "TIINGO_API_KEY", "Tiingo"),
						authorization: "token",
						signal,
					}),
				);
			},
		},
		{
			name: "apify_dataset_items",
			label: "Apify Dataset Items",
			description: "Read items from an existing Apify dataset without modifying an Actor run.",
			parameters: Type.Object({
				datasetId: Type.String({ minLength: 1, maxLength: 128 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const input = params as { datasetId: string; limit?: number; offset?: number };
				const datasetId = input.datasetId.trim();
				if (!/^[A-Za-z0-9_-]+(?:~[A-Za-z0-9_-]+)?$/.test(datasetId)) throw new Error("Invalid Apify dataset ID");
				const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`);
				url.searchParams.set("format", "json");
				url.searchParams.set("clean", "true");
				url.searchParams.set("limit", String(input.limit ?? 25));
				if (input.offset !== undefined) url.searchParams.set("offset", String(input.offset));
				return textResult(
					"apify",
					await requestJson(url, {
						provider: "Apify",
						apiKey: requiredCredential(credential, "APIFY_API_KEY", "Apify"),
						authorization: "bearer",
						signal,
					}),
				);
			},
		},
	];
}

function createFirecrawlTools(credential: CredentialResolver): ToolDefinition[] {
	const endpoint = (path: string) => new URL(path, firecrawlOrigin(credential("FIRECRAWL_BASE_URL")));
	const request = async (path: string, body: unknown, signal: AbortSignal | undefined) => {
		const baseUrl = credential("FIRECRAWL_BASE_URL")?.trim();
		return requestJson(endpoint(path), {
			provider: "Firecrawl",
			apiKey: baseUrl ? undefined : requiredCredential(credential, "FIRECRAWL_API_KEY", "Firecrawl"),
			authorization: baseUrl ? "none" : "bearer",
			method: "POST",
			body,
			signal,
		});
	};
	return [
		{
			name: "firecrawl_search",
			label: "Firecrawl Search",
			description: "Search the public web with Firecrawl and return structured results.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 500 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
			}),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const input = params as { query: string; limit?: number };
				return textResult(
					"firecrawl",
					await request("/v2/search", { query: input.query, limit: input.limit ?? 5, sources: ["web"] }, signal),
				);
			},
		},
		{
			name: "firecrawl_scrape",
			label: "Firecrawl Scrape",
			description: "Extract the main Markdown content and metadata from a public web page.",
			parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) }),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const { url } = params as { url: string };
				const target = publicUrl(url, "Firecrawl");
				return textResult(
					"firecrawl",
					await request("/v2/scrape", { url: target.href, formats: ["markdown"], onlyMainContent: true }, signal),
				);
			},
		},
		{
			name: "firecrawl_crawl",
			label: "Firecrawl Crawl",
			description: "Start a bounded Firecrawl crawl and return its job metadata.",
			parameters: Type.Object({
				url: Type.String({ minLength: 1, maxLength: 4096 }),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
			}),
			executionMode: "parallel",
			async execute(_toolCallId, params, signal) {
				const input = params as { url: string; limit?: number };
				const target = publicUrl(input.url, "Firecrawl");
				return textResult(
					"firecrawl",
					await request(
						"/v2/crawl",
						{
							url: target.href,
							limit: input.limit ?? 25,
							scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
						},
						signal,
					),
				);
			},
		},
	];
}

function requiredCredential(resolve: CredentialResolver, name: string, provider: string): string {
	const value = resolve(name)?.trim();
	if (!value) throw new Error(`${provider} is not configured in Settings > Connections`);
	return value;
}

function firecrawlOrigin(value: string | undefined): URL {
	const url = new URL(value?.trim() || "https://api.firecrawl.dev");
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw new Error("FIRECRAWL_BASE_URL must be an HTTP or HTTPS origin without credentials or a path");
	if (url.protocol !== "https:") {
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
		if (url.protocol !== "http:" || !loopback)
			throw new Error("Insecure FIRECRAWL_BASE_URL values are allowed only on loopback");
	}
	return url;
}

function publicUrl(value: string, provider: string): URL {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error(`${provider} accepts only HTTP or HTTPS URLs`);
	return url;
}

async function requestJson(url: URL, options: JsonRequestOptions): Promise<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error(`${options.provider} request timed out`)),
		REQUEST_TIMEOUT_MS,
	);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.authorization === "bearer") headers.Authorization = `Bearer ${options.apiKey}`;
	else if (options.authorization === "token") headers.Authorization = `Token ${options.apiKey}`;
	else if (options.authorization === "finnhub") headers["X-Finnhub-Token"] = options.apiKey ?? "";
	if (options.body !== undefined) headers["Content-Type"] = "application/json";
	try {
		const response = await fetch(url, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: controller.signal,
		});
		const responseText = await response.text();
		if (!response.ok) {
			const summary = responseText.slice(0, MAX_ERROR_CHARACTERS).trim();
			throw new Error(
				`${options.provider} request failed with HTTP ${response.status}${summary ? `: ${summary}` : ""}`,
			);
		}
		if (!responseText) return null;
		try {
			return JSON.parse(responseText) as unknown;
		} catch {
			return responseText;
		}
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}

function textResult(provider: string, value: unknown) {
	const text = JSON.stringify(value, null, 2) ?? String(value);
	return {
		content: [
			{
				type: "text" as const,
				text:
					text.length <= MAX_RESULT_CHARACTERS
						? text
						: `${text.slice(0, MAX_RESULT_CHARACTERS)}\n\n[Result truncated at ${MAX_RESULT_CHARACTERS} characters]`,
			},
		],
		details: { provider },
	};
}
