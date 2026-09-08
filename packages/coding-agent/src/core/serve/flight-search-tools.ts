import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Type from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";

const parameters = Type.Object(
	{
		origin: Type.String({ pattern: "^[A-Z]{3}$", description: "Departure airport IATA code." }),
		destination: Type.String({ pattern: "^[A-Z]{3}$" }),
		outboundDate: Type.String({
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			description: "Explicit departure date including year.",
		}),
		returnDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Omit for one-way." })),
		adults: Type.Integer({ minimum: 1, maximum: 9 }),
		children: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
		infantsInSeat: Type.Optional(Type.Integer({ minimum: 0, maximum: 8 })),
		infantsOnLap: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
		cabin: Type.Optional(
			Type.Union([
				Type.Literal("economy"),
				Type.Literal("premium-economy"),
				Type.Literal("business"),
				Type.Literal("first"),
			]),
		),
		excludeBasic: Type.Optional(
			Type.Boolean({ description: "Use true for Main Cabin requests; verify airline fare conditions separately." }),
		),
		airlines: Type.Optional(Type.Array(Type.String({ pattern: "^[A-Z0-9]{2}$" }), { minItems: 1, maxItems: 10 })),
		currency: Type.Optional(Type.String({ pattern: "^[A-Z]{3}$" })),
		stops: Type.Optional(
			Type.Union([
				Type.Literal("any"),
				Type.Literal("nonstop"),
				Type.Literal("one-or-fewer"),
				Type.Literal("two-or-fewer"),
			]),
		),
		departureToken: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 16000,
				description:
					"Token from an outbound result to retrieve matching return options. Keep the same trip parameters.",
			}),
		),
	},
	{ additionalProperties: false },
);
const validator = Compile(parameters);
const WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const LIMIT = 250;

