import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "../lib/agents.ts";
import { applyPersonaToAgent, fetchPersona } from "./persona.ts";

const MEMORY_STRATEGIES = ["none", "notes", "mempalace"] as const;
const MEMORY_TOOLS: Record<string, string[]> = {
	notes: ["remember", "recall"],
	mempalace: ["mempalace_remember", "mempalace_recall"],
};

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
		"Create or update a reusable local agent. Omitted fields remain unchanged. Use pi --serve for routines and workflows.",
	parameters: Type.Object({
		name: Type.String({ description: "Lowercase-kebab-case agent identifier" }),
		description: Type.Optional(Type.String({ description: "One-line purpose" })),
		model: Type.Optional(Type.String({ description: "Provider and model identifier" })),
		tools: Type.Optional(Type.String({ description: "Comma-separated pi tool allowlist" })),
		memory: Type.Optional(Type.Union(MEMORY_STRATEGIES.map((strategy) => Type.Literal(strategy)))),
		persona: Type.Optional(Type.String({ description: "Persona catalog identifier, matched case-insensitively" })),
		systemPrompt: Type.Optional(Type.String({ description: "Agent instructions" })),
	}),
	async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
		const name = validateAgentName(parameters.name);
		const existing = discoverAgents(context.cwd, "user").find((agent) => agent.name === name);
		const filePath = existing?.filePath ?? join(agentsDir(), `${name}.md`);
		const persona = parameters.persona ? await fetchPersona(parameters.persona) : undefined;
		const parsed = existing ? parsedFrontmatter(readFileSync(filePath, "utf-8")) : { fields: {}, body: "\n" };
		const frontmatter: Record<string, string | undefined> = {
			name,
			description: parameters.description ?? parsed.fields.description ?? `Agent "${name}"`,
			model: parameters.model ?? parsed.fields.model,
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
		writeFileSync(filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n${body}`, "utf-8");

		if (persona) {
			const target = discoverAgents(context.cwd, "user").find((agent) => agent.name === name);
			if (!target) throw new Error(`Agent "${name}" was written but could not be reloaded.`);
			applyPersonaToAgent(target, persona);
		}

		const action = existing ? "Updated" : "Created";
		const personaResult = persona ? ` Applied persona "${persona.name}".` : "";
		return { content: [{ type: "text", text: `${action} agent "${name}".${personaResult}` }], details: { filePath } };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(configureAgentTool);
}

export { validateAgentName };
