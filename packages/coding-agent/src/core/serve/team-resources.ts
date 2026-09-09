import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentDefinition } from "./agent-registry.ts";
import { createAgentExecutionConfigurationSeed } from "./agent-run-configuration-snapshot.ts";
import type { BrowserSetupStore } from "./browser-setup-store.ts";
import type { BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import type { AgentCapabilityGrant, CapabilityBroker } from "./capability-broker.ts";
import type { CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import type { DataToolRegistry } from "./data-tool-registry.ts";
import type { ReportToolRegistry } from "./report-tool-registry.ts";

export interface TeamToolOption {
	id: string;
	name: string;
	description: string;
	tools: string[];
	capabilities: AgentCapabilityGrant[];
	browser?: AgentDefinition["browser"];
	workflow?: AgentDefinition["browserWorkflows"][number];
}

/** Projects only executable environment tools; grants are revalidated for every turn. */
export class TeamResources {
	constructor(
		broker?: CapabilityBroker,
		connections?: CapabilityConnectionRegistry,
		defaultModel?: ModelRef,
		browser?: { setup: BrowserSetupStore; workflows: BrowserWorkflowRegistry },
		dataTools?: DataToolRegistry,
		reportTools?: ReportToolRegistry,
	) {
		this.broker = broker;
		this.connections = connections;
		this.defaultModel = defaultModel;
		this.browser = browser;
		this.dataTools = dataTools;
		this.reportTools = reportTools;
	}
	private readonly broker: CapabilityBroker | undefined;
	private readonly connections: CapabilityConnectionRegistry | undefined;
	private readonly defaultModel: ModelRef | undefined;
	private readonly browser: { setup: BrowserSetupStore; workflows: BrowserWorkflowRegistry } | undefined;
	private readonly dataTools: DataToolRegistry | undefined;
	private readonly reportTools: ReportToolRegistry | undefined;

	list(): TeamToolOption[] {
		const options: TeamToolOption[] = [
			{
				id: "read",
				name: "Read workspace files",
				description: "Read files confined to the agent workspace.",
				tools: ["read"],
				capabilities: [],
			},
			{
				id: "ls",
				name: "List workspace files",
				description: "Find the files available in the workspace.",
				tools: ["list"],
				capabilities: [],
			},
			{
				id: "write",
				name: "Write workspace files",
				description: "Create or replace files within the workspace.",
				tools: ["write"],
				capabilities: [],
			},
		];
		options.push(
			{
				id: "edit",
				name: "Edit workspace files",
				description: "Make precise replacements using Pi's edit tool.",
				tools: ["edit"],
				capabilities: [],
			},
			{
				id: process.platform === "win32" ? "powershell" : "bash",
				name: "Run host commands",
				description:
					"Run programs, tests and installers as the server user. Includes access outside the workspace; enable only for trusted agents.",
				tools: [process.platform === "win32" ? "powershell" : "bash"],
				capabilities: [],
			},
		);
		if (this.browser) {
			options.push(
				{
					id: "browser_present",
					name: "Present report in side browser",
					description:
						"Display a workspace report beside the conversation; no signed-in profile or website interaction.",
					tools: ["browser_present"],
					capabilities: [],
				},
				{
					id: "browser_setup",
					name: "Configure browser profiles and sites",
					description:
						"Save requested reusable browser profiles and site preferences. Does not assign them to agents or configure credentials.",
					tools: ["browser_setup"],
					capabilities: [],
				},
				{
					id: "browser:public-web",
					name: "Browse public websites (fresh session)",
					description: "Navigate and interact with public websites without saved sign-ins.",
					tools: ["browser"],
					capabilities: [],
					browser: { access: "public-web", runtime: "managed-chromium", profile: { kind: "ephemeral" } },
				},
			);
			for (const profile of this.browser.setup.snapshot().profiles)
				options.push({
					id: `browser-profile:${profile.id}`,
					name: `Browser: ${profile.name}`,
					description: `Reuse saved sign-ins and preferences. Access: ${profile.access}; engine: ${profile.runtime}. One active session at a time; close the browser when finished.`,
					tools: ["browser"],
					capabilities: [],
					browser: {
						access: profile.access,
						runtime: profile.runtime,
						profile: { kind: "named", id: profile.id },
					},
				});
			for (const site of this.browser.setup.snapshot().sites)
				options.push({
					id: `site:${site.id}`,
					name: `Site: ${site.name}`,
					description: `Preferred interface: ${site.mode}; ${site.url}. Browser or connection access is assigned separately.`,
					tools: [`site:${site.id}`],
					capabilities: [],
				});
			for (const workflow of this.browser.workflows.list().filter((entry) => entry.status === "active"))
				options.push({
					id: `browser-workflow:${workflow.id}:${workflow.version}`,
					name: `Workflow: ${workflow.name}`,
					description:
						"Execute this exact active workflow version. Requires a browser profile with matching access.",
					tools: [],
					capabilities: [],
					workflow: { id: workflow.id, version: workflow.version },
				});
		}
		if (this.dataTools) {
			options.push({
				id: "data_tools",
				name: "Create reusable data tools",
				description:
					"Discover and validate reusable extraction recipes using separately assigned source readers. Does not grant source access or assign tools.",
				tools: ["data_tools"],
				capabilities: [],
			});
			for (const entry of this.dataTools.list())
				options.push({
					id: entry.tool,
					name: entry.recipe.name,
					description: `${entry.recipe.description} Version ${entry.version}; requires separately assigned ${entry.recipe.source}.`,
					tools: [entry.tool],
					capabilities: [],
				});
		}
		if (this.reportTools) {
			options.push({
				id: "report_tools",
				name: "Create reusable report tools",
				description:
					"Design and test reusable HTML templates with typed inputs. Register a version, then assign its saved tool ID and write to the reporting member. No shell needed for rendering.",
				tools: ["report_tools"],
				capabilities: [],
			});
			for (const entry of this.reportTools.list())
				options.push({
					id: entry.tool,
					name: entry.definition.name,
					description: `${entry.definition.description} Version ${entry.version}; renders typed data to a saved HTML report. Requires workspace write.`,
					tools: [entry.tool],
					capabilities: [],
				});
		}
		const snapshot = this.broker?.snapshot();
		if (!snapshot) return options;
		for (const capability of snapshot.capabilities) {
			for (const provider of snapshot.providers.filter((entry) => entry.enabled)) {
				if (provider.authentication && !provider.authentication.configured) continue;
				const binding = provider.bindings.find(
					(entry) => entry.capabilityId === capability.id && entry.executors.includes("harness"),
				);
				if (!binding?.toolName) continue;
				const accounts = provider.connectionRequired
					? (this.connections?.snapshot() ?? []).filter(
							(entry) =>
								entry.providerId === provider.id &&
								entry.status === "active" &&
								entry.capabilityIds.includes(capability.id),
						)
					: [undefined];
				for (const account of accounts) {
					const grant: AgentCapabilityGrant = {
						capabilityId: capability.id,
						capabilityVersion: capability.version,
						providerId: provider.id,
						connectionId: account?.id,
					};
					try {
						this.broker!.validateGrants([grant], "harness");
					} catch {
						continue;
					}
					options.push({
						id: `${provider.id}:${capability.id}${account ? `:${account.id}` : ""}`,
						name: `${capability.name}${account ? ` (${account.accountLabel})` : ""}`,
						description: capability.description,
						tools: [],
						capabilities: [grant],
					});
				}
			}
		}
		return options;
	}

	validate(ids: readonly string[]): TeamToolOption[] {
		const available = this.list();
		const selected = ids.map((id) => {
			const tool = available.find((entry) => entry.id === id);
			if (!tool) throw new Error(`Team tool ${id} is unavailable. Review the team's tools.`);
			return tool;
		});
		return selected;
	}

	/** Discovery includes setup instructions; unavailable entries never become execution grants. */
	catalog(): Array<{ id: string; name: string; description: string; setup?: string }> {
		const available = this.list();
		const catalog: Array<{ id: string; name: string; description: string; setup?: string }> = available.map(
			({ id, name, description }) => ({ id, name, description }),
		);
		const snapshot = this.broker?.snapshot();
		for (const provider of snapshot?.providers ?? []) {
			for (const binding of provider.bindings) {
				if (!binding.toolName || !binding.executors.includes("harness")) continue;
				const id = `${provider.id}:${binding.capabilityId}`;
				if (available.some((entry) => entry.id === id || entry.id.startsWith(`${id}:`))) continue;
				const capability = snapshot!.capabilities.find((entry) => entry.id === binding.capabilityId);
				if (!capability) continue;
				catalog.push({
					id,
					name: `${provider.name}: ${capability.name}`,
					description: capability.description,
					setup: `Open Settings → Connections → ${provider.name}. ${!provider.enabled ? "Enable the provider. " : ""}${provider.authentication && !provider.authentication.configured ? "Save the required provider configuration fields. " : ""}${provider.connectionRequired ? `Connect an account with ${capability.name} access${provider.id === "google-workspace" ? ' using "Connect Google account" (or "Update Google access")' : ""}. ` : ""}Return to this team chat and reply Approve tools to recheck and continue. Never paste credentials in chat.`,
				});
			}
		}
		return catalog;
	}

	resolveTool(id: string): TeamToolOption {
		const available = this.list();
		const exact = available.find((entry) => entry.id === id);
		if (exact) return exact;
		const accounts = available.filter((entry) => entry.id.startsWith(`${id}:`));
		if (accounts.length === 1) return accounts[0]!;
		if (accounts.length > 1)
			throw new Error(
				`Choose an account for ${id}: ${accounts.map((entry) => `${entry.name} (${entry.id})`).join(", ")}. Tell the supervisor which account to use.`,
			);
		// Resolve human labels only at the assignment boundary; persisted grants remain exact IDs.
		const query = normalizeToolLabel(id);
		const providers = this.broker?.snapshot().providers ?? [];
		const matches = available.filter((entry) => {
			const labels = [entry.name, ...entry.tools];
			for (const grant of entry.capabilities) {
				const provider = providers.find((candidate) => candidate.id === grant.providerId);
				if (!provider) continue;
				labels.push(`${provider.name}: ${entry.name}`);
				const binding = provider.bindings.find((candidate) => candidate.capabilityId === grant.capabilityId);
				if (binding?.toolName) labels.push(binding.toolName);
			}
			return labels.some((label) => normalizeToolLabel(label) === query);
		});
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1)
			throw new Error(
				`Tool name ${id} is ambiguous. Choose a provider, account or version: ${matches.map((entry) => `${entry.name} (${entry.id})`).join(", ")}. Do not guess or request approval until the choice is clear.`,
			);
		const unavailable = this.catalog().filter(
			(entry) =>
				entry.id === id ||
				normalizeToolLabel(entry.name) === query ||
				normalizeToolLabel(entry.name.split(": ").slice(1).join(": ")) === query,
		);
		if (unavailable.length > 1)
			throw new Error(
				`Choose the provider for ${id}: ${unavailable.map((entry) => `${entry.name} (${entry.id})`).join(", ")}`,
			);
		const option = unavailable[0];
		throw new Error(
			option?.setup ??
				`Tool ${id} is not in the environment catalog. Ask the supervisor for an available alternative.`,
		);
	}

	/** Preserve existing registry grants when a member first receives a team-specific allocation. */
	idsFor(agent: AgentDefinition): string[] {
		if (agent.delegateAgentIds.length)
			throw new Error(
				"This member has browser or delegation settings. Review its tool allocation in team settings before changing it through chat.",
			);
		const available = this.list();
		const ids = agent.tools
			.filter((name) => name !== "browser")
			.map((name) => {
				const option = available.find((entry) => entry.tools.includes(name === "ls" ? "list" : name));
				if (!option)
					throw new Error(
						`Existing tool ${name} cannot be preserved through this catalog. Review the member's tools in team settings.`,
					);
				return option.id;
			});
		if (agent.browser && agent.browser.access !== "disabled") {
			const option = available.find(
				(entry) =>
					entry.browser &&
					entry.browser.access === agent.browser?.access &&
					entry.browser.runtime === agent.browser.runtime &&
					entry.browser.profile.kind === agent.browser.profile.kind &&
					(entry.browser.profile.kind === "ephemeral" ||
						(agent.browser.profile.kind === "named" && entry.browser.profile.id === agent.browser.profile.id)),
			);
			if (!option)
				throw new Error(
					"Save this member's browser setup as a reusable profile before changing its tools through chat",
				);
			ids.push(option.id);
		}
		for (const workflow of agent.browserWorkflows) {
			const option = available.find(
				(entry) => entry.workflow?.id === workflow.id && entry.workflow.version === workflow.version,
			);
			if (!option) throw new Error("Existing browser workflow is unavailable; review its assignment");
			ids.push(option.id);
		}
		for (const grant of agent.capabilities) {
			const option = available.find((entry) =>
				entry.capabilities.some(
					(candidate) =>
						candidate.capabilityId === grant.capabilityId &&
						candidate.providerId === grant.providerId &&
						candidate.connectionId === grant.connectionId &&
						candidate.capabilityVersion === grant.capabilityVersion,
				),
			);
			if (!option) throw new Error(`Reconnect ${grant.providerId} before updating this member's tools.`);
			ids.push(option.id);
		}
		return [...new Set(ids)];
	}

	seed(agent: AgentDefinition, ids?: readonly string[]) {
		const selected = this.validate(ids ?? []);
		if (selected.filter((entry) => entry.browser).length > 1)
			throw new Error("Select one browser profile per member");
		const tools = [...new Set(selected.flatMap((entry) => entry.tools))];
		const capabilities = selected.flatMap((entry) => entry.capabilities);
		const browser = selected.find((entry) => entry.browser)?.browser;
		const browserWorkflows = selected.flatMap((entry) => (entry.workflow ? [entry.workflow] : []));
		if (browserWorkflows.length && !browser)
			throw new Error("Assign a browser profile before assigning a browser workflow");
		const definition: AgentDefinition =
			ids === undefined
				? { ...agent, model: agent.model ?? this.defaultModel }
				: {
						...agent,
						model: agent.model ?? this.defaultModel,
						tools,
						capabilities,
						permissionPolicy: tools.some((tool) => ["write", "edit", "bash", "powershell"].includes(tool))
							? "workspace-write"
							: "read-only",
						delegateAgentIds: [],
						browserWorkflows,
						browser,
					};
		return createAgentExecutionConfigurationSeed({
			definition,
			workspace: agent.projectRoot,
			effectiveModel: agent.model ?? this.defaultModel,
			capabilityBindings: this.broker?.resolveRunBindings(definition.capabilities, agent.executor) ?? [],
		});
	}
}

function normalizeToolLabel(value: string): string {
	return value.trim().replace(/\s+/gu, " ").toLowerCase();
}
