import { basename } from "node:path";
import type { AgentSession } from "../agent-session.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BrowserConsoleService } from "./browser-console-service.ts";
import type { ExternalConnectionManager } from "./external-connection-manager.ts";

export interface CapabilityEntry {
	id: string;
	name: string;
	description: string;
	status: "active" | "available" | "unavailable";
	scope: string;
	source?: string;
	path?: string;
}

export interface CapabilitySnapshot {
	tools: CapabilityEntry[];
	skills: CapabilityEntry[];
	extensions: CapabilityEntry[];
	mcpServers: CapabilityEntry[];
	acpConnections: CapabilityEntry[];
	modelProviders: CapabilityEntry[];
}

/** Builds a fresh, secret-free view of capabilities loaded into this Pi process. */
export class CapabilityCatalog {
	readonly #session: AgentSession;
	readonly #externalConnections: ExternalConnectionManager | undefined;
	readonly #browserConsole: BrowserConsoleService | undefined;

	constructor(
		session: AgentSession,
		externalConnections?: ExternalConnectionManager,
		browserConsole?: BrowserConsoleService,
	) {
		this.#session = session;
		this.#externalConnections = externalConnections;
		this.#browserConsole = browserConsole;
	}

	list(): CapabilitySnapshot {
		const activeTools = new Set(this.#session.getActiveToolNames());
		const tools: CapabilityEntry[] = this.#session.getAllTools().map((tool) => ({
			id: tool.name,
			name: tool.name,
			description: tool.description,
			status: activeTools.has(tool.name) ? ("active" as const) : ("available" as const),
			...sourceFields(tool.sourceInfo),
		}));
		if (this.#browserConsole) {
			const browser = this.#browserConsole.status();
			tools.push({
				id: "managed-chromium",
				name: "Managed Chromium",
				description: browser.installed
					? `${browser.sessionCount} active browser session${browser.sessionCount === 1 ? "" : "s"}`
					: "Install with pi browser install chromium",
				status: browser.installed ? ("available" as const) : ("unavailable" as const),
				scope: "serve host",
				source: "Playwright",
			});
		}
		const skills = this.#session.resourceLoader.getSkills().skills.map((skill) => ({
			id: skill.name,
			name: skill.name,
			description: skill.description,
			status: "available" as const,
			...sourceFields(skill.sourceInfo),
		}));
		const extensions = this.#session.resourceLoader.getExtensions().extensions.map((extension) => ({
			id: extension.resolvedPath,
			name: extension.path.startsWith("<") ? extension.path : basename(extension.path),
			description: `${extension.tools.size} tools · ${extension.commands.size} commands`,
			status: "active" as const,
			...sourceFields(extension.sourceInfo),
		}));
		const acpConnections = (this.#externalConnections?.listConnections() ?? []).map((connection) => ({
			id: connection.id,
			name: connection.name,
			description: connection.description,
			status: connection.available ? ("available" as const) : ("unavailable" as const),
			scope: "process",
			source: "ACP connector",
		}));
		const providers = new Map<string, { models: number; authenticated: boolean; apiTypes: Set<string> }>();
		for (const model of this.#session.modelRuntime.getAvailableSnapshot()) {
			const current = providers.get(model.provider) ?? { models: 0, authenticated: false, apiTypes: new Set() };
			current.models += 1;
			current.authenticated ||= this.#session.modelRuntime.hasConfiguredAuth(model.provider);
			current.apiTypes.add(model.api);
			providers.set(model.provider, current);
		}
		const modelProviders = [...providers].map(([provider, summary]) => ({
			id: provider,
			name: provider,
			description: `${summary.models} models · ${[...summary.apiTypes].join(", ")} · credentials ${summary.authenticated ? "configured" : "not configured"}`,
			status: summary.authenticated ? ("available" as const) : ("unavailable" as const),
			scope: "user",
			source: "model runtime",
		}));
		return { tools, skills, extensions, mcpServers: [], acpConnections, modelProviders };
	}
}

function sourceFields(sourceInfo: SourceInfo | undefined): { scope: string; source?: string; path?: string } {
	return sourceInfo
		? { scope: sourceInfo.scope, source: sourceInfo.source, path: sourceInfo.path }
		: { scope: "session", source: "built-in" };
}
