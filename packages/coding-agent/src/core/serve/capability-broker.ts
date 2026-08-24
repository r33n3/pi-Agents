import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentExecutorKind } from "./agent-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type CapabilityCategory =
	| "web"
	| "browser"
	| "files"
	| "communication"
	| "productivity"
	| "data"
	| "developer"
	| "system";
export type CapabilityEffect = "read" | "write" | "execute" | "external-side-effect";
export type CapabilityApproval = "never" | "per-run" | "always";
export type ProviderTrust = "unreviewed" | "quarantined" | "reviewed" | "enabled";

export interface AgentCapabilityGrant {
	capabilityId: string;
	capabilityVersion: number;
	providerId?: string;
	approval?: CapabilityApproval;
	connectionId?: string;
}

export interface CapabilityDefinition {
	id: string;
	version: number;
	name: string;
	description: string;
	category: CapabilityCategory;
	effect: CapabilityEffect;
	defaultApproval: CapabilityApproval;
}

export interface CapabilityProviderBinding {
	capabilityId: string;
	capabilityVersion: number;
	toolName?: string;
	approvalEnforced?: boolean;
	executors: AgentExecutorKind[];
}

export interface CapabilityProviderManifest {
	id: string;
	name: string;
	source: string;
	version: string;
	permissions: string[];
	connectionRequired?: boolean;
	bindings: CapabilityProviderBinding[];
}

export interface CapabilityProviderView extends CapabilityProviderManifest {
	digest: string;
	trust: ProviderTrust;
	enabled: boolean;
	health: "ready" | "degraded" | "missing-tools" | "passive";
	missingTools: string[];
}

export interface BrokeredCapabilityView extends CapabilityDefinition {
	defaultProviderId?: string;
	providers: string[];
	status: "active" | "available" | "unavailable";
}

export interface CapabilityBrokerSnapshot {
	capabilities: BrokeredCapabilityView[];
	providers: CapabilityProviderView[];
}

interface ProviderState {
	trust: ProviderTrust;
	reviewedDigest?: string;
	enabled: boolean;
	updatedAt: string;
}

interface PersistedState {
	version: 1;
	providers: Record<string, ProviderState>;
	defaults: Record<string, string>;
}

export interface CapabilityAuditEvent {
	timestamp: string;
	action: "provider.review" | "provider.enable" | "provider.disable" | "provider.default";
	providerId: string;
	capabilityId?: string;
}

export interface CapabilityBrokerOptions {
	activeToolNames: () => readonly string[];
	activeProviderSources?: () => readonly string[];
	connectionResolver?: (
		connectionId: string,
	) => { providerId: string; capabilityIds: readonly string[]; status: string } | undefined;
	manifests?: readonly CapabilityProviderManifest[];
	definitions?: readonly CapabilityDefinition[];
}

const WAVE_ONE_DEFINITIONS: readonly CapabilityDefinition[] = [
	{
		id: "web.search",
		version: 1,
		name: "Web search",
		description: "Search the public web through a configured provider.",
		category: "web",
		effect: "read",
		defaultApproval: "never",
	},
	{
		id: "web.fetch",
		version: 1,
		name: "Web fetch",
		description: "Fetch and normalize a permitted web page.",
		category: "web",
		effect: "read",
		defaultApproval: "never",
	},
	{
		id: "web.scrape",
		version: 1,
		name: "Web scrape",
		description: "Extract structured content from a permitted page.",
		category: "web",
		effect: "read",
		defaultApproval: "never",
	},
	{
		id: "web.crawl",
		version: 1,
		name: "Web crawl",
		description: "Crawl a bounded set of permitted pages.",
		category: "web",
		effect: "execute",
		defaultApproval: "per-run",
	},
	{
		id: "mcp.call",
		version: 1,
		name: "MCP tools",
		description: "Discover and call tools exposed by configured MCP servers.",
		category: "developer",
		effect: "execute",
		defaultApproval: "per-run",
	},
	{
		id: "mcp.discover",
		version: 1,
		name: "MCP discovery",
		description: "Discover tools exposed by configured MCP servers without invoking them.",
		category: "developer",
		effect: "read",
		defaultApproval: "never",
	},
	{
		id: "context.prune",
		version: 1,
		name: "Context pruning",
		description: "Reduce stale tool output while preserving recoverable context.",
		category: "system",
		effect: "execute",
		defaultApproval: "never",
	},
	{
		id: "notifications.send",
		version: 1,
		name: "Local notifications",
		description: "Notify the local user when background work changes state.",
		category: "communication",
		effect: "external-side-effect",
		defaultApproval: "per-run",
	},
	{
		id: "browser.annotate",
		version: 1,
		name: "Browser annotations",
		description: "Attach review annotations to a managed browser page.",
		category: "browser",
		effect: "write",
		defaultApproval: "per-run",
	},
];

