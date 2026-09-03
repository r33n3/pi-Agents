import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
import {
	type CapabilityCategory,
	type CapabilityDefinition,
	type CapabilityProviderBinding,
	type CapabilityProviderDiscoverySnapshot,
	type CapabilityProviderManifest,
	type CapabilityProviderMetadata,
	CapabilityProviderMetadataSchema,
	type ProviderCapabilityGroup,
} from "./capability-provider-contract.ts";

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
		id: "anthropic-api",
		name: "Anthropic API",
		source: "builtin:anthropic-api",
		version: "1",
		permissions: ["usage-based Anthropic model access"],
		configurationOnly: true,
		authentication: {
			kind: "environment",
			fields: [{ env: "ANTHROPIC_API_KEY", label: "Anthropic API key", required: true, secret: true }],
		},
		bindings: [],
	},
	{
		id: "openai-api",
		name: "OpenAI API",
		source: "builtin:openai-api",
		version: "1",
		permissions: ["usage-based OpenAI model access"],
		configurationOnly: true,
		authentication: {
			kind: "environment",
			fields: [{ env: "OPENAI_API_KEY", label: "OpenAI API key", required: true, secret: true }],
		},
		bindings: [],
	},
	{
		id: "pi-searxng",
		name: "SearXNG",
		source: "builtin:pi-searxng",
		version: "1",
		permissions: ["configured SearXNG network read"],
		authentication: {
			kind: "environment",
			fields: [
				{
					env: "SEARXNG_BASE_URL",
					label: "SearXNG URL",
					required: true,
					secret: false,
					format: "url",
				},
			],
		},
		bindings: [
			{
				capabilityId: "web.search",
				capabilityVersion: 1,
				toolName: "searxng_search",
				executors: ["session"],
			},
		],
	},
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
		authentication: {
			kind: "environment",
			fields: [
				{ env: "FIRECRAWL_BASE_URL", label: "Firecrawl URL", required: false, secret: false, format: "url" },
				{ env: "FIRECRAWL_API_KEY", label: "Firecrawl API key", required: true, secret: true },
			],
		},
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
	...readDefinitions("news", ["search"]),
	...readDefinitions("finance", ["quotes", "filings", "watchlist", "accounts", "transactions", "spending"]),
];

