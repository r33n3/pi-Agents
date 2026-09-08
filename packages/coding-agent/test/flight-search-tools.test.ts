import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { createFlightSearchTools } from "../src/core/serve/flight-search-tools.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";

let root: string;
const key = "test-serpapi-secret";
const trip = {
	origin: "SGF",
	destination: "PNS",
	outboundDate: "2026-12-01",
	returnDate: "2026-12-15",
	adults: 2,
	excludeBasic: true,
	airlines: ["AA", "DL"],
};
const execute = (tool: ToolDefinition, input: unknown = trip) =>
	tool.execute("flight-test", input, undefined, undefined, {} as ExtensionContext);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-flight-test-"));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

test("maps trip and fare constraints, retains tokens and flight evidence, caches identical searches", async () => {
	const fetcher = vi.fn(async (_url: URL | string | Request) =>
		Response.json({
			best_flights: [
				{
					price: 640,
					flights: [{ flight_number: "AA 123", airplane: "Embraer 175" }],
					departure_token: "return-options",
				},
			],
			search_parameters: { api_key: key },
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	const tool = createFlightSearchTools(() => key, root)[0]!;
	const result = await execute(tool);
	const request = new URL(String(fetcher.mock.calls[0]?.[0]));
	expect(request.searchParams.get("departure_id")).toBe("SGF");
	expect(request.searchParams.get("arrival_id")).toBe("PNS");
	expect(request.searchParams.get("adults")).toBe("2");
	expect(request.searchParams.get("include_airlines")).toBe("AA,DL");
	expect(request.searchParams.get("exclude_basic")).toBe("true");
	expect(request.searchParams.get("type")).toBe("1");
	expect(JSON.stringify(result)).toContain("AA 123");
	expect(JSON.stringify(result)).not.toContain(key);
	expect((await execute(tool)).details).toEqual({ cached: true });
	expect(fetcher).toHaveBeenCalledTimes(1);
	await execute(tool, { ...trip, departureToken: "return-options" });
	expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get("departure_token")).toBe("return-options");
});

test("invalid dates and missing configuration never consume requests", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(execute(createFlightSearchTools(() => undefined, root)[0]!)).rejects.toThrow("Settings > Connections");
	const tool = createFlightSearchTools(() => key, root)[0]!;
	await expect(execute(tool, { ...trip, outboundDate: "2026-02-30" })).rejects.toThrow("calendar dates");
	await expect(execute(tool, { ...trip, returnDate: "2026-11-30" })).rejects.toThrow("must not precede");
	expect(fetcher).not.toHaveBeenCalled();
});

test("persistent shared limit prevents concurrent agents and restarted tools exceeding the allowance", async () => {
	const ledger = join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
	await writeFile(ledger, JSON.stringify(Array.from({ length: 249 }, () => Date.now())));
	const fetcher = vi.fn(async () => Response.json({ best_flights: [] }));
	vi.stubGlobal("fetch", fetcher);
	const calls = await Promise.allSettled([
		execute(createFlightSearchTools(() => key, root)[0]!),
		execute(createFlightSearchTools(() => key, root)[0]!),
	]);
	expect(calls.filter((call) => call.status === "fulfilled")).toHaveLength(1);
	expect(fetcher).toHaveBeenCalledTimes(1);
	await expect(execute(createFlightSearchTools(() => key, root)[0]!)).rejects.toThrow("cap reached");
	expect(JSON.parse(await readFile(ledger, "utf8"))).toHaveLength(250);
});

test("provider and transport failures do not leak credentials or masquerade as empty results", async () => {
	const fetcher = vi
		.fn()
		.mockRejectedValueOnce(new Error(`https://serpapi.com?api_key=${key}`))
		.mockResolvedValueOnce(Response.json({ error: "quota exhausted" }));
	vi.stubGlobal("fetch", fetcher);
	const tool = createFlightSearchTools(() => key, root)[0]!;
	for (let index = 0; index < 2; index++) await expect(execute(tool)).rejects.toThrow("No flight result was verified");
	const ledger = join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
	expect(JSON.parse(await readFile(ledger, "utf8"))).toHaveLength(2);
});

test("agents and teams discover setup, then receive only explicitly enabled flight grants", async () => {
	let configured = false;
	const broker = new CapabilityBroker(join(root, "broker"), {
		activeToolNames: () => ["flight_search"],
		environmentValue: (name) => (name === "SERPAPI_API_KEY" && configured ? key : undefined),
	});
	await broker.initialize();
	const resources = new TeamResources(broker);
	expect(resources.catalog().find((entry) => entry.id === "serpapi-flights:flights.search")?.setup).toContain(
		"SerpApi Google Flights",
	);
	expect(resources.list().some((entry) => entry.id === "serpapi-flights:flights.search")).toBe(false);
	await broker.reviewProvider("serpapi-flights", true);
	await expect(broker.enableProvider("serpapi-flights", true)).rejects.toThrow("requires configuration");
	configured = true;
	await broker.enableProvider("serpapi-flights", true);
	const grants = resources.resolveTool("serpapi-flights:flights.search").capabilities;
	expect(broker.resolveToolNames(grants, "harness")).toEqual(["flight_search"]);
	expect(broker.resolveToolNames(grants, "session")).toEqual(["flight_search"]);
	await broker.disableProvider("serpapi-flights", true);
	expect(() => resources.resolveTool("serpapi-flights:flights.search")).toThrow("Enable the provider");
});
