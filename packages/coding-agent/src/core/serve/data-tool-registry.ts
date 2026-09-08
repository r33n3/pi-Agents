import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const scalar = Type.Union([Type.String({ maxLength: 4000 }), Type.Number(), Type.Boolean()]);
const recipeSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_]{0,39}$" }),
		name: Type.String({ minLength: 1, maxLength: 100 }),
		description: Type.String({ minLength: 1, maxLength: 1000 }),
		source: Type.Union([
			Type.Literal("page_read"),
			Type.Literal("firecrawl_scrape"),
			Type.Literal("flight_search"),
			Type.Literal("flight_status"),
			Type.Literal("feed_read"),
		]),
		defaults: Type.Record(Type.String(), scalar),
		inputs: Type.Array(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" }), { maxItems: 20, uniqueItems: true }),
		recordsPointer: Type.String({ maxLength: 500 }),
		fields: Type.Array(
			Type.Object(
				{
					name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" }),
					pointer: Type.String({ maxLength: 500 }),
					type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
					prefix: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
					suffix: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: 30 },
		),
		minRecords: Type.Integer({ minimum: 1, maximum: 1000 }),
		maxRecords: Type.Integer({ minimum: 1, maximum: 1000 }),
	},
	{ additionalProperties: false },
);
type Recipe = Static<typeof recipeSchema>;
const entrySchema = Type.Object({
	recipe: recipeSchema,
	version: Type.Integer({ minimum: 1 }),
	validatedAt: Type.String(),
});
type Entry = Static<typeof entrySchema>;
const storeSchema = Type.Array(entrySchema, { maxItems: 1000 });
const managerSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("register"),
			Type.Literal("configure"),
			Type.Literal("run"),
		]),
		recipe: Type.Optional(recipeSchema),
		tool: Type.Optional(Type.String()),
		values: Type.Optional(Type.Record(Type.String(), scalar)),
		configuration: Type.Optional(
			Type.Object(
				{
					id: recipeSchema.properties.id,
					name: recipeSchema.properties.name,
					defaults: recipeSchema.properties.defaults,
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function pointer(value: unknown, path: string): unknown {
	if (!path) return value;
	if (!path.startsWith("/") || /~(?![01])/u.test(path))
		throw new Error("Use an RFC 6901 JSON pointer, or empty string for the root");
	for (const part of path.slice(1).split("/")) {
		const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof value !== "object" || value === null || !Object.hasOwn(value, key))
			throw new Error(`Missing source field ${path}`);
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function extract(recipe: Recipe, value: unknown) {
	const selected = pointer(value, recipe.recordsPointer);
	const records = Array.isArray(selected) ? selected : [selected];
	if (records.length < recipe.minRecords || records.length > recipe.maxRecords)
		throw new Error("Source record count failed validation");
	return records.map((record) =>
		Object.fromEntries(
			recipe.fields.map((field) => {
				let result = pointer(record, field.pointer);
				if (field.prefix !== undefined || field.suffix !== undefined) {
					if (typeof result !== "string" || !field.prefix || !field.suffix)
						throw new Error("Text extraction requires both prefix and suffix");
					const start = result.indexOf(field.prefix);
					if (start < 0 || result.indexOf(field.prefix, start + field.prefix.length) !== -1)
						throw new Error(`Missing or ambiguous marker for ${field.name}`);
					const end = result.indexOf(field.suffix, start + field.prefix.length);
					if (end < 0) throw new Error(`Missing closing marker for ${field.name}`);
					const extracted = result.slice(start + field.prefix.length, end).trim();
					result = field.type === "number" && /^-?\d+(?:\.\d+)?$/u.test(extracted) ? Number(extracted) : extracted;
				}
				if (
					typeof result !== field.type ||
					(typeof result === "number" && !Number.isFinite(result)) ||
					result === ""
				)
					throw new Error(`Invalid ${field.type} for ${field.name}`);
				return [field.name, result];
			}),
		),
	);
}

/** Workspace recipes contain no executable code or credentials; source authority belongs to each caller. */
export class DataToolRegistry {
	private entries: Entry[] = [];
	private readonly queue = new SerialOperationQueue();
	private readonly directory: string;
	constructor(directory: string) {
		this.directory = directory;
	}
	async initialize() {
		await mkdir(this.directory, { recursive: true });
		try {
			const value: unknown = JSON.parse(await readFile(join(this.directory, "registry.json"), "utf8"));
			if (!Compile(storeSchema).Check(value)) throw new Error("Invalid data tool registry");
			this.entries = value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	list() {
		return structuredClone(this.entries).map((entry) => ({
			...entry,
			tool: `saved_data_${entry.recipe.id}_v${entry.version}`,
		}));
	}
	createTools(assigned: readonly string[] | undefined, sources: () => ToolDefinition[]): ToolDefinition[] {
		const run: ToolDefinition["execute"] = async (callId, input, signal, update, context) => {
			const { tool, values } = input as { tool: string; values?: Record<string, string | number | boolean> };
			const entry = this.list().find((item) => item.tool === tool);
			if (!entry || (assigned && !assigned.includes(tool))) throw new Error("Saved data tool is not assigned");
			return execute(entry.recipe, values ?? {}, callId, signal, update, context);
		};
		const execute = async (
			recipe: Recipe,
			values: Record<string, string | number | boolean>,
			callId: string,
			signal: Parameters<ToolDefinition["execute"]>[2],
			update: Parameters<ToolDefinition["execute"]>[3],
			context: Parameters<ToolDefinition["execute"]>[4],
		) => {
			if (Object.keys(values).some((key) => !recipe.inputs.includes(key)))
				throw new Error("Only declared inputs can be overridden");
			const source = sources().find((tool) => tool.name === recipe.source);
			if (!source)
				throw new Error(`Assign and configure ${recipe.source} for this agent before using this saved tool`);
			const parameters = { ...recipe.defaults, ...values };
			if (!Compile(source.parameters).Check(parameters)) throw new Error(`Invalid inputs for ${recipe.source}`);
			const response = await source.execute(callId, parameters, signal, update, context);
			const text = response.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			if (text.length > 2_000_000) throw new Error("Source result exceeds data tool limit");
			const data: unknown = JSON.parse(text);
			if (typeof data === "object" && data !== null && "truncated" in data && data.truncated === true)
				throw new Error("Source was truncated; narrow the request before saving a tool");
			const provenance =
				typeof data === "object" && data !== null
					? Object.fromEntries(
							Object.entries(data).filter(([key]) =>
								["url", "source", "fetchedAt", "observedAt", "warning", "provider"].includes(key),
							),
						)
					: {};
			const result = {
				source: recipe.source,
				executedAt: new Date().toISOString(),
				provenance,
				validation: "schema-and-extraction-only",
				records: extract(recipe, data),
			};
			return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: undefined };
		};
		const tools: ToolDefinition[] = this.list()
			.filter((entry) => !assigned || assigned.includes(entry.tool))
			.map((entry) => ({
				name: entry.tool,
				label: entry.recipe.name,
				description: `${entry.recipe.description} Requires separately assigned ${entry.recipe.source}. Returns untrusted source data; schema validation is not factual verification.`,
				parameters: Type.Object(
					{ values: Type.Optional(Type.Record(Type.String(), scalar)) },
					{ additionalProperties: false },
				),
				async execute(id, input, signal, update, context) {
					if (
						!Compile(
							Type.Object(
								{ values: Type.Optional(Type.Record(Type.String(), scalar)) },
								{ additionalProperties: false },
							),
						).Check(input)
					)
						throw new Error("Invalid saved data tool inputs");
					return run(id, { ...input, tool: entry.tool }, signal, update, context);
				},
			}));
		if (!assigned || assigned.includes("data_tools"))
			tools.push({
				name: "data_tools",
				label: "Reusable data tools",
				parameters: managerSchema,
				description:
					"List workspace recipes, register a tested recipe, configure an existing tool with configuration (new id, name and defaults merged over original), or run an assigned saved tool. Registration/configuration executes the source with values as a sample and only saves after extraction validates. Use defaults for non-secret configuration; never store credentials. Same id creates an immutable new version. Assign returned tool name AND its source through agent/team configuration; registration does not assign access. JSON pointers select records/fields; optional literal prefix/suffix extract one unambiguous text value. Discover existing recipes before creating duplicates.",
				async execute(id, input, signal, update, context) {
					if (!Compile(managerSchema).Check(input)) throw new Error("Invalid data tool request");
					if (input.action === "run") return run(id, input, signal, update, context);
					if (input.action === "list")
						return { content: [{ type: "text", text: JSON.stringify(registry.list()) }], details: undefined };
					const original =
						input.action === "configure"
							? registry.list().find((entry) => entry.tool === input.tool)?.recipe
							: input.recipe;
					if (!original) throw new Error("Provide a recipe to register, or an existing tool to configure");
					if (input.action === "configure" && !input.configuration)
						throw new Error("Provide the new configuration");
					const recipe = structuredClone(
						input.action === "configure" && input.configuration
							? {
									...original,
									...input.configuration,
									defaults: { ...original.defaults, ...input.configuration.defaults },
								}
							: original,
					);
					if (
						recipe.minRecords > recipe.maxRecords ||
						new Set(recipe.fields.map((field) => field.name)).size !== recipe.fields.length
					)
						throw new Error("Invalid record bounds or duplicate field names");
					if (
						Object.keys(recipe.defaults).some((key) =>
							/secret|access.?token|refresh.?token|password|api.?key|authorization|cookie/iu.test(key),
						)
					)
						throw new Error("Keep credentials in the source connection, not recipe defaults");
					const proof = await execute(recipe, input.values ?? {}, id, signal, update, context);
					const saved = await registry.queue.run(async () => {
						if (registry.entries.length >= 1000) throw new Error("Workspace data tool limit reached");
						const version =
							Math.max(
								0,
								...registry.entries
									.filter((entry) => entry.recipe.id === recipe.id)
									.map((entry) => entry.version),
							) + 1;
						const entry = { recipe, version, validatedAt: new Date().toISOString() };
						const next = [...registry.entries, entry];
						const temporary = join(registry.directory, `${randomUUID()}.tmp`);
						await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
						await rename(temporary, join(registry.directory, "registry.json"));
						registry.entries = next;
						return `saved_data_${recipe.id}_v${version}`;
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									tool: saved,
									source: recipe.source,
									assigned: false,
									sample: proof.content,
								}),
							},
						],
						details: undefined,
					};
				},
			});
		const registry = this;
		return tools;
	}
}