const WAVE_TWO_MANIFESTS: readonly CapabilityProviderManifest[] = [
	{
		id: "pi-public-web",
		name: "Pi Public Web",
		source: "builtin:pi-public-web",
		version: "1",
		permissions: ["bounded public network read"],
		bindings: [
			{ capabilityId: "web.fetch", capabilityVersion: 1, toolName: "page_read", executors: ["session", "harness"] },
		],
	},
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
	{
		id: "currents-news",
		name: "Currents News",
		source: "builtin:currents-news",
		version: "1",
		permissions: ["public news search", "Currents credential"],
		authentication: {
			kind: "environment",
			fields: [{ env: "CURRENTS_NEW_API_KEY", label: "Currents API key", required: true, secret: true }],
		},
		bindings: [...bindings(["news.search"], "currents_search_news")],
	},
	{
		id: "finnhub",
		name: "Finnhub",
		source: "builtin:finnhub",
		version: "1",
		permissions: ["market quote read", "Finnhub credential"],
		authentication: {
			kind: "environment",
			fields: [{ env: "FINNHUB_API_KEY", label: "Finnhub API key", required: true, secret: true }],
		},
		bindings: [...bindings(["finance.quotes"], "finnhub_quote")],
	},
	{
		id: "tiingo",
		name: "Tiingo",
		source: "builtin:tiingo",
		version: "1",
		permissions: ["market price read", "Tiingo credential"],
		authentication: {
			kind: "environment",
			fields: [{ env: "TIINGO_API_KEY", label: "Tiingo API key", required: true, secret: true }],
		},
		bindings: [...bindings(["finance.quotes"], "tiingo_price")],
	},
	{
		id: "apify",
		name: "Apify",
		source: "builtin:apify",
		version: "1",
		permissions: ["dataset read", "Apify credential"],
		configurationOnly: true,
		authentication: {
			kind: "environment",
			fields: [{ env: "APIFY_API_KEY", label: "Apify API key", required: true, secret: true }],
		},
		bindings: [],
	},
	{
		id: "amazon-bedrock-api",
		name: "Amazon Bedrock API",
		source: "builtin:amazon-bedrock-api",
		version: "1",
		permissions: ["usage-based Amazon Bedrock model access"],
		configurationOnly: true,
		authentication: {
			kind: "environment",
			fields: [{ env: "AWS_BEARER_TOKEN_BEDROCK", label: "Bedrock bearer token", required: true, secret: true }],
		},
		bindings: [],
	},
	{
		id: "hermes-configuration",
		name: "Hermes Configuration",
		source: "builtin:hermes-configuration",
		version: "1",
		permissions: ["Hermes model configuration"],
		configurationOnly: true,
		authentication: {
			kind: "environment",
			fields: [
				{ env: "HERMES_DEFAULT_MODEL", label: "Default Hermes model", required: false, secret: false },
				{ env: "HERMES_MODELS", label: "Available Hermes models", required: false, secret: false },
			],
		},
		bindings: [],
	},
	productivityManifest("google-workspace", "Google Workspace", "google_workspace", [
		"email",
		"calendar",
		"contacts",
		"cloud-files",
		"messaging",
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
	productivityManifest("telegram", "Telegram", "telegram", ["messaging"]),
	{
		id: "plaid",
		name: "Plaid Financial Accounts",
		source: "connector:plaid",
		version: "1",
		permissions: ["read financial account metadata", "read balances", "read transactions"],
		connectionRequired: true,
		authentication: {
			kind: "plaid-link",
			defaultCapabilityIds: ["finance.accounts", "finance.transactions", "finance.spending"],
			capabilityGroups: [
				{
					id: "financial-data",
					label: "Financial data",
					capabilityIds: ["finance.accounts", "finance.transactions", "finance.spending"],
				},
			],
			fields: [
				{ env: "PLAID_CLIENT_ID", label: "Plaid client ID", required: true, secret: false },
				{ env: "PLAID_SECRET", label: "Plaid secret", required: true, secret: true },
				{
					env: "PLAID_ENV",
					label: "Plaid environment",
					required: true,
					secret: false,
					options: [
						{ value: "sandbox", label: "Sandbox (test data)" },
						{ value: "production", label: "Production (live accounts)" },
					],
				},
				{
					env: "PLAID_ITEMS_JSON",
					label: "Plaid Item credentials",
					required: false,
					secret: true,
					operatorEditable: false,
				},
			],
		},
		bindings: [
			{
				capabilityId: "finance.accounts",
				capabilityVersion: 1,
				toolName: "plaid_finance_accounts_list",
				executors: ["session", "harness"],
			},
			{
				capabilityId: "finance.transactions",
				capabilityVersion: 1,
				toolName: "plaid_finance_transactions_search",
				executors: ["session", "harness"],
			},
			{
				capabilityId: "finance.spending",
				capabilityVersion: 1,
				toolName: "plaid_finance_spending_summary",
				executors: ["session", "harness"],
			},
		],
	},
];

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
		authentication:
			id === "google-workspace"
				? {
						kind: "oauth2",
						capabilityGroups: [
							googleCapabilityGroup("gmail", "Gmail", "email", capabilityIds),
							googleCapabilityGroup("calendar", "Calendar", "calendar", capabilityIds),
							googleCapabilityGroup("drive", "Drive", "cloud-files", capabilityIds),
							googleCapabilityGroup("contacts", "Contacts", "contacts", capabilityIds),
							googleCapabilityGroup("chat", "Google Chat", "messaging", capabilityIds),
						],
						defaultCapabilityIds: ["email.search", "email.read", "email.draft"],
						fields: [
							{ env: "GOOGLE_CLIENT_ID", label: "Google OAuth client ID", required: true, secret: false },
							{
								env: "GOOGLE_CLIENT_SECRET",
								label: "Google OAuth client secret",
								required: true,
								secret: true,
							},
							{
								env: "GOOGLE_OAUTH_REDIRECT_URI",
								label: "Google OAuth redirect URI",
								required: false,
								secret: false,
								format: "url",
							},
							{
								env: "GOOGLE_OAUTH_ACCESS_TOKEN",
								label: "Google OAuth access token",
								required: false,
								secret: true,
								operatorEditable: false,
							},
							{
								env: "GOOGLE_OAUTH_REFRESH_TOKEN",
								label: "Google OAuth refresh token",
								required: false,
								secret: true,
								operatorEditable: false,
							},
							{
								env: "GOOGLE_OAUTH_EXPIRES_AT",
								label: "Google OAuth expiry",
								required: false,
								secret: false,
								operatorEditable: false,
							},
						],
					}
				: undefined,
		bindings: capabilityIds.map((capabilityId) => ({
			capabilityId,
			capabilityVersion: 1,
			toolName: `${toolPrefix}_${capabilityId.replace(/[.-]/g, "_")}`,
			approvalEnforced: WAVE_TWO_DEFINITIONS.find((definition) => definition.id === capabilityId)?.effect !== "read",
			executors: ["session", "harness"],
		})),
	};
}

