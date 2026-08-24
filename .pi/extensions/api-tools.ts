import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARACTERS = 50_000;
const MAX_ERROR_CHARACTERS = 2_000;

type JsonRequestOptions = {
	provider: string;
	apiKey?: string;
	authorization: "none" | "bearer" | "token" | "finnhub";
	method?: "GET" | "POST";
	body?: unknown;
	signal?: AbortSignal;
};

function readLocalToolEnvironment(): ReadonlyMap<string, string> {
	if (process.env.PI_DISABLE_LOCAL_TOOL_ENV === "1") return new Map();
	let contents: string;
	try {
		contents = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return new Map();
		throw error;
	}

	const values = new Map<string, string>();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match) continue;
		let value = match[2];
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		values.set(match[1], value);
	}
	return values;
}

const localToolEnvironment = readLocalToolEnvironment();

function toolCredential(name: string): string | undefined {
	return process.env[name]?.trim() || localToolEnvironment.get(name)?.trim() || undefined;
}

function formatJson(value: unknown): string {
	const text = JSON.stringify(value, null, 2) ?? String(value);
	if (text.length <= MAX_RESULT_CHARACTERS) return text;
	return `${text.slice(0, MAX_RESULT_CHARACTERS)}\n\n[Result truncated at ${MAX_RESULT_CHARACTERS} characters]`;
}

async function requestJson(url: URL, options: JsonRequestOptions): Promise<unknown> {
	const controller = new AbortController();
	const abort = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) {
		abort();
	} else {
		options.signal?.addEventListener("abort", abort, { once: true });
	}
	const timeout = setTimeout(() => controller.abort(new Error(`${options.provider} request timed out`)), REQUEST_TIMEOUT_MS);

	const authorization =
		options.authorization === "bearer"
			? `Bearer ${options.apiKey}`
			: options.authorization === "token"
				? `Token ${options.apiKey}`
				: undefined;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (authorization) headers.Authorization = authorization;
	if (options.authorization === "finnhub") headers["X-Finnhub-Token"] = options.apiKey;
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
	return {
		content: [{ type: "text" as const, text: formatJson(value) }],
		details: { provider },
	};
}

