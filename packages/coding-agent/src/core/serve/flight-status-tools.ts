import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";

const parameters = Type.Object(
	{
		flightNumber: Type.Optional(
			Type.String({
				pattern: "^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$",
				description: "IATA flight number, for example AA123. Not an aircraft tail number.",
			}),
		),
		departureAirport: Type.Optional(Type.String({ pattern: "^[A-Z]{3}$" })),
		arrivalAirport: Type.Optional(Type.String({ pattern: "^[A-Z]{3}$" })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
	},
	{ additionalProperties: false },
);
const validator = Compile(parameters);
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;

/** Host-owned instance shared by individual agents and team workers. Credentials never enter workers. */
export function createFlightStatusTools(credential: () => string | undefined, storage: string): ToolDefinition[] {
	const cache = new Map<string, { at: number; text: string }>();
	return [
		{
			name: "flight_status",
			label: "Flight status and arrivals",
			description:
				"Look up current Aviationstack flight status by flight number or departure/arrival airport. Returns reported dates, status, times, flight identifiers and aircraft details when supplied. No fare prices, booking, or guaranteed tail-number coverage. Shared limit: 100 attempts per rolling 31 days; cache: 2 minutes.",
			promptSnippet:
				"Use flight_status for current flight tracking and airport arrivals/departures. Check each returned flight_date and live.updated timestamp. Keep missing data unknown; flight number and aircraft registration are different. Use flight_search for future trip prices. Do not continuously poll a free account.",
			parameters,
			executionMode: "sequential",
			async execute(_id, input, signal) {
				if (!validator.Check(input) || !(input.flightNumber || input.departureAirport || input.arrivalAirport))
					throw new Error("Supply a flight number or an arrival/departure airport");
				const key = credential()?.trim();
				if (!key)
					throw new Error(
						"Open Settings > Connections > Aviationstack, save your API key, review and enable it, then assign Flight status and arrivals to the agent/team. Never paste keys into chat.",
					);
				const url = new URL("https://api.aviationstack.com/v1/flights");
				if (input.flightNumber) url.searchParams.set("flight_iata", input.flightNumber);
				if (input.departureAirport) url.searchParams.set("dep_iata", input.departureAirport);
				if (input.arrivalAirport) url.searchParams.set("arr_iata", input.arrivalAirport);
				url.searchParams.set("limit", String(input.limit ?? 10));
				url.searchParams.set("offset", String(input.offset ?? 0));
				const fingerprint = createHash("sha256").update(key).digest("hex");
				const cacheKey = `${fingerprint}:${url.search}`;
				const now = Date.now();
				signal?.throwIfAborted();
				const cached = cache.get(cacheKey);
				if (cached && now - cached.at < 120_000)
					return { content: [{ type: "text", text: cached.text }], details: { cached: true } };
				mkdirSync(storage, { recursive: true });
				const ledger = join(storage, `${fingerprint}.json`);
				const saved: unknown = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
				if (!Array.isArray(saved) || !saved.every((at: unknown) => typeof at === "number" && Number.isFinite(at)))
					throw new Error("Invalid flight status usage record; repair before searching");
				const attempts = (saved as number[]).filter((at) => at > now - WINDOW_MS);
				if (attempts.length >= 100)
					throw new Error(
						`Flight status cap reached: 100 attempts per rolling 31 days. Next slot: ${new Date(Math.min(...attempts) + WINDOW_MS).toISOString()}.`,
					);
				attempts.push(now);
				const temporary = `${ledger}.${randomUUID()}.tmp`;
				writeFileSync(temporary, JSON.stringify(attempts), { mode: 0o600 });
				renameSync(temporary, ledger);
				url.searchParams.set("access_key", key);
				let record: Record<string, unknown>;
				let failure = "Network or invalid provider response";
				try {
					const response = await fetch(url, {
						redirect: "error",
						signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
					});
					if (!response.ok) {
						failure = `HTTP ${response.status}`;
						throw new Error(failure);
					}
					if (!response.body) throw new Error("Missing body");
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let text = "";
					let size = 0;
					try {
						while (true) {
							const chunk = await reader.read();
							if (chunk.done) break;
							size += chunk.value.byteLength;
							if (size > 2_000_000) throw new Error("Response too large");
							text += decoder.decode(chunk.value, { stream: true });
						}
					} finally {
						await reader.cancel();
					}
					const parsed: unknown = JSON.parse(text + decoder.decode());
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid data");
					record = parsed as Record<string, unknown>;
					if (record.error) {
						const error = record.error as Record<string, unknown>;
						const reasons: Record<string, string> = {
							invalid_access_key: "Invalid API key",
							usage_limit_reached: "Provider quota exhausted",
							function_access_restricted: "Requested feature is unavailable on this plan",
							https_access_restricted: "HTTPS is unavailable on this plan; insecure HTTP fallback is disabled",
						};
						failure =
							typeof error.type === "string"
								? (reasons[error.type] ?? "Provider rejected the request")
								: "Provider rejected the request";
						throw new Error(failure);
					}
					if (!Array.isArray(record.data)) throw new Error("Missing flight data");
				} catch {
					throw new Error(
						`Aviationstack: ${failure}. No flight status was verified. Check your API key and plan allowance in Settings > Connections and the Aviationstack dashboard. The local cap counts this attempt.`,
					);
				}
				const text = JSON.stringify({
					provider: "Aviationstack",
					observedAt: new Date(now).toISOString(),
					query: input,
					flights: record.data,
					pagination: record.pagination,
					remainingLocalAttempts: 100 - attempts.length,
					warning:
						"Status is as reported by the provider, not guaranteed live. Inspect flight_date and live.updated. Null aircraft/registration fields mean unknown. Local usage excludes other apps and machines.",
				}).replaceAll(key, "[redacted]");
				if (cache.size >= 100) cache.clear();
				cache.set(cacheKey, { at: now, text });
				return { content: [{ type: "text", text }], details: { cached: false } };
			},
		},
	];
}
