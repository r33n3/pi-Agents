import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		try {
			const { frontmatter, body } = parseFrontmatter<Record<string, string>>(fs.readFileSync(filePath, "utf-8"));
			if (!frontmatter.name || !frontmatter.description) continue;
			const tools = frontmatter.tools?.split(",").map((tool) => tool.trim()).filter(Boolean);
			agents.push({
				name: frontmatter.name,
				description: frontmatter.description,
				tools: tools?.length ? tools : undefined,
				model: frontmatter.model,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch {
			// A malformed or unreadable agent is omitted from discovery.
		}
	}
	return agents;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// Continue toward the filesystem root.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
	const projectDir = nearestProjectAgentsDir(cwd);
	const projectAgents = scope === "user" || !projectDir ? [] : loadAgentsFromDir(projectDir, "project");
	const agents = new Map<string, AgentConfig>();
	for (const agent of userAgents) agents.set(agent.name, agent);
	for (const agent of projectAgents) agents.set(agent.name, agent);
	return [...agents.values()];
}
