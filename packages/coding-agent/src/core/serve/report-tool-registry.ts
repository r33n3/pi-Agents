import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Type, { type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GovernedActionService } from "./governed-action-service.ts";
import { createLocalScopedAgentFileOperations } from "./scoped-agent-tools.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const name = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,39}$" });
const field = Type.Object(
	{
		name,
		type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
		nullable: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const fields = Type.Array(field, { maxItems: 30 });
const definition = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_]{0,39}$" }),
		name: Type.String({ minLength: 1, maxLength: 100 }),
		description: Type.String({ minLength: 1, maxLength: 1000 }),
		template: Type.String({ minLength: 1, maxLength: 60000 }),
		fields,
		rows: Type.Array(Type.Object({ name, fields }, { additionalProperties: false }), { maxItems: 8 }),
		observationTtlHours: Type.Number({
			minimum: 0.01,
			maximum: 8760,
			description: "Inside definition. Freshness lifetime in hours; samples belong outside definition.",
		}),
	},
	{ additionalProperties: false },
);
type ReportDefinition = Static<typeof definition>;
const entrySchema = Type.Object({
	definition,
	version: Type.Integer({ minimum: 1 }),
	validatedAt: Type.String(),
	digest: Type.String(),
});
type Entry = Static<typeof entrySchema>;
const managerSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("list"), Type.Literal("register"), Type.Literal("run")]),
		definition: Type.Optional(definition),
		samples: Type.Optional(
			Type.Array(
				Type.Object(
					{
						data: Type.Record(Type.String(), Type.Unknown()),
						contains: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 20 }),
					},
					{ additionalProperties: false },
				),
				{ minItems: 2, maxItems: 5, description: "Top-level sibling of definition, never inside definition." },
			),
		),
		tool: Type.Optional(Type.String()),
		data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

function inputSchema(spec: ReportDefinition): TSchema {
	const properties: Record<string, TSchema> = {};
	for (const item of spec.fields) {
		if (Object.hasOwn(properties, item.name)) throw new Error("Duplicate report field");
		const value =
			item.type === "string"
				? Type.String({ maxLength: 8000 })
				: item.type === "number"
					? Type.Number()
					: Type.Boolean();
		properties[item.name] = item.nullable ? Type.Union([value, Type.Null()]) : value;
	}
	for (const row of spec.rows) {
		if (Object.hasOwn(properties, row.name)) throw new Error("Duplicate report row field");
		properties[row.name] = Type.Array(inputSchema({ ...spec, fields: row.fields, rows: [] }), { maxItems: 100 });
	}
	return Type.Object(properties, { additionalProperties: false });
}

