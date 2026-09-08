import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { createFlightStatusTools } from "../src/core/serve/flight-status-tools.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";

let root: string;
const key = "test-flight-status-key";
const execute = (tool: ToolDefinition, input: unknown = { flightNumber: "AA123" }) =>
	tool.execute("status-test", input, undefined, undefined, {} as ExtensionContext);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-status-test-"));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});
test("status queries retain aircraft identifiers and reported timestamps, reuse cached evidence", async () => {
	const fetcher = vi.fn(async (_url: URL | string | Request) =>
		Response.json({
			data: [
				{
					flight_date: "2026-09-07",
					flight: { iata: "AA123" },
					aircraft: { registration: "N123AA" },
					live: { updated: "2026-09-07T18:00:00Z" },
				},
			],
			pagination: { count: 1, total: 1 },
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	const tool = createFlightStatusTools(() => key, root)[0]!;
	const result = await execute(tool);
	expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get("flight_iata")).toBe("AA123");
	expect(JSON.stringify(result)).toContain("N123AA");
	expect(JSON.stringify(result)).toContain("2026-09-07T18:00:00Z");
	expect(JSON.stringify(result)).not.toContain(key);
	expect((await execute(tool)).details).toEqual({ cached: true });
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("invalid inputs and absent credentials make no network requests", async () => {
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await expect(execute(createFlightStatusTools(() => key, root)[0]!, {})).rejects.toThrow("Supply a flight number");
	await expect(execute(createFlightStatusTools(() => undefined, root)[0]!)).rejects.toThrow(
		"Settings > Connections > Aviationstack",
	);
	expect(fetcher).not.toHaveBeenCalled();
});
test("concurrent callers and restarts share the persisted 100-attempt limit", async () => {
	const ledger = join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
	await writeFile(ledger, JSON.stringify(Array.from({ length: 99 }, () => Date.now())));
	const fetcher = vi.fn(async () => Response.json({ data: [] }));
	vi.stubGlobal("fetch", fetcher);
	const calls = await Promise.allSettled([
		execute(createFlightStatusTools(() => key, root)[0]!),
		execute(createFlightStatusTools(() => key, root)[0]!),
	]);
	expect(calls.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	await expect(execute(createFlightStatusTools(() => key, root)[0]!)).rejects.toThrow("cap reached");
	expect(JSON.parse(await readFile(ledger, "utf8"))).toHaveLength(100);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("provider restrictions fail clearly without leaking keys or downgrading to HTTP", async () => {
	const fetcher = vi.fn(async () => Response.json({ error: { type: "https_access_restricted", info: key } }));
	vi.stubGlobal("fetch", fetcher);
	await expect(execute(createFlightStatusTools(() => key, root)[0]!)).rejects.toThrow(
		"insecure HTTP fallback is disabled",
	);
	expect(fetcher).toHaveBeenCalledTimes(1);
});
test("configured tracking is assignable through both agent and team capability grants", async () => {
	const broker = new CapabilityBroker(join(root, "broker"), {
		activeToolNames: () => ["flight_status"],
		environmentValue: (name) => (name === "AVIATIONSTACK_API_KEY" ? key : undefined),
	});
	await broker.initialize();
	const resources = new TeamResources(broker);
	expect(resources.catalog().find((entry) => entry.id === "aviationstack:flights.status")?.setup).toContain(
		"Aviationstack",
	);
	await broker.reviewProvider("aviationstack", true);
	await broker.enableProvider("aviationstack", true);
	const grants = resources.resolveTool("aviationstack:flights.status").capabilities;
	expect(broker.resolveToolNames(grants, "harness")).toEqual(["flight_status"]);
	expect(broker.resolveToolNames(grants, "session")).toEqual(["flight_status"]);
});
