import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ReportToolRegistry, renderReport } from "../src/core/serve/report-tool-registry.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";

let root: string;
let registry: ReportToolRegistry;
let gateway: GovernedActionService;
const spec = {
	id: "trip_report",
	name: "Trip report",
	description: "Render structured trip results",
	template:
		"<!doctype html><h1>{{title}}</h1><table>{{#each options}}<tr><td>{{fare}}</td><td>{{freshness observedAt}}</td></tr>{{/each}}</table>",
	fields: [{ name: "title", type: "string" as const }],
	rows: [
		{
			name: "options",
			fields: [
				{ name: "fare", type: "number" as const, nullable: true },
				{ name: "observedAt", type: "string" as const, nullable: true },
			],
		},
	],
	observationTtlHours: 2,
};
const first = { title: "TEST SGF–PNS", options: [{ fare: null, observedAt: "2000-01-01T00:00:00Z" }] };
const second = { title: "TEST ORD–SEA", options: [{ fare: null, observedAt: null }] };
async function call(tool: ToolDefinition, input: unknown) {
	const result = await tool.execute("test", input, undefined, undefined, undefined as never);
	const text = result.content.find((item) => item.type === "text");
	if (text?.type !== "text") throw new Error("Missing result");
	return JSON.parse(text.text);
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-report-test-"));
	registry = new ReportToolRegistry(join(root, "registry"));
	await registry.initialize();
	gateway = new GovernedActionService(new ServeAuditStore(join(root, "audit")));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("registration validates two fixtures and a separate member renders the persisted tool", async () => {
	const manager = registry.createTools(["report_tools"], root, gateway)[0]!;
	const saved = await call(manager, {
		action: "register",
		definition: spec,
		samples: [
			{ data: first, contains: ["Unavailable", "Stale observation"] },
			{ data: second, contains: ["ORD–SEA", "Unverified observation"] },
		],
	});
	expect(saved.samplesPassed).toBe(2);
	expect(saved.assigned).toBe(false);
	expect(registry.createTools([], root, gateway)).toEqual([]);
	await expect(call(manager, { action: "run", tool: saved.tool, data: second })).rejects.toThrow("Assign");
	const reloaded = new ReportToolRegistry(join(root, "registry"));
	await reloaded.initialize();
	expect(
		new TeamResources(undefined, undefined, undefined, undefined, undefined, reloaded)
			.catalog()
			.some((item) => item.id === saved.tool),
	).toBe(true);
	const member = reloaded.createTools([saved.tool, "write"], root, gateway)[0]!;
	const rendered = await call(member, { data: second });
	expect(await readFile(join(root, rendered.reportPath), "utf8")).toBe(renderReport(spec, second));
	expect(rendered.sha256).toMatch(/^[a-f0-9]{64}$/);
	await expect(call(reloaded.createTools([saved.tool], root, gateway)[0]!, { data: second })).rejects.toThrow("write");
});

test("invalid samples and malformed data cannot be registered or rendered", async () => {
	const manager = registry.createTools(["report_tools"], root, gateway)[0]!;
	await expect(
		call(manager, {
			action: "register",
			definition: spec,
			samples: [
				{ data: first, contains: ["absent"] },
				{ data: second, contains: ["TEST"] },
			],
		}),
	).rejects.toThrow('sample 1 assertion failed: missing ["absent"]');
	expect(registry.list()).toEqual([]);
	expect(() => renderReport(spec, { ...first, options: [{ fare: "guessed", observedAt: null }] })).toThrow(
		"input fields",
	);
	expect(() => renderReport(spec, { options: [] })).toThrow("input fields");
});

test("the discovery example is executable without guessing registration nesting", async () => {
	const manager = registry.createTools(["report_tools"], root, gateway)[0]!;
	const listing = await call(manager, { action: "list" });
	expect(listing.tools).toEqual([]);
	const result = await call(manager, listing.registrationExample);
	expect(result.samplesPassed).toBe(2);
	expect(result.tool).toBe("saved_report_example_report_v1");
});

test("untrusted input stays text and missing, invalid and future observations never appear recent", () => {
	const now = Date.parse("2026-09-09T12:00:00Z");
	const data = {
		title: '<img src=x onerror="bad()">{{title}}',
		options: [null, "bad", "2027-01-01T00:00:00Z"].map((observedAt) => ({ fare: null, observedAt })),
	};
	const html = renderReport(spec, data, now);
	expect(html).toContain("&lt;img");
	expect(html).toContain("{{title}}");
	expect(html.match(/Unverified observation/g)).toHaveLength(3);
	expect(html).not.toContain("Recent observation");
	expect(() => renderReport({ ...spec, template: '<a href="{{title}}">link</a>' }, first)).toThrow("text");
	expect(() => renderReport({ ...spec, template: "<script>alert(1)</script>" }, first)).toThrow("static HTML");
});
