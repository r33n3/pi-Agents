import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { BrowserPolicy } from "./browser-policy.ts";
import type { EverydayConfigurationRegistry } from "./everyday-configuration-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const weatherParameters = Type.Object({
	location: Type.String({ minLength: 1, maxLength: 200 }),
	days: Type.Optional(Type.Integer({ minimum: 1, maximum: 14 })),
});
const urlParameters = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 4096 }),
});
const monitorParameters = Type.Object({
	url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	monitorId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});
const PUBLIC_POLICY = new BrowserPolicy("public-web");
const MAX_RESPONSE_BYTES = 2_000_000;

interface MonitorRecord {
	url: string;
	digest: string;
	checkedAt: string;
}

/** Creates bounded, credential-free read tools suitable for interactive agents and unattended routines. */
export function createEverydayDataTools(
	stateDirectory: string,
	configurations?: EverydayConfigurationRegistry,
): ToolDefinition[] {
	const monitor = new SiteMonitorStore(stateDirectory);
	return [
		{
			name: "weather_lookup",
			label: "weather_lookup",
			description: "Get current conditions and a bounded Open-Meteo forecast for a named location.",
			promptSnippet: "Use weather_lookup for current conditions and forecasts without browser automation.",
			parameters: weatherParameters,
			executionMode: "parallel",
			async execute(_toolCallId, { location, days = 7 }, signal) {
				const geocoding = await fetchJson(
					`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
					signal,
				);
				const geocodingRecord = record(geocoding, "Open-Meteo geocoding response");
				const results = Array.isArray(geocodingRecord.results) ? geocodingRecord.results : [];
				const place = record(results[0], `No weather location matched ${location}`);
				const latitude = finiteNumber(place.latitude, "latitude");
				const longitude = finiteNumber(place.longitude, "longitude");
				const forecast = await fetchJson(
					`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&forecast_days=${days}&timezone=auto`,
					signal,
				);
				return textResult(
					JSON.stringify(
						{
							location: {
								name: place.name,
								admin1: place.admin1,
								country: place.country,
								latitude,
								longitude,
							},
							forecast,
							source: "Open-Meteo",
						},
						null,
						2,
					),
				);
			},
		},
		{
			name: "weather_alerts",
			label: "weather_alerts",
			description: "Read active US weather alerts for a named location from the National Weather Service.",
			promptSnippet: "Use weather_alerts for official active US weather alerts.",
			parameters: Type.Object({
				location: Type.String({ minLength: 1, maxLength: 200 }),
			}),
			executionMode: "parallel",
			async execute(_toolCallId, { location }, signal) {
				const geocoding = record(
					await fetchJson(
						`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`,
						signal,
					),
					"Open-Meteo geocoding response",
				);
				const results = Array.isArray(geocoding.results) ? geocoding.results : [];
				const place = record(results[0], `No weather location matched ${location}`);
				const latitude = finiteNumber(place.latitude, "latitude");
				const longitude = finiteNumber(place.longitude, "longitude");
				const alerts = await fetchJson(
					`https://api.weather.gov/alerts/active?point=${latitude},${longitude}`,
					signal,
					{ "user-agent": "pi-agents-local/1.0" },
				);
				return textResult(
					JSON.stringify(
						{
							location: place.name,
							alerts,
							source: "National Weather Service",
						},
						null,
						2,
					),
				);
			},
		},
		{
			name: "feed_read",
			label: "feed_read",
			description: "Read up to 25 entries from a public RSS or Atom feed.",
			promptSnippet: "Use feed_read for bounded RSS or Atom monitoring.",
			parameters: urlParameters,
			executionMode: "parallel",
			async execute(_toolCallId, { url }, signal) {
				const response = await safeFetchPublic(url, signal);
				const xml = await boundedText(response);
				return textResult(
					JSON.stringify(
						{
							url: response.url,
							entries: parseFeed(xml),
							source: response.url,
						},
						null,
						2,
					),
				);
			},
		},
		{
			name: "site_monitor_check",
			label: "site_monitor_check",
			description: "Fetch a public page and report whether its bounded response changed since the prior check.",
			promptSnippet: "Use site_monitor_check for explicit, read-only site change monitoring.",
			parameters: monitorParameters,
			executionMode: "parallel",
			async execute(_toolCallId, { url, monitorId }, signal) {
				if ((url === undefined) === (monitorId === undefined)) {
					throw new Error("Provide exactly one of url or monitorId");
				}
				const configured = monitorId ? configurations?.findMonitor(monitorId) : undefined;
				if (monitorId && !configured) throw new Error(`Site monitor ${monitorId} was not found`);
				if (configured && !configured.enabled) throw new Error(`Site monitor ${monitorId} is disabled`);
				const targetUrl = configured?.url ?? url;
				if (!targetUrl) throw new Error("Site monitor URL is unavailable");
				const response = await safeFetchPublic(targetUrl, signal);
				const body = await boundedText(response);
				const checked = await monitor.check(response.url, body);
				return textResult(
					JSON.stringify({ ...checked, monitorId: configured?.id, name: configured?.name }, null, 2),
				);
			},
		},
		{
			name: "finance_watchlist_list",
			label: "finance_watchlist_list",
			description: "List configured finance watchlists without retrieving account or market data.",
			promptSnippet: "Use finance_watchlist_list to discover configured symbols before requesting quotes.",
			parameters: Type.Object({}),
			executionMode: "parallel",
			async execute() {
				return textResult(JSON.stringify({ watchlists: configurations?.snapshot().watchlists ?? [] }, null, 2));
			},
		},
	];
}

