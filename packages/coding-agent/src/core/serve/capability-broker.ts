import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentExecutorKind } from "./agent-registry.ts";
import type {
	CapabilityApproval,
	CapabilityDefinition,
	CapabilityProviderDiscoverySnapshot,
	CapabilityProviderManifest,
	ProviderAuthenticationManifest,
	ProviderCapabilityGroup,
	ProviderConfigurationField,
} from "./capability-provider-contract.ts";
import { CapabilityProviderRegistry, capabilityProviderManifestDigest } from "./capability-provider-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type {
	CapabilityApproval,
	CapabilityCategory,
	CapabilityDefinition,
	CapabilityEffect,
	CapabilityProviderBinding,
	CapabilityProviderManifest,
	ProviderAuthenticationManifest,
	ProviderCapabilityGroup,
	ProviderConfigurationField,
} from "./capability-provider-contract.ts";
export type ProviderTrust = "unreviewed" | "quarantined" | "reviewed" | "enabled";

export interface AgentCapabilityGrant {
	capabilityId: string;
	capabilityVersion: number;
	providerId?: string;
	approval?: CapabilityApproval;
	connectionId?: string;
}

export interface ProviderAuthenticationView {
	kind: "environment" | "oauth2" | "plaid-link";
	configured: boolean;
	fields: Array<ProviderConfigurationField & { configured: boolean; value?: string }>;
	capabilityGroups?: ProviderCapabilityGroup[];
	defaultCapabilityIds?: string[];
}

export interface CapabilityProviderView extends CapabilityProviderManifest {
	digest: string;
	trust: ProviderTrust;
	enabled: boolean;
	health: "ready" | "degraded" | "missing-tools" | "passive";
	missingTools: string[];
	authentication?: ProviderAuthenticationView;
}

export interface BrokeredCapabilityView extends CapabilityDefinition {
	defaultProviderId?: string;
	providers: string[];
	status: "active" | "available" | "unavailable";
}

export interface CapabilityBrokerSnapshot {
	discovery: CapabilityProviderDiscoverySnapshot;
	capabilities: BrokeredCapabilityView[];
	providers: CapabilityProviderView[];
}

export interface ResolvedCapabilityBinding {
	capabilityId: string;
	capabilityVersion: number;
	providerId: string;
	providerDigest: string;
	connectionId?: string;
	toolName?: string;
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
	environmentValue?: (name: string) => string | undefined;
	providerConnectionAvailable?: (providerId: string) => boolean;
	connectionResolver?: (
		connectionId: string,
	) => { providerId: string; capabilityIds: readonly string[]; status: string } | undefined;
	registry?: CapabilityProviderRegistry;
}

/** Owns canonical capability grants, provider trust, defaults, and execution projection. */
export class CapabilityBroker {
	readonly #root: string;
	readonly #statePath: string;
	readonly #auditPath: string;
	readonly #definitions: Map<string, CapabilityDefinition>;
	readonly #manifests: Map<string, CapabilityProviderManifest>;
	readonly #registry: CapabilityProviderRegistry;
	readonly #activeToolNames: () => readonly string[];
	readonly #activeProviderSources: () => readonly string[];
	readonly #environmentValue: (name: string) => string | undefined;
	readonly #providerConnectionAvailable: (providerId: string) => boolean;
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
		this.#environmentValue = options.environmentValue ?? ((name) => process.env[name]);
		this.#providerConnectionAvailable = options.providerConnectionAvailable ?? (() => false);
		this.#connectionResolver = options.connectionResolver;
		this.#registry = options.registry ?? new CapabilityProviderRegistry();
		this.#definitions = new Map(this.#registry.definitions().map((entry) => [entry.id, entry]));
		this.#manifests = new Map(this.#registry.providers().map((entry) => [entry.id, entry]));
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
		return { discovery: this.#registry.snapshot(), capabilities, providers };
	}

	authenticationManifest(providerId: string): ProviderAuthenticationManifest | undefined {
		const authentication = this.#provider(providerId).authentication;
		return authentication
			? { ...authentication, fields: authentication.fields.map((field) => ({ ...field })) }
			: undefined;
	}

