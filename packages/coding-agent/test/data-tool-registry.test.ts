import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { DataToolRegistry } from "../src/core/serve/data-tool-registry.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";

let root: string;
let registry: DataToolRegistry;
let data: unknown;
const source: ToolDefinition = {
	name: "page_read",
	label: "Read",
	description: "Read",
	parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }),
	execute: vi.fn(async () => ({
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
		details: undefined,
	})),
};
const recipe = {
	id: "fare",
	name: "Fare",
	description: "Read published fare",
	source: "page_read",
	defaults: { url: "https://example.com/fares" },
	inputs: ["url"],
	recordsPointer: "",
	fields: [{ name: "price", pointer: "/text", prefix: "Price: ", suffix: " USD", type: "number" }],
	minRecords: 1,
	maxRecords: 1,
};
const call = (tool: ToolDefinition, input: unknown) =>
	tool.execute("test", input, undefined, undefined, {} as ExtensionContext);
const manager = () => registry.createTools(["data_tools"], () => [source]).find((tool) => tool.name === "data_tools")!;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-data-tools-"));
	registry = new DataToolRegistry(root);
	await registry.initialize();
	data = { text: "Price: 120 USD", url: "https://example.com/fares", fetchedAt: "2026-09-08T12:00:00Z" };
	vi.clearAllMocks();
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
test("registers only after source validation and survives restart with immutable versions", async () => {
	await call(manager(), { action: "register", recipe });
	await call(manager(), { action: "register", recipe: { ...recipe, name: "New fare" } });
	const restarted = new DataToolRegistry(root);
	await restarted.initialize();
	expect(restarted.list().map((entry) => [entry.version, entry.recipe.name])).toEqual([
		[1, "Fare"],
		[2, "New fare"],
	]);
	expect(await readFile(join(root, "registry.json"), "utf8")).not.toContain("120");
});
test("single agent executes assigned tool and source, retaining original evidence time", async () => {
	await call(manager(), { action: "register", recipe });
	const tool = registry.createTools(["saved_data_fare_v1"], () => [source])[0]!;
	const result = await call(tool, { values: { url: "https://example.com/other" } });
	expect(JSON.stringify(result)).toContain('\\"price\\":120');
	expect(JSON.stringify(result)).toContain("2026-09-08T12:00:00Z");
	expect(source.execute).toHaveBeenLastCalledWith(
		"test",
		{ url: "https://example.com/other" },
		undefined,
		undefined,
		{},
	);
	await expect(call(tool, { values: { api_key: "secret" } })).rejects.toThrow("declared inputs");
	await expect(call(tool, { tool: "another" })).rejects.toThrow("Invalid saved");
});
test("team catalog discovers recipes without assigning them or amplifying member authority", async () => {
	await call(manager(), { action: "register", recipe });
	const resources = new TeamResources(undefined, undefined, undefined, undefined, registry);
	expect(resources.validate(["saved_data_fare_v1"])[0]?.tools).toEqual(["saved_data_fare_v1"]);
	expect(registry.createTools([], () => [source])).toEqual([]);
	await expect(call(manager(), { action: "run", tool: "saved_data_fare_v1" })).rejects.toThrow("not assigned");
	const unconfigured = registry.createTools(["saved_data_fare_v1"], () => [])[0]!;
	await expect(call(unconfigured, {})).rejects.toThrow("Assign and configure page_read");
	let available = [source];
	const configured = registry.createTools(["saved_data_fare_v1"], () => available)[0]!;
	await call(configured, {});
	available = [];
	await expect(call(configured, {})).rejects.toThrow("Assign and configure");
});
test.each([
	{ text: "CAPTCHA" },
	{ text: "Price: 120 USD Price: 140 USD" },
	{ text: "Price: unknown USD" },
	{ text: "Price: 120 USD", truncated: true },
])("rejects changed, ambiguous, blocked or truncated sources: %j", async (response) => {
	data = response;
	await expect(call(manager(), { action: "register", recipe })).rejects.toThrow();
	expect(registry.list()).toEqual([]);
});
test("runtime validates source again after a successful registration", async () => {
	await call(manager(), { action: "register", recipe });
	data = { text: "Temporarily unavailable" };
	await expect(call(registry.createTools(["saved_data_fare_v1"], () => [source])[0]!, {})).rejects.toThrow("marker");
});
test("configurations reuse extraction with separate defaults and require another live validation", async () => {
	await call(manager(), { action: "register", recipe });
	await call(manager(), {
		action: "configure",
		tool: "saved_data_fare_v1",
		configuration: { id: "other_fare", name: "Other fare", defaults: { url: "https://example.com/other" } },
	});
	expect(registry.list()[0]?.recipe.defaults.url).toBe("https://example.com/fares");
	expect(registry.list()[1]?.recipe.defaults.url).toBe("https://example.com/other");
	expect(registry.list()[1]?.recipe.fields).toEqual(recipe.fields);
	data = {};
	await expect(
		call(manager(), {
			action: "configure",
			tool: "saved_data_fare_v1",
			configuration: { id: "bad_fare", name: "Bad", defaults: {} },
		}),
	).rejects.toThrow();
	expect(registry.list()).toHaveLength(2);
});
test("supports structured rows and escaped JSON pointers without model extraction", async () => {
	data = { rows: [{ "a/b": { "~price": 45 } }, { "a/b": { "~price": 60 } }] };
	await call(manager(), {
		action: "register",
		recipe: {
			...recipe,
			recordsPointer: "/rows",
			maxRecords: 2,
			fields: [{ name: "fare", pointer: "/a~1b/~0price", type: "number" }],
		},
	});
	const result = await call(
		registry.createTools(undefined, () => [source]).find((tool) => tool.name === "saved_data_fare_v1")!,
		{},
	);
	expect(JSON.stringify(result)).toContain('\\"fare\\":60');
});
test("invalid source arguments, unsupported sources and secret defaults never run", async () => {
	for (const invalid of [
		{ ...recipe, defaults: { url: "x", api_key: "secret" } },
		{ ...recipe, source: "powershell" },
		{ ...recipe, defaults: {} },
	])
		await expect(call(manager(), { action: "register", recipe: invalid })).rejects.toThrow();
	expect(source.execute).not.toHaveBeenCalled();
});