const WAVE_ONE_MANIFESTS: readonly CapabilityProviderManifest[] = [
	{
		id: "rpiv-web-tools",
		name: "RPIV Web Tools",
		source: "@juicesharp/rpiv-web-tools",
		version: "2.6.4",
		permissions: ["public network read"],
		bindings: [
			{
				capabilityId: "web.search",
				capabilityVersion: 1,
				toolName: "web_search",
				executors: ["session"],
			},
			{
				capabilityId: "web.fetch",
				capabilityVersion: 1,
				toolName: "web_fetch",
				executors: ["session"],
			},
		],
	},
	{
		id: "pi-firecrawl",
		name: "Firecrawl",
		source: "@narumitw/pi-firecrawl",
		version: "review-required",
		permissions: ["public network read", "Firecrawl credential"],
		bindings: [
			{
				capabilityId: "web.search",
				capabilityVersion: 1,
				toolName: "firecrawl_search",
				executors: ["session"],
			},
			{
				capabilityId: "web.fetch",
				capabilityVersion: 1,
				toolName: "firecrawl_scrape",
				executors: ["session"],
			},
			{
				capabilityId: "web.scrape",
				capabilityVersion: 1,
				toolName: "firecrawl_scrape",
				executors: ["session"],
			},
			{
				capabilityId: "web.crawl",
				capabilityVersion: 1,
				toolName: "firecrawl_crawl",
				executors: ["session"],
			},
		],
	},
	{
		id: "pi-mcp-adapter",
		name: "Pi MCP Adapter",
		source: "pi-mcp-adapter",
		version: "2.13.0",
		permissions: ["configured MCP server access"],
		bindings: [
			{
				capabilityId: "mcp.discover",
				capabilityVersion: 1,
				toolName: "mcp",
				executors: ["session"],
			},
			{
				capabilityId: "mcp.call",
				capabilityVersion: 1,
				toolName: "mcp",
				executors: ["session"],
			},
		],
	},
	{
		id: "pi-context-prune",
		name: "Pi Context Prune",
		source: "pi-context-prune",
		version: "review-required",
		permissions: ["session context mutation"],
		bindings: [
			{
				capabilityId: "context.prune",
				capabilityVersion: 1,
				executors: ["session"],
			},
		],
	},
	{
		id: "pi-notifications",
		name: "Pi Notifications",
		source: "pi-notifications",
		version: "review-required",
		permissions: ["local desktop notifications"],
		bindings: [
			{
				capabilityId: "notifications.send",
				capabilityVersion: 1,
				toolName: "notify",
				executors: ["session"],
			},
		],
	},
	{
		id: "pi-browser-annotations",
		name: "Pi Browser Annotations",
		source: "pi-browser-annotations",
		version: "review-required",
		permissions: ["managed browser page mutation"],
		bindings: [
			{
				capabilityId: "browser.annotate",
				capabilityVersion: 1,
				toolName: "browser_annotate",
				executors: ["session"],
			},
		],
	},
];