	async reviewProvider(providerId: string, approved: boolean): Promise<CapabilityProviderView> {
		assertApproval(approved);
		return this.#mutate(async () => {
			const manifest = this.#provider(providerId);
			this.#state.providers[providerId] = {
				trust: "reviewed",
				reviewedDigest: capabilityProviderManifestDigest(manifest),
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
			const digest = capabilityProviderManifestDigest(manifest);
			if (state.trust !== "reviewed" || state.reviewedDigest !== digest) {
				throw new Error(`Provider ${providerId} must be reviewed at its current digest before enabling`);
			}
			const view = this.#providerView(manifest, new Set(this.#activeToolNames()));
			if (view.authentication && !view.authentication.configured) {
				throw new Error(`Provider ${providerId} requires configuration before enabling`);
			}
			if (manifest.connectionRequired && !this.#providerConnectionAvailable(providerId)) {
				throw new Error(`Provider ${providerId} requires an active connection before enabling`);
			}
			if (view.health === "missing-tools") {
				throw new Error(`Provider ${providerId} is missing loaded tools: ${view.missingTools.join(", ")}`);
			}
			const activeTools = new Set(this.#activeToolNames());
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
		return this.resolveRunBindings(grants, executor).flatMap((binding) =>
			binding.toolName ? [binding.toolName] : [],
		);
	}

	/** Captures the exact secret-free provider bindings selected for one admitted run. */
	resolveRunBindings(
		grants: readonly AgentCapabilityGrant[],
		executor: AgentExecutorKind,
	): ResolvedCapabilityBinding[] {
		this.validateGrants(grants, executor);
		return grants.map((grant) => {
			const providerId = grant.providerId ?? this.#state.defaults[grant.capabilityId];
			if (!providerId) throw new Error(`Capability ${grant.capabilityId} has no enabled default provider`);
			const provider = this.#provider(providerId);
			const binding = provider.bindings.find(
				(entry) => entry.capabilityId === grant.capabilityId && entry.capabilityVersion === grant.capabilityVersion,
			);
			if (!binding) throw new Error(`Provider ${providerId} does not provide ${grant.capabilityId}`);
			return {
				capabilityId: grant.capabilityId,
				capabilityVersion: grant.capabilityVersion,
				providerId,
				providerDigest: capabilityProviderManifestDigest(provider),
				connectionId: grant.connectionId,
				toolName: binding.toolName,
			};
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
				requiredTools.length === 0 && !passiveLoaded && manifest.configurationOnly !== true
					? [`provider:${manifest.source}`]
					: requiredTools.filter((toolName) => !activeTools.has(toolName)),
			),
		];
		const configurationReady =
			manifest.configurationOnly === true &&
			(manifest.authentication?.fields ?? [])
				.filter((field) => field.required)
				.every((field) => Boolean(this.#environmentValue(field.env)?.trim()));
		return {
			...manifest,
			digest: capabilityProviderManifestDigest(manifest),
			trust: state.trust,
			enabled: state.enabled,
			health: configurationReady
				? "ready"
				: requiredTools.length === 0
					? passiveLoaded
						? "passive"
						: "missing-tools"
					: missingTools.length === 0
						? "ready"
						: missingTools.length === requiredTools.length
							? "missing-tools"
							: "degraded",
			missingTools,
			authentication: manifest.authentication
				? {
						...manifest.authentication,
						configured: manifest.authentication.fields
							.filter((field) => field.required)
							.every((field) => Boolean(this.#environmentValue(field.env)?.trim())),
						fields: manifest.authentication.fields.map((field) => {
							const value = this.#environmentValue(field.env)?.trim();
							return {
								...field,
								configured: Boolean(value),
								...(field.secret || !value ? {} : { value }),
							};
						}),
					}
				: undefined,
		};
	}

	#bindingReady(
		provider: Pick<CapabilityProviderManifest, "authentication" | "bindings" | "source" | "connectionRequired">,
		capabilityId: string,
		activeTools: ReadonlySet<string>,
	): boolean {
		const binding = provider.bindings.find((entry) => entry.capabilityId === capabilityId);
		if (!binding) return false;
		if (
			provider.authentication?.fields
				.filter((field) => field.required)
				.some((field) => !this.#environmentValue(field.env)?.trim())
		)
			return false;
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
		const currentDigest = capabilityProviderManifestDigest(manifest);
		providers[id] = normalized.reviewedDigest
			? normalized.reviewedDigest === currentDigest
				? normalized
				: normalized.reviewedDigest === legacyManifestDigest(manifest)
					? { ...normalized, reviewedDigest: currentDigest }
					: initialProviderState()
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

function legacyManifestDigest(manifest: CapabilityProviderManifest): string {
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