function googleCapabilityGroup(
	id: string,
	label: string,
	prefix: string,
	capabilityIds: readonly string[],
): ProviderCapabilityGroup {
	return { id, label, capabilityIds: capabilityIds.filter((capabilityId) => capabilityId.startsWith(`${prefix}.`)) };
}

function categoryFor(group: string): CapabilityCategory {
	if (["email", "messaging"].includes(group)) return "communication";
	if (["calendar", "contacts", "cloud-files", "tasks"].includes(group)) return "productivity";
	return "data";
}

function displayName(value: string): string {
	return value.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

const metadataValidator = Compile(CapabilityProviderMetadataSchema);

export const BUILTIN_CAPABILITY_PROVIDER_METADATA: CapabilityProviderMetadata = {
	definitions: [...WAVE_ONE_DEFINITIONS, ...WAVE_TWO_DEFINITIONS],
	providers: [...WAVE_ONE_MANIFESTS, ...WAVE_TWO_MANIFESTS],
};

/** Parses immutable, secret-free capability metadata without importing provider runtime modules. */
export class CapabilityProviderRegistry {
	readonly #definitions: ReadonlyMap<string, CapabilityDefinition>;
	readonly #providers: ReadonlyMap<string, CapabilityProviderManifest>;
	readonly #snapshot: CapabilityProviderDiscoverySnapshot;

	constructor(metadata: unknown = BUILTIN_CAPABILITY_PROVIDER_METADATA) {
		if (!metadataValidator.Check(metadata)) {
			const detail = [...metadataValidator.Errors(metadata)]
				.slice(0, 3)
				.map((error) => error.message)
				.join("; ");
			throw new Error(`Capability provider metadata is invalid${detail ? `: ${detail}` : ""}`);
		}
		const parsed = metadata as CapabilityProviderMetadata;
		validateMetadata(parsed);
		const definitions = freeze(parsed.definitions.map((definition) => clone(definition)));
		const providers = freeze(parsed.providers.map((provider) => clone(provider)));
		this.#definitions = new Map(definitions.map((definition) => [definition.id, definition]));
		this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
		this.#snapshot = freeze({
			version: 1,
			sourceDigest: digest({ definitions, providers }),
			definitions,
			providers: providers.map((provider) => ({ ...provider, digest: capabilityProviderManifestDigest(provider) })),
		});
	}

	snapshot(): CapabilityProviderDiscoverySnapshot {
		return this.#snapshot;
	}

	definitions(): readonly CapabilityDefinition[] {
		return this.#snapshot.definitions;
	}

	providers(): readonly CapabilityProviderManifest[] {
		return [...this.#providers.values()];
	}

	definition(capabilityId: string): CapabilityDefinition | undefined {
		return this.#definitions.get(capabilityId);
	}

	provider(providerId: string): CapabilityProviderManifest | undefined {
		return this.#providers.get(providerId);
	}

	providerDigest(providerId: string): string | undefined {
		const provider = this.#providers.get(providerId);
		return provider ? capabilityProviderManifestDigest(provider) : undefined;
	}
}