const WAVE_TWO_DEFINITIONS: readonly CapabilityDefinition[] = [
	...readDefinitions("email", ["search", "read"]),
	...writeDefinitions("email", ["draft", "send", "attach", "delete"]),
	...readDefinitions("calendar", ["read", "availability"]),
	...writeDefinitions("calendar", ["create", "update", "delete"]),
	...readDefinitions("contacts", ["search", "read"]),
	...readDefinitions("cloud-files", ["search", "read"]),
	...writeDefinitions("cloud-files", ["write", "share", "delete"]),
	...readDefinitions("tasks", ["search", "read"]),
	...writeDefinitions("tasks", ["create", "update", "complete", "delete"]),
	...readDefinitions("messaging", ["search", "history"]),
	...writeDefinitions("messaging", ["draft", "send"]),
	...readDefinitions("weather", ["current", "forecast", "alerts"]),
	...readDefinitions("feeds", ["read"]),
	...readDefinitions("sites", ["monitor"]),
	...readDefinitions("events", ["search"]),
	...readDefinitions("finance", ["quotes", "filings", "watchlist"]),
];

const WAVE_TWO_MANIFESTS: readonly CapabilityProviderManifest[] = [
	{
		id: "pi-everyday-data",
		name: "Pi Everyday Data",
		source: "builtin:pi-everyday-data",
		version: "1",
		permissions: ["public network read", "local monitoring state"],
		bindings: [
			...bindings(["weather.current", "weather.forecast"], "weather_lookup"),
			...bindings(["weather.alerts"], "weather_alerts"),
			...bindings(["feeds.read"], "feed_read"),
			...bindings(["sites.monitor"], "site_monitor_check"),
			...bindings(["finance.watchlist"], "finance_watchlist_list"),
		],
	},
	productivityManifest("google-workspace", "Google Workspace", "google_workspace", [
		"email",
		"calendar",
		"contacts",
		"cloud-files",
	]),
	productivityManifest("microsoft-365", "Microsoft 365", "microsoft_365", [
		"email",
		"calendar",
		"contacts",
		"cloud-files",
	]),
	productivityManifest("dropbox", "Dropbox", "dropbox", ["cloud-files"]),
	productivityManifest("box", "Box", "box", ["cloud-files"]),
	productivityManifest("todoist", "Todoist", "todoist", ["tasks"]),
	productivityManifest("asana", "Asana", "asana", ["tasks"]),
	productivityManifest("trello", "Trello", "trello", ["tasks"]),
	productivityManifest("clickup", "ClickUp", "clickup", ["tasks"]),
	productivityManifest("slack", "Slack", "slack", ["messaging"]),
	productivityManifest("microsoft-teams", "Microsoft Teams", "microsoft_teams", ["messaging"]),
	productivityManifest("google-chat", "Google Chat", "google_chat", ["messaging"]),
	productivityManifest("telegram", "Telegram", "telegram", ["messaging"]),
];

/** Owns canonical capability grants, provider trust, defaults, and execution projection. */
export class CapabilityBroker {
	readonly #root: string;
	readonly #statePath: string;
	readonly #auditPath: string;
	readonly #definitions: Map<string, CapabilityDefinition>;
	readonly #manifests: Map<string, CapabilityProviderManifest>;
	readonly #activeToolNames: () => readonly string[];
	readonly #activeProviderSources: () => readonly string[];
	readonly #connectionResolver:
		| ((connectionId: string) =>
				| {
						providerId: string;
						capabilityIds: readonly string[];
						status: string;
				  }
				| undefined)
		| undefined;
	readonly #queue = new SerialOperationQueue();
	#state: PersistedState = { version: 1, providers: {}, defaults: {} };

