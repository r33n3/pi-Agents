import {
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	type Context,
	type Credential,
	getModelAuthConnection,
	getModelCatalogSnapshot,
	lazyStream,
	type Model,
	type ModelAuth,
	type ModelAuthConnection,
	type ModelCatalogProvenance,
	type OAuthAuth,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Provider,
	type ProviderHeaders,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
	validateModelCatalog,
	validateModelControls,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export interface ExtensionOAuthConfig {
	name: string;
	/** Whether access through this auth method is backed by a provider subscription. */
	isSubscription?: boolean;
	/** @deprecated Retained for extension source compatibility; ignored by canonical auth flows. */
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/** Input type for the extension registerProvider API. */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: ExtensionOAuthConfig;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		controls?: Model<Api>["controls"];
		input: ("text" | "image")[];
		cost: Model<Api>["cost"];
		contextWindow: number;
		maxTokens: number;
		samplingParams?: Record<string, unknown>;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
	refreshModels?(context: RefreshModelsContext): Promise<NonNullable<ProviderConfigInput["models"]>>;
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export const clearApiKeyCache = clearConfigValueCache;

interface ComposedCatalogState {
	base: Provider | undefined;
	extension: ProviderConfigInput | undefined;
	extensionModels?: ProviderConfigInput["models"];
	extensionCheckedAt?: number;
	oauthCredential?: OAuthCredentials;
}

// Transfer accepted dynamic inputs only when recomposing the same provider/extension connection.
// This state stays private to composition and is never persisted or included in provenance.
const composedCatalogStates = new WeakMap<Provider, ComposedCatalogState>();

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		controls: override.controls ?? model.controls,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					status: override.cost.status ?? model.cost.status,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		controls: definition.controls,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly Model<Api>[],
	config: ModelsJsonProvider | undefined,
): Model<Api>[] {
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: Model<Api>[] = baseModels.map((model) => ({
		...model,
		baseUrl: config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl),
		compat: mergeCompat(model.compat, config.compat),
	}));
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => model.id === definition.id);
		const defaults = existingIndex >= 0 ? models[existingIndex] : models[0];
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