export function capabilityProviderManifestDigest(manifest: CapabilityProviderManifest): string {
	return digest(manifest);
}

function validateMetadata(metadata: CapabilityProviderMetadata): void {
	const definitions = new Map<string, CapabilityDefinition>();
	for (const definition of metadata.definitions) {
		if (definitions.has(definition.id)) throw new Error(`Capability ${definition.id} is defined more than once`);
		definitions.set(definition.id, definition);
	}
	const providerIds = new Set<string>();
	for (const manifest of metadata.providers) {
		if (providerIds.has(manifest.id)) throw new Error(`Provider ${manifest.id} is defined more than once`);
		providerIds.add(manifest.id);
		if (manifest.configurationOnly && manifest.bindings.length > 0) {
			throw new Error(`Configuration-only provider ${manifest.id} cannot declare capability bindings`);
		}
		const environmentNames = new Set<string>();
		for (const field of manifest.authentication?.fields ?? []) {
			if (isDangerousEnvironmentName(field.env)) {
				throw new Error(`Provider ${manifest.id} declares a prohibited environment field`);
			}
			if (environmentNames.has(field.env)) {
				throw new Error(`Provider ${manifest.id} declares ${field.env} more than once`);
			}
			environmentNames.add(field.env);
		}
		const bindingIds = new Set<string>();
		for (const binding of manifest.bindings) {
			const bindingId = `${binding.capabilityId}@${binding.capabilityVersion}`;
			if (bindingIds.has(bindingId)) throw new Error(`Provider ${manifest.id} binds ${bindingId} more than once`);
			bindingIds.add(bindingId);
			const definition = definitions.get(binding.capabilityId);
			if (!definition || definition.version !== binding.capabilityVersion) {
				throw new Error(`Provider ${manifest.id} references an unknown capability version`);
			}
			if (manifest.connectionRequired && definition.effect !== "read" && !binding.approvalEnforced) {
				throw new Error(`Provider ${manifest.id} must enforce approval for ${binding.capabilityId}`);
			}
		}
		const groupedCapabilities = new Set<string>();
		for (const group of manifest.authentication?.capabilityGroups ?? []) {
			for (const capabilityId of group.capabilityIds) {
				if (groupedCapabilities.has(capabilityId)) {
					throw new Error(`Provider ${manifest.id} groups ${capabilityId} more than once`);
				}
				if (!bindingIds.has(`${capabilityId}@${definitions.get(capabilityId)?.version ?? 0}`)) {
					throw new Error(`Provider ${manifest.id} groups an unbound capability: ${capabilityId}`);
				}
				groupedCapabilities.add(capabilityId);
			}
		}
		for (const capabilityId of manifest.authentication?.defaultCapabilityIds ?? []) {
			if (!groupedCapabilities.has(capabilityId)) {
				throw new Error(`Provider ${manifest.id} defaults an ungrouped capability: ${capabilityId}`);
			}
		}
	}
}

function isDangerousEnvironmentName(name: string): boolean {
	return (
		[
			"COMSPEC",
			"HOME",
			"NODE_OPTIONS",
			"NODE_PATH",
			"PATH",
			"PATHEXT",
			"SHELL",
			"SYSTEMROOT",
			"TEMP",
			"TMP",
			"USERPROFILE",
		].includes(name) || name.startsWith("NPM_CONFIG_")
	);
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Capability metadata contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (typeof value !== "object") throw new Error("Capability metadata contains a non-JSON value");
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.filter((key) => object[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function freeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Object.values(value)) freeze(entry);
	return Object.freeze(value);
}
