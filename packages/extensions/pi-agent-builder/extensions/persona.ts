import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig } from "../lib/agents.ts";
import { normalizePersonaName } from "../lib/persona-name.ts";

const REPO_RAW = "https://raw.githubusercontent.com/r33n3/Personas/main";
const REPO_API = "https://api.github.com/repos/r33n3/Personas";
const PERSONA_END = "<!-- persona:end -->";

export interface CachedPersona {
	name: string;
	description?: string;
	skillBody: string;
}

function personasDir(): string {
	const dir = join(getAgentDir(), "personas");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}

function splitFrontmatter(raw: string): { frontmatter: string | undefined; body: string } {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	return match ? { frontmatter: match[1], body: match[2] } : { frontmatter: undefined, body: raw };
}

function cachedPersonaNames(): string[] {
	try {
		return readdirSync(personasDir(), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function loadCachedPersona(name: string): CachedPersona | undefined {
	const skillPath = join(personasDir(), name, "SKILL.md");
	if (!existsSync(skillPath)) return undefined;
	const { body } = splitFrontmatter(readFileSync(skillPath, "utf-8"));
	const descriptionPath = join(personasDir(), name, "persona.yaml");
	const description = existsSync(descriptionPath)
		? readFileSync(descriptionPath, "utf-8").match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "")
		: undefined;
	return { name, description, skillBody: body.trim() };
}

export async function fetchPersona(name: string): Promise<CachedPersona> {
	const normalizedName = normalizePersonaName(name);
	const cached = loadCachedPersona(normalizedName);
	if (cached) return cached;

	const skillResponse = await fetch(`${REPO_RAW}/personas/${normalizedName}/SKILL.md`);
	if (!skillResponse.ok) {
		throw new Error(`Persona "${normalizedName}" not found in r33n3/Personas (HTTP ${skillResponse.status}).`);
	}

	const dir = join(personasDir(), normalizedName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), await skillResponse.text(), "utf-8");

	const metadataResponse = await fetch(`${REPO_RAW}/personas/${normalizedName}/persona.yaml`);
	if (metadataResponse.ok) writeFileSync(join(dir, "persona.yaml"), await metadataResponse.text(), "utf-8");

	const iconResponse = await fetch(`${REPO_RAW}/site/public/images/${normalizedName}.webp`);
	if (iconResponse.ok) writeFileSync(join(dir, "icon.webp"), Buffer.from(await iconResponse.arrayBuffer()));

	const loaded = loadCachedPersona(normalizedName);
	if (!loaded) throw new Error(`Fetched "${normalizedName}" but failed to parse SKILL.md.`);
	return loaded;
}

export async function fetchCatalog(): Promise<string[]> {
	const response = await fetch(`${REPO_API}/contents/personas`);
	if (!response.ok) throw new Error(`Could not list persona catalog (HTTP ${response.status}).`);
	const entries = (await response.json()) as Array<{ name: string; type: string }>;
	return entries.filter((entry) => entry.type === "dir").map((entry) => entry.name).sort();
}

export function applyPersonaToAgent(agent: AgentConfig, persona: CachedPersona): void {
	const raw = readFileSync(agent.filePath, "utf-8");
	const { frontmatter, body } = splitFrontmatter(raw);
	if (frontmatter === undefined) throw new Error(`${agent.filePath} has no frontmatter block.`);
	const personaBlock = `<!-- persona:start name=${persona.name} -->\n\n${persona.skillBody}\n\n${PERSONA_END}\n`;
	const withoutPersona = body.replace(/<!-- persona:start name=[^>]* -->[\s\S]*?<!-- persona:end -->\n?/, "").trimEnd();
	writeFileSync(agent.filePath, `---\n${frontmatter}\n---\n${withoutPersona}\n\n${personaBlock}`, "utf-8");
}

function removePersonaFromAgent(agent: AgentConfig): boolean {
	const raw = readFileSync(agent.filePath, "utf-8");
	const { frontmatter, body } = splitFrontmatter(raw);
	if (frontmatter === undefined) return false;
	const pattern = /\n*<!-- persona:start name=[^>]* -->[\s\S]*?<!-- persona:end -->\n?/;
	if (!pattern.test(body)) return false;
	writeFileSync(agent.filePath, `---\n${frontmatter}\n---\n${body.replace(pattern, "").trimEnd()}\n`, "utf-8");
	return true;
}

function currentPersonaName(agent: AgentConfig): string | undefined {
	return readFileSync(agent.filePath, "utf-8").match(/<!-- persona:start name=([^>\s]+) -->/)?.[1];
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("persona", {
		description: "Apply a persona from r33n3/Personas to a local agent",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const agents = discoverAgents(ctx.cwd, "both");
			if (agents.length === 0) {
				ctx.ui.notify(`No agents found under ${join(getAgentDir(), "agents")}.`, "warning");
				return;
			}

			if (parts[0] === "apply" && parts[1] && parts[2]) {
				const agent = agents.find((entry) => entry.name === parts[1]);
				if (!agent) return ctx.ui.notify(`No agent named "${parts[1]}".`, "error");
				try {
					const persona = await fetchPersona(parts[2]);
					applyPersonaToAgent(agent, persona);
					ctx.ui.notify(`Applied persona "${persona.name}" to agent "${agent.name}".`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			if (parts[0] === "remove" && parts[1]) {
				const agent = agents.find((entry) => entry.name === parts[1]);
				if (!agent) return ctx.ui.notify(`No agent named "${parts[1]}".`, "error");
				const removed = removePersonaFromAgent(agent);
				ctx.ui.notify(removed ? `Removed persona from "${agent.name}".` : `"${agent.name}" has no persona.`, "info");
				return;
			}

			const labels = agents.map((agent) => {
				const persona = currentPersonaName(agent);
				return `${agent.name} (${agent.source})${persona ? ` — persona: ${persona}` : ""}`;
			});
			const selectedLabel = await ctx.ui.select("Apply a persona to which agent?", labels);
			if (!selectedLabel) return;
			const selectedAgent = agents[labels.indexOf(selectedLabel)];
			const existingPersona = currentPersonaName(selectedAgent);
			const options = [
				...cachedPersonaNames().map((name) => `${name} (cached)`),
				"Browse catalog...",
				...(existingPersona ? ["Remove current persona"] : []),
			];
			const selectedPersona = await ctx.ui.select(`Persona for ${selectedAgent.name}`, options);
			if (!selectedPersona) return;
			if (selectedPersona === "Remove current persona") {
				removePersonaFromAgent(selectedAgent);
				ctx.ui.notify(`Removed persona from "${selectedAgent.name}".`, "info");
				return;
			}

			try {
				const personaName =
					selectedPersona === "Browse catalog..."
						? await ctx.ui.select("Persona catalog (r33n3/Personas)", await fetchCatalog())
						: selectedPersona.replace(/ \(cached\)$/, "");
				if (!personaName) return;
				const persona = await fetchPersona(personaName);
				applyPersonaToAgent(selectedAgent, persona);
				ctx.ui.notify(`Applied persona "${persona.name}" to agent "${selectedAgent.name}".`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