class SiteMonitorStore {
	readonly #path: string;
	readonly #queue = new SerialOperationQueue();

	constructor(directory: string) {
		this.#path = resolve(directory, "site-monitor-state.json");
	}

	async check(url: string, body: string): Promise<MonitorRecord & { changed: boolean; previousDigest?: string }> {
		return this.#queue.run(async () => {
			const records = await this.#read();
			const digest = createHash("sha256").update(body).digest("hex");
			const previous = records[url];
			const record = { url, digest, checkedAt: new Date().toISOString() };
			records[url] = record;
			await mkdir(dirname(this.#path), { recursive: true });
			const temporary = resolve(dirname(this.#path), `.site-monitor.${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
			});
			await rename(temporary, this.#path);
			return {
				...record,
				changed: previous !== undefined && previous.digest !== digest,
				previousDigest: previous?.digest,
			};
		});
	}

	async #read(): Promise<Record<string, MonitorRecord>> {
		try {
			const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			return record(value, "site monitor state") as Record<string, MonitorRecord>;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return {};
			throw error;
		}
	}
}

async function fetchJson(
	url: string,
	signal: AbortSignal | undefined,
	headers?: Record<string, string>,
): Promise<unknown> {
	const response = await safeFetchPublic(url, signal, headers);
	return JSON.parse(await boundedText(response)) as unknown;
}

async function safeFetchPublic(
	urlText: string,
	signal: AbortSignal | undefined,
	headers: Record<string, string> = {},
): Promise<Response> {
	let url = urlText;
	for (let redirects = 0; redirects <= 5; redirects += 1) {
		await PUBLIC_POLICY.assertResolvedNavigation(url);
		const response = await fetch(url, {
			redirect: "manual",
			signal,
			headers: {
				accept: "application/json, application/rss+xml, application/atom+xml, text/xml, text/html;q=0.8",
				...headers,
			},
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
			return response;
		}
		const location = response.headers.get("location");
		if (!location) throw new Error("Provider redirect did not include a location");
		url = new URL(location, url).href;
	}
	throw new Error("Provider request exceeded five redirects");
}

async function boundedText(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds 2 MB");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds 2 MB");
	return new TextDecoder().decode(bytes);
}

function parseFeed(xml: string): Array<{
	title: string;
	url?: string;
	published?: string;
	summary?: string;
}> {
	const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
	return blocks.slice(0, 25).map((block) => ({
		title: xmlText(block, "title") ?? "Untitled",
		url: xmlText(block, "link") ?? attribute(block, "link", "href"),
		published: xmlText(block, "pubDate") ?? xmlText(block, "published") ?? xmlText(block, "updated"),
		summary: xmlText(block, "description") ?? xmlText(block, "summary") ?? xmlText(block, "content"),
	}));
}

function xmlText(block: string, tag: string): string | undefined {
	const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
	if (!match?.[1]) return undefined;
	return cleanXml(match[1]);
}

function attribute(block: string, tag: string, name: string): string | undefined {
	const match = block.match(new RegExp(`<${tag}\\b[^>]*\\b${name}=["']([^"']+)["'][^>]*>`, "i"));
	return match?.[1] ? decodeEntities(match[1]) : undefined;
}

function cleanXml(value: string): string {
	return decodeEntities(
		value
			.replace(/<!\[CDATA\[|\]\]>/g, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim(),
	).slice(0, 4_000);
}

function decodeEntities(value: string): string {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'");
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is unavailable`);
	return value;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