function applyExtension(
	providerId: string,
	models: readonly Model<Api>[],
	config: ProviderConfigInput | undefined,
): Model<Api>[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	return config.models.map((definition) => {
		const defaults = models.find((model) => model.id === definition.id) ?? models[0];
		const api = definition.api ?? config.api ?? defaults?.api;
		if (!api) {
			throw new Error(
				`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
		if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
		return {
			...definition,
			api,
			provider: providerId,
			baseUrl,
			headers: undefined,
		};
	});
}

function adaptOAuth(config: ExtensionOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): string | undefined {
	return extension?.apiKey ?? config?.apiKey;
}

function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !extension?.headers) return undefined;
	return { ...config?.headers, ...extension?.headers };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const oauth = extension?.oauth ?? base?.auth.oauth;
	// OAuth-only providers get no fabricated API-key login method.
	if (!inherited && rawKey === undefined && oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key)
					return {
						type: "api_key",
						source: "stored credential",
						connection: getModelAuthConnection(providerId, { apiKey: input.credential.key }),
					};
				const resolved = await inherited?.resolve(input);
				return resolved
					? {
							type: "api_key",
							source: resolved.source,
							connection: getModelAuthConnection(providerId, resolved.auth),
						}
					: undefined;
			}
			if (rawKey !== undefined) {
				if (isCommandConfigValue(rawKey))
					return { type: "api_key", source: "configured API key", connection: { type: "unknown" } };
				const envNames = getConfigValueEnvVarNames(rawKey);
				const env: Record<string, string> = {};
				for (const name of envNames) {
					const value = await input.ctx.env(name);
					if (value === undefined) return undefined;
					env[name] = value;
				}
				// The command case returned above; checking a literal/template must never execute a key command.
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				return {
					type: "api_key",
					source: "configured API key",
					connection: getModelAuthConnection(providerId, { apiKey: key }),
				};
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved
				? {
						type: "api_key",
						source: resolved.source,
						connection: getModelAuthConnection(providerId, resolved.auth),
					}
				: undefined;
		},
		resolve: async (input) => {
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: undefined;
			} else if (rawKey !== undefined) {
				const env = await configContextEnv([rawKey], input.ctx);
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: { auth: { apiKey: key }, source: "configured API key" };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): OAuthAuth | undefined {
	const oauth = extension?.oauth ? adaptOAuth(extension.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

function rawModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	const definition = config?.models?.find((entry) => entry.id === model.id);
	const extensionModel = extension?.models?.find((entry) => entry.id === model.id);
	const headers = {
		...config?.modelOverrides?.[model.id]?.headers,
		...definition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	composeCatalog(providerId, base, modelsConfig, extension);
}

/** Build a detached, fully validated snapshot in the same order for registration and refresh. */
function composeCatalog(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	oauthCredential?: OAuthCredentials,
	refreshedExtensionAt?: number,
): { models: Model<Api>[]; provenance: Map<string, ModelCatalogProvenance> } {
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	const baseline = structuredClone(base?.getModels() ?? []);
	const sources = new Map<string, ModelCatalogProvenance>();
	for (const model of baseline) {
		let provenance: ModelCatalogProvenance | undefined;
		try {
			const snapshot = getModelCatalogSnapshot(base?.getModelProvenance?.(model.id));
			if (snapshot) {
				const { freshness: _freshness, timestampWarning: _timestampWarning, ...source } = snapshot;
				provenance = source;
			}
		} catch {
			/* Optional metadata cannot disable a model. */
		}
		sources.set(model.id, provenance ?? { source: "provider" });
	}
	const overlay = (modelId: string, source: "user-config" | "extension") => {
		const previous = sources.get(modelId);
		sources.set(modelId, previous ? { ...previous, overrides: [...(previous.overrides ?? []), source] } : { source });
	};
	let models = applyModelsJson(providerId, baseline, config);
	if (config?.baseUrl || config?.headers || config?.compat)
		for (const model of baseline) overlay(model.id, "user-config");
	for (const definition of config?.models ?? []) sources.set(definition.id, { source: "user-config" });
	models = applyExtension(providerId, models, extension);
	if (extension?.models) {
		for (const model of models)
			sources.set(model.id, {
				source: "extension",
				...(refreshedExtensionAt === undefined ? {} : { loadedFrom: "refresh", checkedAt: refreshedExtensionAt }),
			});
	} else if (extension?.baseUrl || extension?.headers || extension?.streamSimple) {
		for (const model of models) overlay(model.id, "extension");
	}
	if (oauthCredential && extension?.oauth?.modifyModels) {
		// Callbacks may mutate their inputs or retain references. Neither can alter the source layers.
		models = extension.oauth.modifyModels(structuredClone(models), structuredClone(oauthCredential));
		for (const model of models) overlay(model.id, "extension");
	}
	models = models.map((model) => {
		const override = config?.modelOverrides?.[model.id];
		if (override) overlay(model.id, "user-config");
		return override ? applyModelOverride(model, override) : model;
	});
	validateModelCatalog(providerId, models);
	return {
		models: structuredClone(models),
		provenance: new Map(models.map((model) => [model.id, sources.get(model.id) ?? { source: "provider" }])),
	};
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
	previous?: Provider,
): Provider {
	const config = modelConfig.getProvider(providerId);
	const previousState = previous && composedCatalogStates.get(previous);
	const inherited = previousState?.base === base && previousState?.extension === extension ? previousState : undefined;
	const state: ComposedCatalogState = {
		base,
		extension,
		extensionModels: inherited?.extensionModels && structuredClone(inherited.extensionModels),
		extensionCheckedAt: inherited?.extensionCheckedAt,
		oauthCredential: inherited?.oauthCredential && structuredClone(inherited.oauthCredential),
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	let catalog = composeCatalog(
		providerId,
		base,
		config,
		extension && state.extensionModels ? { ...extension, models: state.extensionModels } : extension,
		state.oauthCredential,
		state.extensionCheckedAt,
	);
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (options?.controls !== undefined) validateModelControls(model, options.controls);
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => structuredClone(catalog.models),
		getModelProvenance: (modelId) => {
			const provenance = catalog.provenance.get(modelId);
			return (
				provenance && { ...provenance, ...(provenance.overrides ? { overrides: [...provenance.overrides] } : {}) }
			);
		},
		refreshModels:
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								const nextModels = refreshed === undefined ? state.extensionModels : structuredClone(refreshed);
								const nextAt = refreshed === undefined ? state.extensionCheckedAt : Date.now();
								const nextCredential = oauthCredential && structuredClone(oauthCredential);
								const nextExtension =
									extension && nextModels ? { ...extension, models: nextModels } : extension;
								const candidate = composeCatalog(
									providerId,
									base,
									config,
									nextExtension,
									nextCredential,
									nextAt,
								);
								state.extensionModels = nextModels;
								state.extensionCheckedAt = nextAt;
								state.oauthCredential = nextCredential;
								catalog = candidate;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}

	composedCatalogStates.set(provider, state);
	return provider;
}

export function resolveConfiguredModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

/** Project configured header routing without resolving values or running header/key commands. */
export function getConfiguredModelControlConnection(
	model: Model<Api>,
	connection: ModelAuthConnection,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): ModelAuthConnection {
	if (model.provider !== "anthropic") return { ...connection };
	const headers = {
		...model.headers,
		...configuredHeaders(config, extension),
		...rawModelHeaders(model, config, extension),
	};
	if (
		(extension?.authHeader ?? config?.authHeader) ||
		Object.entries(headers).some(([name, value]) => name.toLowerCase() === "authorization" && value != null)
	)
		return { ...connection, type: "bearer" };
	return { ...connection };
}

export function resolveCompatibilityRequestConfig(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