export default function (pi: ExtensionAPI) {
	const firecrawlApiKey = toolCredential("FIRECRAWL_API_KEY");
	const firecrawlBaseUrlValue = toolCredential("FIRECRAWL_BASE_URL");
	if (firecrawlApiKey || firecrawlBaseUrlValue) {
		const firecrawlBaseUrl = new URL(firecrawlBaseUrlValue ?? "https://api.firecrawl.dev");
		if (
			firecrawlBaseUrl.username ||
			firecrawlBaseUrl.password ||
			firecrawlBaseUrl.pathname !== "/" ||
			firecrawlBaseUrl.search ||
			firecrawlBaseUrl.hash
		) {
			throw new Error("FIRECRAWL_BASE_URL must be an HTTP or HTTPS origin without credentials or a path");
		}
		if (firecrawlBaseUrl.protocol !== "https:") {
			const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(firecrawlBaseUrl.hostname);
			if (firecrawlBaseUrl.protocol !== "http:" || !loopback) {
				throw new Error("Insecure FIRECRAWL_BASE_URL values are allowed only on loopback");
			}
		}
		const firecrawlAuthorization = firecrawlBaseUrlValue ? "none" : "bearer";
		const firecrawlEndpoint = (path: string) => new URL(path, firecrawlBaseUrl);
		pi.registerTool(
			defineTool({
				name: "firecrawl_search",
				label: "Firecrawl Search",
				description: "Search the public web with Firecrawl and return structured results.",
				parameters: Type.Object({
					query: Type.String({ description: "Search query" }),
					limit: Type.Optional(Type.Integer({ description: "Maximum results", minimum: 1, maximum: 10 })),
				}),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const result = await requestJson(firecrawlEndpoint("/v2/search"), {
						provider: "Firecrawl",
						apiKey: firecrawlApiKey,
						authorization: firecrawlAuthorization,
						method: "POST",
						body: { query: params.query, limit: params.limit ?? 5, sources: ["web"] },
						signal,
					});
					return textResult("firecrawl", result);
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "firecrawl_scrape",
				label: "Firecrawl Scrape",
				description: "Extract the main Markdown content and metadata from a public web page with Firecrawl.",
				parameters: Type.Object({
					url: Type.String({ description: "Public HTTP or HTTPS URL to scrape" }),
				}),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const target = new URL(params.url);
					if (target.protocol !== "http:" && target.protocol !== "https:") {
						throw new Error("Firecrawl only accepts HTTP or HTTPS URLs");
					}
					const result = await requestJson(firecrawlEndpoint("/v2/scrape"), {
						provider: "Firecrawl",
						apiKey: firecrawlApiKey,
						authorization: firecrawlAuthorization,
						method: "POST",
						body: { url: target.href, formats: ["markdown"], onlyMainContent: true },
						signal,
					});
					return textResult("firecrawl", result);
				},
			}),
		);

		pi.registerTool(
			defineTool({
				name: "firecrawl_crawl",
				label: "Firecrawl Crawl",
				description: "Start a bounded Firecrawl crawl and return its job ID and status URL.",
				parameters: Type.Object({
					url: Type.String({ description: "Public HTTP or HTTPS site URL to crawl" }),
					limit: Type.Optional(Type.Integer({ description: "Maximum pages", minimum: 1, maximum: 100 })),
				}),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const target = new URL(params.url);
					if (target.protocol !== "http:" && target.protocol !== "https:") {
						throw new Error("Firecrawl only accepts HTTP or HTTPS URLs");
					}
					const result = await requestJson(firecrawlEndpoint("/v2/crawl"), {
						provider: "Firecrawl",
						apiKey: firecrawlApiKey,
						authorization: firecrawlAuthorization,
						method: "POST",
						body: {
							url: target.href,
							limit: params.limit ?? 25,
							scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
						},
						signal,
					});
					return textResult("firecrawl", result);
				},
			}),
		);
	}

	const currentsApiKey = toolCredential("CURRENTS_NEW_API_KEY");
	if (currentsApiKey) {
		pi.registerTool(
			defineTool({
				name: "currents_search_news",
				label: "Currents News Search",
				description: "Search recent news articles through Currents API.",
				parameters: Type.Object({
					query: Type.String({ description: "News search query" }),
					language: Type.Optional(Type.String({ description: "Two-letter language code, such as en" })),
					limit: Type.Optional(Type.Integer({ description: "Maximum articles", minimum: 1, maximum: 50 })),
				}),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const url = new URL("https://api.currentsapi.services/v1/search");
					url.searchParams.set("keywords", params.query);
					url.searchParams.set("limit", String(params.limit ?? 10));
					if (params.language) url.searchParams.set("language", params.language);
					const result = await requestJson(url, {
						provider: "Currents",
						apiKey: currentsApiKey,
						authorization: "bearer",
						signal,
					});
					return textResult("currents", result);
				},
			}),
		);
	}

	const finnhubApiKey = toolCredential("FINNHUB_API_KEY");
	if (finnhubApiKey) {
		pi.registerTool(
			defineTool({
				name: "finnhub_quote",
				label: "Finnhub Quote",
				description: "Get the current Finnhub quote snapshot for a stock symbol.",
				parameters: Type.Object({ symbol: Type.String({ description: "Stock symbol, such as AAPL" }) }),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const symbol = params.symbol.trim().toUpperCase();
					if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) throw new Error("Invalid stock symbol");
					const url = new URL("https://finnhub.io/api/v1/quote");
					url.searchParams.set("symbol", symbol);
					const result = await requestJson(url, {
						provider: "Finnhub",
						apiKey: finnhubApiKey,
						authorization: "finnhub",
						signal,
					});
					return textResult("finnhub", result);
				},
			}),
		);
	}

	const tiingoApiKey = toolCredential("TIINGO_API_KEY");
	if (tiingoApiKey) {
		pi.registerTool(
			defineTool({
				name: "tiingo_price",
				label: "Tiingo Price",
				description: "Get the latest IEX price snapshot for a stock ticker through Tiingo.",
				parameters: Type.Object({ ticker: Type.String({ description: "Stock ticker, such as AAPL" }) }),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const ticker = params.ticker.trim().toUpperCase();
					if (!/^[A-Z0-9._-]{1,32}$/.test(ticker)) throw new Error("Invalid stock ticker");
					const result = await requestJson(new URL(`https://api.tiingo.com/iex/${encodeURIComponent(ticker)}`), {
						provider: "Tiingo",
						apiKey: tiingoApiKey,
						authorization: "token",
						signal,
					});
					return textResult("tiingo", result);
				},
			}),
		);
	}

	const apifyApiKey = toolCredential("APIFY_API_KEY");
	if (apifyApiKey) {
		pi.registerTool(
			defineTool({
				name: "apify_dataset_items",
				label: "Apify Dataset Items",
				description: "Read items from an existing Apify dataset without starting or modifying an Actor run.",
				parameters: Type.Object({
					datasetId: Type.String({ description: "Apify dataset ID or username~dataset-name" }),
					limit: Type.Optional(Type.Integer({ description: "Maximum items", minimum: 1, maximum: 100 })),
					offset: Type.Optional(Type.Integer({ description: "Zero-based item offset", minimum: 0 })),
				}),
				executionMode: "parallel",
				async execute(_toolCallId, params, signal) {
					const datasetId = params.datasetId.trim();
					if (!/^[A-Za-z0-9_-]+(?:~[A-Za-z0-9_-]+)?$/.test(datasetId)) throw new Error("Invalid Apify dataset ID");
					const url = new URL(`https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items`);
					url.searchParams.set("format", "json");
					url.searchParams.set("clean", "true");
					url.searchParams.set("limit", String(params.limit ?? 25));
					if (params.offset !== undefined) url.searchParams.set("offset", String(params.offset));
					const result = await requestJson(url, {
						provider: "Apify",
						apiKey: apifyApiKey,
						authorization: "bearer",
						signal,
					});
					return textResult("apify", result);
				},
			}),
		);
	}
}