/** Templates interpolate text only. There is no JavaScript evaluation or raw HTML interpolation. */
export function renderReport(spec: ReportDefinition, data: unknown, now = Date.now()): string {
	if (JSON.stringify(data).length > 256000 || !Compile(inputSchema(spec)).Check(data))
		throw new Error("Report data does not match the registered input fields");
	const values = data as Record<string, unknown>;
	const render = (template: string, scope: Record<string, unknown>, row = false): string => {
		let output = "";
		let position = 0;
		const tokens = /\{\{([^{}]+)\}\}/gu;
		for (let match = tokens.exec(template); match; match = tokens.exec(template)) {
			const before = template.slice(0, match.index);
			if (
				before.lastIndexOf("<") > before.lastIndexOf(">") ||
				before.toLowerCase().lastIndexOf("<style") > before.toLowerCase().lastIndexOf("</style>")
			)
				throw new Error("Report placeholders must occur in text, not HTML attributes or styles");
			output += template.slice(position, match.index);
			const token = match[1]!.trim();
			if (token.startsWith("#each ")) {
				const key = token.slice(6).trim();
				const end = template.indexOf("{{/each}}", tokens.lastIndex);
				if (row || end < 0 || !spec.rows.some((entry) => entry.name === key) || !Array.isArray(scope[key]))
					throw new Error("Invalid report each block");
				const body = template.slice(tokens.lastIndex, end);
				output += (scope[key] as Record<string, unknown>[]).map((entry) => render(body, entry, true)).join("");
				tokens.lastIndex = end + "{{/each}}".length;
			} else {
				const freshness = token.startsWith("freshness ");
				const key = freshness ? token.slice(10).trim() : token;
				if (!/^[a-zA-Z][a-zA-Z0-9_]*$/u.test(key) || !Object.hasOwn(scope, key))
					throw new Error(`Unknown report field: ${key}`);
				let value = scope[key];
				if (freshness) {
					const time = typeof value === "string" ? Date.parse(value) : NaN;
					value =
						!Number.isFinite(time) || time > now
							? "Unverified observation"
							: now - time > spec.observationTtlHours * 3600000
								? "Stale observation"
								: "Recent observation — verify source";
				}
				if (value !== null && !["string", "number", "boolean"].includes(typeof value))
					throw new Error("Report text field must be scalar");
				output += String(value ?? "Unavailable").replace(
					/[&<>"']/gu,
					(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
				);
			}
			position = tokens.lastIndex;
			if (output.length > 900000) throw new Error("Rendered report exceeds size limit");
		}
		output += template.slice(position);
		return output;
	};
	// This is a static document contract, not an HTML sanitizer for arbitrary executable documents.
	if (/<\s*(?:script|iframe|object|embed|form|base|link)\b|\bon\w+\s*=|javascript\s*:/iu.test(spec.template))
		throw new Error("Report templates must be static HTML without scripts, forms or event handlers");
	const html = render(spec.template, values);
	if (Buffer.byteLength(html) > 900000) throw new Error("Rendered report exceeds size limit");
	return html;
}

/** Immutable report versions are shared; executing and writing remain caller-scoped grants. */
export class ReportToolRegistry {
	private entries: Entry[] = [];
	private readonly directory: string;
	private readonly queue = new SerialOperationQueue();
	constructor(directory: string) {
		this.directory = directory;
	}
	async initialize() {
		await mkdir(this.directory, { recursive: true });
		try {
			const stored: unknown = JSON.parse(await readFile(join(this.directory, "registry.json"), "utf8"));
			if (!Compile(Type.Array(entrySchema, { maxItems: 1000 })).Check(stored))
				throw new Error("Invalid report registry");
			this.entries = stored;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	list() {
		return structuredClone(this.entries).map((entry) => ({
			...entry,
			tool: `saved_report_${entry.definition.id}_v${entry.version}`,
		}));
	}
	createTools(
		assigned: readonly string[] | undefined,
		workspace: string,
		governed: GovernedActionService,
	): ToolDefinition[] {
		const registry = this;
		const run = async (tool: string, data: unknown, signal?: AbortSignal) => {
			if (assigned && (!assigned.includes(tool) || !assigned.includes("write")))
				throw new Error("Assign the saved report tool and workspace write access to this member");
			const entry = registry.list().find((item) => item.tool === tool);
			if (!entry) throw new Error("Unknown saved report tool");
			const html = renderReport(entry.definition, data);
			const path = `reports/${tool}/${randomUUID()}.html`;
			const digest = createHash("sha256").update(html).digest("hex");
			const result = await governed.execute({
				family: "filesystem.write",
				target: { workspace, path, digest, tool },
				canonicalize: (target) => target,
				authorize: () => ({
					decision: signal?.aborted ? "deny" : "allow",
					reason: "Assigned report renderer and workspace write grant",
					grant: tool,
				}),
				dispatch: async () => {
					signal?.throwIfAborted();
					return createLocalScopedAgentFileOperations(workspace).write(path, html);
				},
			});
			if (result.status === "denied") throw new Error(result.reason);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							tool,
							reportPath: path,
							sha256: digest,
							bytes: result.value,
							validation: "rendered-from-typed-input; not factual verification",
						}),
					},
				],
				details: undefined,
			};
		};
		const tools: ToolDefinition[] = this.list()
			.filter((entry) => !assigned || assigned.includes(entry.tool))
			.map((entry) => ({
				name: entry.tool,
				label: entry.definition.name,
				description: `${entry.definition.description} Renders this immutable template from typed data and saves an HTML report. Requires workspace write; returns reportPath and hash for presentation or email.draft. No shell or sending access.`,
				parameters: Type.Object({ data: inputSchema(entry.definition) }, { additionalProperties: false }),
				async execute(_id, input, signal) {
					return run(entry.tool, (input as { data: unknown }).data, signal);
				},
			}));
		if (!assigned || assigned.includes("report_tools"))
			tools.push({
				name: "report_tools",
				label: "Reusable report tools",
				parameters:
					assigned && !assigned.some((id) => id.startsWith("saved_report_") && assigned.includes("write"))
						? Type.Object(
								{
									...managerSchema.properties,
									action: Type.Union([Type.Literal("list"), Type.Literal("register")]),
								},
								{ additionalProperties: false },
							)
						: managerSchema,
				description:
					"List or register immutable HTML report templates. Call list for a valid registration example. Registration shape: {action:'register',definition:{id,name,description,template,fields,rows,observationTtlHours},samples:[{data,contains},{data,contains}]}. samples is top-level; observationTtlHours is inside definition. No minRecords field. Correct validation errors and retry within this turn. Use {{field}} for escaped text and {{#each rowsName}}...{{/each}} for row arrays, no nesting. {{freshness observedAt}} marks null/invalid/future timestamps unverified and old observations stale. Declare every scalar field with type string/number/boolean and nullable:true for unavailable values. All declared fields are required; pass null for unavailable values. Placeholders belong only in text, not attributes/styles. Registration executes at least two distinct sample data objects with contains assertions and returns the saved tool ID. Assign that ID and write to the reporting member via the supervisor, then that member calls it with data to save HTML and receives reportPath. Registration is not assignment. Use run only after the saved ID is assigned. No executable scripts, credentials or email sending.",
				async execute(_id, input, signal) {
					if (!Compile(managerSchema).Check(input)) throw new Error("Invalid report tool request");
					signal?.throwIfAborted();
					if (input.action === "list")
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify({
										tools: registry.list(),
										registrationExample: {
											action: "register",
											definition: {
												id: "example_report",
												name: "Example report",
												description: "Render observations",
												template:
													"<h1>{{title}}</h1>{{#each options}}<p>{{fare}} — {{freshness observedAt}}</p>{{/each}}",
												fields: [{ name: "title", type: "string" }],
												rows: [
													{
														name: "options",
														fields: [
															{ name: "fare", type: "number", nullable: true },
															{ name: "observedAt", type: "string", nullable: true },
														],
													},
												],
												observationTtlHours: 2,
											},
											samples: [
												{
													data: { title: "First sample", options: [{ fare: null, observedAt: null }] },
													contains: ["Unavailable", "Unverified observation"],
												},
												{
													data: {
														title: "Second sample",
														options: [{ fare: 125, observedAt: "2000-01-01T00:00:00Z" }],
													},
													contains: ["125", "Stale observation"],
												},
											],
										},
									}),
								},
							],
							details: undefined,
						};
					if (input.action === "run") return run(input.tool ?? "", input.data, signal);
					if (!input.definition || !input.samples)
						throw new Error("Registration requires a definition and at least two samples");
					const spec = structuredClone(input.definition);
					if (new Set(input.samples.map((sample) => JSON.stringify(sample.data))).size < 2)
						throw new Error("Use distinct sample inputs");
					for (const [index, sample] of input.samples.entries()) {
						const html = renderReport(spec, sample.data);
						const missing = sample.contains.filter((text) => !html.includes(text));
						if (missing.length)
							throw new Error(
								`Report sample ${index + 1} assertion failed: missing ${JSON.stringify(missing)}. Rendered HTML (first 8000 characters): ${html.slice(0, 8000)}. Nothing registered. Correct the template or expected escaped HTML text and retry registration in this turn; preserve the requested validation cases.`,
							);
					}
					const saved = await registry.queue.run(async () => {
						signal?.throwIfAborted();
						if (registry.entries.length >= 1000) throw new Error("Report registry limit reached");
						const version =
							Math.max(
								0,
								...registry.entries
									.filter((item) => item.definition.id === spec.id)
									.map((item) => item.version),
							) + 1;
						const entry = {
							definition: spec,
							version,
							validatedAt: new Date().toISOString(),
							digest: createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
						};
						const next = [...registry.entries, entry];
						const temporary = join(registry.directory, `${randomUUID()}.tmp`);
						await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
						await rename(temporary, join(registry.directory, "registry.json"));
						registry.entries = next;
						return `saved_report_${spec.id}_v${version}`;
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									tool: saved,
									assigned: false,
									samplesPassed: input.samples.length,
									next: "Supervisor assigns the saved tool ID and write to the reporting member; that member invokes it with new data.",
								}),
							},
						],
						details: undefined,
					};
				},
			});
		return tools;
	}
}
