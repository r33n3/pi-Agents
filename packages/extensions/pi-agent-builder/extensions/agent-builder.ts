import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../lib/agents.ts";
import { scheduleAgent } from "./agent-schedule.ts";
import { applyPersonaToAgent, fetchPersona } from "./persona.ts";

const MEMORY_STRATEGIES = ["none", "notes", "mempalace"] as const;
const MEMORY_TOOLS: Record<string, string[]> = {
	notes: ["remember", "recall"],
	mempalace: ["mempalace_remember", "mempalace_recall"],
};

interface AgentModelCatalogEntry {
	provider: string;
	id: string;
	name?: string;
}

function normalizedModelLabel(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function canonicalAgentModelReference(
	value: string,
	models: readonly AgentModelCatalogEntry[],
): string {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`Invalid agent model "${value}". Use the canonical provider/model-id format.`);
	}
	const provider = value.slice(0, separator).trim();
	const modelId = value.slice(separator + 1).trim();
	const exact = models.find((model) => model.provider === provider && model.id === modelId);
	if (exact) return `${exact.provider}/${exact.id}`;

	const requestedLabel = normalizedModelLabel(modelId);
	const matches = models.filter(
		(model) =>
			model.provider.toLowerCase() === provider.toLowerCase() &&
			(normalizedModelLabel(model.id) === requestedLabel ||
				(model.name !== undefined && normalizedModelLabel(model.name) === requestedLabel)),
	);
	if (matches.length === 1) return `${matches[0].provider}/${matches[0].id}`;
	throw new Error(`Agent model ${value} is unavailable. Select an exact provider/model ID from the model catalog.`);
}

function agentsDir(): string {
	const dir = join(getAgentDir(), "agents");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function validateAgentName(name: string): string {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
		throw new Error(`Invalid agent name "${name}". Use lowercase-kebab-case.`);
	}
	return name;
}

function serializeFrontmatter(fields: Record<string, string | undefined>): string {
	return Object.entries(fields)
		.filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "")
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
}

function parsedFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	const fields: Record<string, string> = {};
	for (const line of (match?.[1] ?? "").split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator !== -1) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
	}
	return { fields, body: match?.[2] ?? raw };
}

const configureAgentTool = defineTool({
	name: "configure_agent",
	label: "Configure Agent",
	description:
		"Create or update a reusable local agent. Omitted fields remain unchanged. Scheduling requires a user-confirmed cadence and replaces the existing schedule unless the user explicitly requests an additional one.",
	parameters: Type.Object({
		name: Type.String({ description: "Lowercase-kebab-case agent identifier" }),
		description: Type.Optional(Type.String({ description: "One-line purpose" })),
		model: Type.Optional(Type.String({ description: "Canonical provider/model ID from the model catalog" })),
		tools: Type.Optional(Type.String({ description: "Comma-separated pi tool allowlist" })),
		memory: Type.Optional(Type.Union(MEMORY_STRATEGIES.map((strategy) => Type.Literal(strategy)))),
		persona: Type.Optional(Type.String({ description: "Persona catalog identifier, matched case-insensitively" })),
		systemPrompt: Type.Optional(Type.String({ description: "Agent instructions" })),
		scheduleTask: Type.Optional(
			Type.String({ description: "Task for each scheduled run; requires an explicitly confirmed cadence" }),
		),
		scheduleCadence: Type.Optional(
			Type.String({
				description:
					'User-confirmed cadence such as "daily 09:00", "weekly Mon 08:00", "hourly", or "every 30m"',
			}),
		),
		scheduleConfirmed: Type.Optional(
			Type.Boolean({ description: "Must be true only after the user explicitly selected or confirmed the cadence" }),
		),
		scheduleMode: Type.Optional(
			Type.Union([Type.Literal("replace"), Type.Literal("additional")], {
				description:
					'"replace" keeps one schedule for the agent; use "additional" only when the user explicitly requests multiple schedules',
			}),
		),
	}),
	async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
		const name = validateAgentName(parameters.name);
		const existing = discoverAgents(context.cwd, "user").find((agent) => agent.name === name);
		const filePath = existing?.filePath ?? join(agentsDir(), `${name}.md`);
		const persona = parameters.persona ? await fetchPersona(parameters.persona) : undefined;
		const parsed = existing ? parsedFrontmatter(readFileSync(filePath, "utf-8")) : { fields: {}, body: "\n" };
		const requestedModel =
			parameters.model ??
			parsed.fields.model ??
			(existing || !context.model ? undefined : `${context.model.provider}/${context.model.id}`);
		const frontmatter: Record<string, string | undefined> = {
			name,
			description: parameters.description ?? parsed.fields.description ?? `Agent "${name}"`,
			model: requestedModel
				? canonicalAgentModelReference(requestedModel, context.modelRegistry.getAll())
				: undefined,
			tools: parameters.tools ?? parsed.fields.tools,
			memory: parameters.memory ?? parsed.fields.memory ?? "none",
		};

		const tools = new Set((frontmatter.tools ?? "").split(",").map((tool) => tool.trim()).filter(Boolean));
		for (const names of Object.values(MEMORY_TOOLS)) for (const tool of names) tools.delete(tool);
		for (const tool of MEMORY_TOOLS[frontmatter.memory ?? "none"] ?? []) tools.add(tool);
		frontmatter.tools = tools.size ? [...tools].join(",") : undefined;

		let body = parsed.body;
		if (parameters.systemPrompt !== undefined) {
			const personaBlock = body.match(/<!-- persona:start[\s\S]*<!-- persona:end -->\n?/)?.[0] ?? "";
			body = `${parameters.systemPrompt.trim()}\n\n${personaBlock}`;
		}
		const hasScheduleTask = parameters.scheduleTask !== undefined;
		const hasScheduleCadence = parameters.scheduleCadence !== undefined;
		if (hasScheduleTask !== hasScheduleCadence) {
			throw new Error("Scheduling requires both scheduleTask and scheduleCadence.");
		}
		if (hasScheduleTask && parameters.scheduleConfirmed !== true) {
			throw new Error("Do not choose a schedule for the user. Ask them to select or confirm the cadence first.");
		}

		writeFileSync(filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`, "utf-8");

		if (persona) {
			const target = discoverAgents(context.cwd, "user").find((agent) => agent.name === name);
			if (!target) throw new Error(`Agent "${name}" was written but could not be reloaded.`);
			applyPersonaToAgent(target, persona);
		}

		const action = existing ? "Updated" : "Created";
		const personaResult = persona ? ` Applied persona "${persona.name}".` : "";
		let scheduleResult = "";
		if (parameters.scheduleTask && parameters.scheduleCadence) {
			const result = await scheduleAgent(
				name,
				parameters.scheduleTask,
				parameters.scheduleCadence,
				parameters.scheduleMode ?? "replace",
			);
			scheduleResult = result.unchanged
				? ` Schedule "${result.manifest.taskName}" was already ${result.manifest.cadence}; no duplicate was created.`
				: ` ${parameters.scheduleMode === "additional" ? "Added" : "Saved"} schedule "${result.manifest.taskName}" (${result.manifest.cadence}).${result.replaced > 0 ? ` Removed ${result.replaced} superseded schedule${result.replaced === 1 ? "" : "s"}.` : ""}`;
		}
		return {
			content: [{ type: "text", text: `${action} agent "${name}".${personaResult}${scheduleResult}` }],
			details: { filePath },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(configureAgentTool);
}

export { validateAgentName };