/** One instance per owning serve host; its shared settings directory has an exclusive ownership lease. */
export function createFlightSearchTools(credential: () => string | undefined, storage: string): ToolDefinition[] {
	const cache = new Map<string, { at: number; value: string }>();
	return [
		{
			name: "flight_search",
			label: "Flight search",
			description:
				"Research one-way or round-trip fares with SerpApi Google Flights. Requires configured SerpApi credentials. Shared cap: 250 attempts in a rolling 31 days; identical queries cached for 10 minutes. Each return-option lookup also counts. Does not book or track aircraft.",
			promptSnippet:
				"Use flight_search for airfare research instead of general web search. Obtain the trip year and passenger counts; never reuse a previous trip's dates or destination without confirmation. Use departureToken to complete round-trip research. Prices are observed quotes, not confirmed bookings. Verify Main Cabin fare rules before claiming a match.",
			parameters,
			executionMode: "sequential",
			async execute(_id, input, signal) {
				if (!validator.Check(input)) throw new Error("Invalid flight search parameters");
				const key = credential()?.trim();
				if (!key)
					throw new Error(
						"Open Settings > Connections > SerpApi Google Flights, save your API key and enable the provider. Then assign Research flight fares to the agent or ask the supervisor to add it. Never paste keys in chat.",
					);
				for (const date of [input.outboundDate, input.returnDate].filter((value) => value !== undefined)) {
					const parsed = new Date(`${date}T00:00:00Z`);
					if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date)
						throw new Error("Flight dates must be valid calendar dates");
				}
				if (input.returnDate && input.returnDate < input.outboundDate)
					throw new Error("Return date must not precede departure");
				if (input.origin === input.destination) throw new Error("Choose different departure and arrival airports");
				if (
					input.adults + (input.children ?? 0) + (input.infantsInSeat ?? 0) > 9 ||
					(input.infantsOnLap ?? 0) > input.adults
				)
					throw new Error("At most nine seated passengers and one lap infant per adult are supported");
				if (input.excludeBasic && input.cabin && input.cabin !== "economy")
					throw new Error("Exclude basic applies only to economy");
				const url = new URL("https://serpapi.com/search.json");
				const query: Record<string, string> = {
					engine: "google_flights",
					departure_id: input.origin,
					arrival_id: input.destination,
					outbound_date: input.outboundDate,
					type: input.returnDate ? "1" : "2",
					adults: String(input.adults),
					children: String(input.children ?? 0),
					infants_in_seat: String(input.infantsInSeat ?? 0),
					infants_on_lap: String(input.infantsOnLap ?? 0),
					travel_class: String(
						{ economy: 1, "premium-economy": 2, business: 3, first: 4 }[input.cabin ?? "economy"],
					),
					currency: input.currency ?? "USD",
					hl: "en",
					gl: "us",
					stops: String({ any: 0, nonstop: 1, "one-or-fewer": 2, "two-or-fewer": 3 }[input.stops ?? "any"]),
				};
				if (input.returnDate) query.return_date = input.returnDate;
				if (input.excludeBasic !== undefined) query.exclude_basic = String(input.excludeBasic);
				if (input.airlines) query.include_airlines = [...new Set(input.airlines)].sort().join(",");
				if (input.departureToken) query.departure_token = input.departureToken;
				const fingerprint = createHash("sha256").update(key).digest("hex");
				const cacheKey = `${fingerprint}:${JSON.stringify(query)}`;
				const now = Date.now();
				const cached = cache.get(cacheKey);
				if (cached && now - cached.at < 600_000)
					return { content: [{ type: "text", text: cached.value }], details: { cached: true } };
				signal?.throwIfAborted();
				mkdirSync(storage, { recursive: true });
				const ledger = join(storage, `${fingerprint}.json`);
				const saved: unknown = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];
				if (
					!Array.isArray(saved) ||
					!saved.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
				)
					throw new Error("Flight search usage record is invalid; repair it before searching");
				const attempts = (saved as number[]).filter((at) => at > now - WINDOW_MS);
				if (attempts.length >= LIMIT)
					throw new Error(
						`Flight search cap reached: ${LIMIT} attempts per rolling 31 days. Next slot: ${new Date(Math.min(...attempts) + WINDOW_MS).toISOString()}.`,
					);
				// Reserve before any await so parallel agents cannot overspend, including after restart or failed requests.
				attempts.push(now);
				const temporary = `${ledger}.${randomUUID()}.tmp`;
				writeFileSync(temporary, JSON.stringify(attempts), { mode: 0o600 });
				renameSync(temporary, ledger);
				for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
				url.searchParams.set("api_key", key);
				let payload: Record<string, unknown>;
				try {
					const response = await fetch(url, {
						redirect: "error",
						signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
					});
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (!response.body) throw new Error("Empty response");
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
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid response");
					payload = parsed as Record<string, unknown>;
					if (payload.error) throw new Error("Provider reported an error");
					if (!Array.isArray(payload.best_flights) && !Array.isArray(payload.other_flights))
						throw new Error("Provider did not return flight result arrays");
				} catch {
					throw new Error(
						"SerpApi flight search failed. Check the API key and remaining allowance in Settings > Connections and your SerpApi dashboard. No flight result was verified; this attempt counts toward the local cap.",
					);
				}
				const result = {
					provider: "SerpApi Google Flights",
					observedAt: new Date(now).toISOString(),
					query,
					remainingLocalAttempts: LIMIT - attempts.length,
					usageWindow: "rolling 31 days; shared by all agents using this key in this settings directory",
					bestFlights: Array.isArray(payload.best_flights) ? payload.best_flights : [],
					otherFlights: Array.isArray(payload.other_flights) ? payload.other_flights : [],
					warning:
						"Observed search quotes only. Verify return legs, passenger price basis and airline fare conditions before presenting a total or Main Cabin match. Provider allowance also includes usage outside this workspace.",
				};
				const value = JSON.stringify(result).replaceAll(key, "[redacted]");
				if (cache.size >= 100) cache.clear();
				cache.set(cacheKey, { at: now, value });
				return { content: [{ type: "text", text: value }], details: { cached: false } };
			},
		},
	];
}