	constructor(root: string, options: CapabilityBrokerOptions) {
		this.#root = resolve(root);
		this.#statePath = resolve(this.#root, "state.json");
		this.#auditPath = resolve(this.#root, "audit.jsonl");
		this.#activeToolNames = options.activeToolNames;
		this.#activeProviderSources = options.activeProviderSources ?? (() => []);
		this.#connectionResolver = options.connectionResolver;
		this.#definitions = new Map(
			(options.definitions ?? [...WAVE_ONE_DEFINITIONS, ...WAVE_TWO_DEFINITIONS]).map((entry) => [entry.id, entry]),
		);
		this.#manifests = new Map(
			(options.manifests ?? [...WAVE_ONE_MANIFESTS, ...WAVE_TWO_MANIFESTS]).map((entry) => [entry.id, entry]),
		);
		this.#validateCatalog();
	}

	async initialize(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		try {
			const value: unknown = JSON.parse(await readFile(this.#statePath, "utf8"));
			this.#state = normalizeState(value, this.#manifests);
			await this.#persist();
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			for (const id of this.#manifests.keys()) this.#state.providers[id] = initialProviderState();
			await this.#persist();
		}
	}

	snapshot(): CapabilityBrokerSnapshot {
		const activeTools = new Set(this.#activeToolNames());
		const providers = [...this.#manifests.values()].map((manifest) => this.#providerView(manifest, activeTools));
		const capabilities = [...this.#definitions.values()].map((definition) => {
			const supporting = providers.filter((provider) =>
				provider.bindings.some(
					(binding) => binding.capabilityId === definition.id && binding.capabilityVersion === definition.version,
				),
			);
			const active = supporting.some(
				(provider) => provider.enabled && this.#bindingReady(provider, definition.id, activeTools),
			);
			const available = supporting.some((provider) => this.#bindingReady(provider, definition.id, activeTools));
			return {
				...definition,
				defaultProviderId: this.#state.defaults[definition.id],
				providers: supporting.map((provider) => provider.id),
				status: active ? ("active" as const) : available ? ("available" as const) : ("unavailable" as const),
			};
		});
		return { capabilities, providers };
	}

	async reviewProvider(providerId: string, approved: boolean): Promise<CapabilityProviderView> {
		assertApproval(approved);
		return this.#mutate(async () => {
			const manifest = this.#provider(providerId);
			this.#state.providers[providerId] = {
				trust: "reviewed",
				reviewedDigest: manifestDigest(manifest),
				enabled: false,
				updatedAt: new Date().toISOString(),
			};
			await this.#audit({ action: "provider.review", providerId });
			return this.#providerView(manifest, new Set(this.#activeToolNames()));
		});
	}

	async enableProvider(providerId: string, approved: boolean): Promise<CapabilityProviderView> {
		assertApproval(approved);
		return this.#mutate(async () => {
			const manifest = this.#provider(providerId);
			const state = this.#providerState(providerId);
			const digest = manifestDigest(manifest);
			if (state.trust !== "reviewed" || state.reviewedDigest !== digest) {
				throw new Error(`Provider ${providerId} must be reviewed at its current digest before enabling`);
			}
			const view = this.#providerView(manifest, new Set(this.#activeToolNames()));
			if (view.health === "missing-tools") {
				throw new Error(`Provider ${providerId} is missing loaded tools: ${view.missingTools.join(", ")}`);
			}
			const activeTools = new Set(this.#activeToolNames());
			for (const binding of manifest.bindings.filter((entry) =>
				this.#bindingReady(manifest, entry.capabilityId, activeTools),
			)) {
				const conflicting = this.#state.defaults[binding.capabilityId];
				if (conflicting && conflicting !== providerId) {
					throw new Error(
						`Capability ${binding.capabilityId} already defaults to ${conflicting}; change the default explicitly`,
					);
				}
			}
			this.#state.providers[providerId] = {
				...state,
				trust: "enabled",
				enabled: true,
				updatedAt: new Date().toISOString(),
			};
			for (const binding of manifest.bindings.filter((entry) =>
				this.#bindingReady(manifest, entry.capabilityId, activeTools),
			)) {
				this.#state.defaults[binding.capabilityId] ??= providerId;
			}
			await this.#audit({ action: "provider.enable", providerId });
			return this.#providerView(manifest, new Set(this.#activeToolNames()));
		});
	}

	async disableProvider(providerId: string, approved: boolean): Promise<CapabilityProviderView> {
		assertApproval(approved);
		return this.#mutate(async () => {
			const manifest = this.#provider(providerId);
			const state = this.#providerState(providerId);
			this.#state.providers[providerId] = {
				...state,
				trust: state.reviewedDigest ? "reviewed" : "quarantined",
				enabled: false,
				updatedAt: new Date().toISOString(),
			};
			for (const [capabilityId, defaultProviderId] of Object.entries(this.#state.defaults)) {
				if (defaultProviderId === providerId) delete this.#state.defaults[capabilityId];
			}
			await this.#audit({ action: "provider.disable", providerId });
			return this.#providerView(manifest, new Set(this.#activeToolNames()));
		});
	}

	async setDefaultProvider(capabilityId: string, providerId: string, approved: boolean): Promise<void> {
		assertApproval(approved);
		await this.#mutate(async () => {
			const definition = this.#definition(capabilityId);
			const manifest = this.#provider(providerId);
			if (!manifest.bindings.some((binding) => binding.capabilityId === definition.id)) {
				throw new Error(`Provider ${providerId} does not provide ${capabilityId}`);
			}
			if (!this.#providerState(providerId).enabled) throw new Error(`Provider ${providerId} is not enabled`);
			if (!this.#bindingReady(manifest, capabilityId, new Set(this.#activeToolNames()))) {
				throw new Error(`Provider ${providerId} is unavailable for ${capabilityId}`);
			}
			this.#state.defaults[capabilityId] = providerId;
			await this.#audit({
				action: "provider.default",
				providerId,
				capabilityId,
			});
		});
	}

	validateGrants(grants: readonly AgentCapabilityGrant[], executor: AgentExecutorKind): void {
		const duplicates = new Set<string>();
		for (const grant of grants) {
			const definition = this.#definition(grant.capabilityId);
			if (grant.capabilityVersion !== definition.version) {
				throw new Error(`Capability ${grant.capabilityId} version ${grant.capabilityVersion} is unavailable`);
			}
			if (duplicates.has(grant.capabilityId))
				throw new Error(`Capability ${grant.capabilityId} is granted more than once`);
			duplicates.add(grant.capabilityId);
			const providerId = grant.providerId ?? this.#state.defaults[grant.capabilityId];
			if (!providerId) throw new Error(`Capability ${grant.capabilityId} has no enabled default provider`);
			const provider = this.#provider(providerId);
			if (!this.#providerState(providerId).enabled) throw new Error(`Provider ${providerId} is not enabled`);
			const binding = provider.bindings.find(
				(entry) => entry.capabilityId === grant.capabilityId && entry.capabilityVersion === grant.capabilityVersion,
			);
			if (!binding) throw new Error(`Provider ${providerId} does not provide ${grant.capabilityId}`);
			if (binding.toolName && !this.#activeToolNames().includes(binding.toolName)) {
				throw new Error(`Provider ${providerId} tool ${binding.toolName} is unavailable`);
			}
			if (!binding.executors.includes(executor)) {
				throw new Error(`Capability ${grant.capabilityId} is unavailable for the ${executor} executor`);
			}
			if (provider.connectionRequired && definition.effect !== "read" && !binding.approvalEnforced) {
				throw new Error(`Capability ${grant.capabilityId} requires a receipt-enforcing provider adapter`);
			}
			if (provider.connectionRequired && !grant.connectionId) {
				throw new Error(`Capability ${grant.capabilityId} requires a connection`);
			}
			if (grant.connectionId) {
				const connection = this.#connectionResolver?.(grant.connectionId);
				if (!connection) throw new Error(`Capability connection ${grant.connectionId} was not found`);
				if (connection.status !== "active") {
					throw new Error(`Capability connection ${grant.connectionId} is ${connection.status}`);
				}
				if (connection.providerId !== providerId) {
					throw new Error(
						`Capability connection ${grant.connectionId} belongs to provider ${connection.providerId}`,
					);
				}
				if (!connection.capabilityIds.includes(grant.capabilityId)) {
					throw new Error(`Capability connection ${grant.connectionId} does not grant ${grant.capabilityId}`);
				}
			}
		}
	}

	resolveToolNames(grants: readonly AgentCapabilityGrant[], executor: AgentExecutorKind): string[] {
		this.validateGrants(grants, executor);
		return grants.flatMap((grant) => {
			const providerId = grant.providerId ?? this.#state.defaults[grant.capabilityId];
			if (!providerId) return [];
			const binding = this.#provider(providerId).bindings.find(
				(entry) => entry.capabilityId === grant.capabilityId && entry.capabilityVersion === grant.capabilityVersion,
			);
			return binding?.toolName ? [binding.toolName] : [];
		});
	}

	validateUnattendedGrants(grants: readonly AgentCapabilityGrant[], executor: AgentExecutorKind): void {
		this.validateGrants(grants, executor);
		for (const grant of grants) {
			const definition = this.#definition(grant.capabilityId);
			const approval = grant.approval ?? definition.defaultApproval;
			if (definition.effect !== "read" || approval !== "never") {
				throw new Error(`Unattended routines cannot use ${grant.capabilityId}; interactive approval is required`);
			}
		}
	}

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		return this.#queue.run(async () => {
			const result = await operation();
			await this.#persist();
			return result;
		});
	}

	#providerView(manifest: CapabilityProviderManifest, activeTools: ReadonlySet<string>): CapabilityProviderView {
		const state = this.#providerState(manifest.id);
		const requiredTools = [
			...new Set(manifest.bindings.flatMap((binding) => (binding.toolName ? [binding.toolName] : []))),
		];
		const passiveLoaded = this.#activeProviderSources().some(
			(source) => source === manifest.source || source.includes(manifest.source),
		);
		const missingTools = [
			...new Set(
				requiredTools.length === 0 && !passiveLoaded
					? [`provider:${manifest.source}`]
					: requiredTools.filter((toolName) => !activeTools.has(toolName)),
			),
		];
		return {
			...manifest,
			digest: manifestDigest(manifest),
			trust: state.trust,
			enabled: state.enabled,
			health:
				requiredTools.length === 0
					? passiveLoaded
						? "passive"
						: "missing-tools"
					: missingTools.length === 0
						? "ready"
						: missingTools.length === requiredTools.length
							? "missing-tools"
							: "degraded",
			missingTools,
		};
	}

	#bindingReady(
		provider: Pick<CapabilityProviderManifest, "bindings" | "source" | "connectionRequired">,
		capabilityId: string,
		activeTools: ReadonlySet<string>,
	): boolean {
		const binding = provider.bindings.find((entry) => entry.capabilityId === capabilityId);
		if (!binding) return false;
		const definition = this.#definitions.get(capabilityId);
		if (provider.connectionRequired && definition?.effect !== "read" && !binding.approvalEnforced) return false;
		if (binding.toolName) return activeTools.has(binding.toolName);
		return this.#activeProviderSources().some(
			(source) => source === provider.source || source.includes(provider.source),
		);
	}

	#providerState(providerId: string): ProviderState {
		const existing = this.#state.providers[providerId];
		if (existing) return existing;
		const created = initialProviderState();
		this.#state.providers[providerId] = created;
		return created;
	}

	#provider(providerId: string): CapabilityProviderManifest {
		const provider = this.#manifests.get(providerId);
		if (!provider) throw new Error(`Unknown capability provider: ${providerId}`);
		return provider;
	}

	#definition(capabilityId: string): CapabilityDefinition {
		const definition = this.#definitions.get(capabilityId);
		if (!definition) throw new Error(`Unknown capability: ${capabilityId}`);
		return definition;
	}

	#validateCatalog(): void {
		for (const manifest of this.#manifests.values()) {
			for (const binding of manifest.bindings) {
				const definition = this.#definitions.get(binding.capabilityId);
				if (!definition || definition.version !== binding.capabilityVersion) {
					throw new Error(`Provider ${manifest.id} references an unknown capability version`);
				}
			}
		}
	}

	async #persist(): Promise<void> {
		await mkdir(dirname(this.#statePath), { recursive: true });
		const temporary = resolve(dirname(this.#statePath), `.state.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, this.#statePath);
	}

	async #audit(event: Omit<CapabilityAuditEvent, "timestamp">): Promise<void> {
		await appendFile(
			this.#auditPath,
			`${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
			"utf8",
		);
	}
}

function normalizeState(value: unknown, manifests: ReadonlyMap<string, CapabilityProviderManifest>): PersistedState {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Capability state is invalid");
	const input = value as Record<string, unknown>;
	if (input.version !== 1) throw new Error("Capability state version is unsupported");
	const providerInput = record(input.providers, "providers");
	const defaultInput = record(input.defaults, "defaults");
	const providers: Record<string, ProviderState> = {};
	for (const [id, manifest] of manifests) {
		const entry = providerInput[id];
		const normalized = entry === undefined ? initialProviderState() : normalizeProviderState(entry, id);
		providers[id] =
			normalized.reviewedDigest && normalized.reviewedDigest !== manifestDigest(manifest)
				? initialProviderState()
				: normalized;
	}
	const defaults: Record<string, string> = {};
	for (const [capabilityId, providerId] of Object.entries(defaultInput)) {
		if (typeof providerId !== "string" || !manifests.has(providerId)) {
			throw new Error(`Capability default ${capabilityId} is invalid`);
		}
		if (providers[providerId]?.enabled) defaults[capabilityId] = providerId;
	}
	return { version: 1, providers, defaults };
}

function normalizeProviderState(value: unknown, providerId: string): ProviderState {
	const input = record(value, `provider ${providerId}`);
	if (!isTrust(input.trust) || typeof input.enabled !== "boolean" || typeof input.updatedAt !== "string") {
		throw new Error(`Provider state ${providerId} is invalid`);
	}
	if (input.reviewedDigest !== undefined && typeof input.reviewedDigest !== "string") {
		throw new Error(`Provider state ${providerId} has an invalid digest`);
	}
	return {
		trust: input.trust,
		enabled: input.enabled,
		updatedAt: input.updatedAt,
		reviewedDigest: input.reviewedDigest,
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function initialProviderState(): ProviderState {
	return {
		trust: "quarantined",
		enabled: false,
		updatedAt: new Date().toISOString(),
	};
}

function manifestDigest(manifest: CapabilityProviderManifest): string {
	return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

function assertApproval(approved: boolean): void {
	if (!approved) throw new Error("Capability provider changes require explicit approval");
}

function isTrust(value: unknown): value is ProviderTrust {
	return ["unreviewed", "quarantined", "reviewed", "enabled"].includes(String(value));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function readDefinitions(group: string, actions: readonly string[]): CapabilityDefinition[] {
	return actions.map((action) => ({
		id: `${group}.${action}`,
		version: 1,
		name: `${displayName(group)} ${displayName(action)}`,
		description: `Read ${displayName(action).toLowerCase()} data through an enabled ${displayName(group)} provider.`,
		category: categoryFor(group),
		effect: "read",
		defaultApproval: "never",
	}));
}

function writeDefinitions(group: string, actions: readonly string[]): CapabilityDefinition[] {
	return actions.map((action) => ({
		id: `${group}.${action}`,
		version: 1,
		name: `${displayName(group)} ${displayName(action)}`,
		description: `${displayName(action)} through an enabled ${displayName(group)} provider with a target-bound receipt.`,
		category: categoryFor(group),
		effect: action === "delete" ? "external-side-effect" : "write",
		defaultApproval: "per-run",
	}));
}

function bindings(capabilityIds: readonly string[], toolName: string): CapabilityProviderBinding[] {
	return capabilityIds.map((capabilityId) => ({
		capabilityId,
		capabilityVersion: 1,
		toolName,
		executors: ["session"],
	}));
}

function productivityManifest(
	id: string,
	name: string,
	toolPrefix: string,
	groups: readonly string[],
): CapabilityProviderManifest {
	const capabilityIds = WAVE_TWO_DEFINITIONS.map((definition) => definition.id).filter((capabilityId) =>
		groups.some((group) => capabilityId.startsWith(`${group}.`)),
	);
	return {
		id,
		name,
		source: `connector:${id}`,
		version: "1",
		permissions: ["connected account data", "provider API access"],
		connectionRequired: true,
		bindings: capabilityIds.map((capabilityId) => ({
			capabilityId,
			capabilityVersion: 1,
			toolName: `${toolPrefix}_${capabilityId.replace(/[.-]/g, "_")}`,
			executors: ["session"],
		})),
	};
}

function categoryFor(group: string): CapabilityCategory {
	if (["email", "messaging"].includes(group)) return "communication";
	if (["calendar", "contacts", "cloud-files", "tasks"].includes(group)) return "productivity";
	return "data";
}

function displayName(value: string): string {
	return value.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}
