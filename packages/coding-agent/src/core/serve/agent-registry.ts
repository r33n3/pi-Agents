import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve } from "node:path";
import type { ModelControls, ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { parseAgentModelControls } from "./agent-model-settings.ts";
import type { BrowserAccess } from "./browser-policy.ts";
import type { BrowserProfile } from "./browser-profile-store.ts";
import type { BrowserRuntimeKind } from "./browser-session-manager.ts";
import type { AgentCapabilityGrant } from "./capability-broker.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentExecutorKind = "session" | "harness";
export type AgentMemoryKind = "none" | "notes";
export type AgentPermissionPolicy = "read-only" | "workspace-write";
export type AgentDefinitionSource = "managed" | "pi-agent";

export interface AgentBrowserPolicy {
	access: BrowserAccess;
	runtime: BrowserRuntimeKind;
	profile: BrowserProfile;
}

export interface AgentBrowserWorkflowGrant {
	id: string;
	version: number;
}

export interface AgentRoutineDefinition {
	id: string;
	prompt: string;
	intervalMinutes: number;
	enabled: boolean;
}

export interface AgentDefinition {
	id: string;
	revision: number;
	source: AgentDefinitionSource;
	personaId?: string;
	name: string;
	description: string;
	model?: ModelRef;
	budget?: { maxTokens?: number; maxCostUsd?: number };
	thinking?: ThinkingLevel;
	/** Omitted uses legacy thinking; {} explicitly selects provider defaults. */
	modelControls?: ModelControls;
	tools: string[];
	capabilities: AgentCapabilityGrant[];
	memory: AgentMemoryKind;
	persona: string;
	projectRoot: string;
	workspace: string;
	executor: AgentExecutorKind;
	permissionPolicy: AgentPermissionPolicy;
	schedules: AgentRoutineDefinition[];
	browser?: AgentBrowserPolicy;
	browserWorkflows: AgentBrowserWorkflowGrant[];
	delegateAgentIds: string[];
	a2a: { enabled: boolean };
}

export type AgentDefinitionInput = Omit<
	AgentDefinition,
	| "id"
	| "revision"
	| "personaId"
	| "source"
	| "workspace"
	| "projectRoot"
	| "delegateAgentIds"
	| "browserWorkflows"
	| "browser"
	| "a2a"
	| "capabilities"
> & {
	id?: string;
	personaId?: string;
	workspace?: string;
	projectRoot?: string;
	delegateAgentIds?: string[];
	browserWorkflows?: AgentBrowserWorkflowGrant[];
	browser?: Omit<AgentBrowserPolicy, "runtime"> & { runtime?: BrowserRuntimeKind };
	a2a?: { enabled: boolean };
	capabilities?: AgentCapabilityGrant[];
};

export interface AgentRegistryOptions {
	catalogDirectory?: string;
	personaDirectory?: string;
	defaultWorkspace?: string;
	modelCatalog?: () => readonly AgentModelCatalogEntry[];
	modelControlsValidator?: (model: ModelRef, controls: ModelControls) => void;
	browserWorkflowCatalog?: (id: string, version: number) => boolean;
	capabilityValidator?: (grants: readonly AgentCapabilityGrant[], executor: AgentExecutorKind) => void;
}

export interface AgentModelCatalogEntry extends ModelRef {
	name: string;
}

export interface AgentRegistryEvent {
	type: "agent.created" | "agent.updated" | "agent.removed";
	agentId: string;
}

/** Owns durable agent definitions and guarantees every workspace stays under its configured root. */
export class AgentRegistry {
	readonly #root: string;
	readonly #definitionsDir: string;
	readonly #workspacesDir: string;
	readonly #catalogDirectory: string | undefined;
	readonly #personaDirectory: string | undefined;
	readonly #defaultWorkspace: string;
	readonly #modelCatalog: (() => readonly AgentModelCatalogEntry[]) | undefined;
	readonly #modelControlsValidator: AgentRegistryOptions["modelControlsValidator"];
	readonly #browserWorkflowCatalog: ((id: string, version: number) => boolean) | undefined;
	readonly #capabilityValidator:
		| ((grants: readonly AgentCapabilityGrant[], executor: AgentExecutorKind) => void)
		| undefined;
	readonly #queue = new SerialOperationQueue();
	readonly #listeners = new Set<(event: AgentRegistryEvent) => void>();

	constructor(root: string, options: AgentRegistryOptions = {}) {
		this.#root = resolve(root);
		this.#definitionsDir = resolve(this.#root, "definitions");
		this.#workspacesDir = resolve(this.#root, "workspaces");
		this.#catalogDirectory = options.catalogDirectory ? resolve(options.catalogDirectory) : undefined;
		this.#personaDirectory = options.personaDirectory ? resolve(options.personaDirectory) : undefined;
		this.#defaultWorkspace = resolve(options.defaultWorkspace ?? process.cwd());
		this.#modelCatalog = options.modelCatalog;
		this.#modelControlsValidator = options.modelControlsValidator;
		this.#browserWorkflowCatalog = options.browserWorkflowCatalog;
		this.#capabilityValidator = options.capabilityValidator;
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(this.#definitionsDir, { recursive: true }),
			mkdir(this.#workspacesDir, { recursive: true }),
		]);
	}

	async list(): Promise<AgentDefinition[]> {
		await this.initialize();
		const files = (await readdir(this.#definitionsDir)).filter((file) => file.endsWith(".json")).sort();
		const managed = await Promise.all(files.map((file) => this.#read(resolve(this.#definitionsDir, file))));
		const definitions = new Map((await this.#listCatalog()).map((definition) => [definition.id, definition]));
		for (const definition of managed) definitions.set(definition.id, definition);
		return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	async get(id: string): Promise<AgentDefinition | undefined> {
		assertIdentifier(id, "agent id");
		await this.initialize();
		try {
			return await this.#read(resolve(this.#definitionsDir, `${id}.json`));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return this.#readCatalog(id);
			throw error;
		}
	}

	async save(input: AgentDefinitionInput, expectedRevision?: number): Promise<AgentDefinition> {
		return this.#queue.run(async () => {
			await this.initialize();
			const normalized = normalizeDefinition(input, this.#defaultWorkspace);
			this.validateModelSettings(normalized);
			this.#capabilityValidator?.(normalized.capabilities, normalized.executor);
			for (const workflow of normalized.browserWorkflows) {
				if (this.#browserWorkflowCatalog && !this.#browserWorkflowCatalog(workflow.id, workflow.version)) {
					throw new Error(`Browser workflow ${workflow.id} version ${workflow.version} is not active`);
				}
			}
			let previous: AgentDefinition | undefined;
			try {
				previous = await this.#read(resolve(this.#definitionsDir, `${normalized.id}.json`));
			} catch (error) {
				if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			}
			const catalogDefinition = previous ? undefined : await this.#readCatalog(normalized.id);
			const currentRevision = previous?.revision ?? catalogDefinition?.revision ?? 0;
			if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
				throw new Error(
					`Agent ${normalized.id} changed from revision ${expectedRevision} to ${currentRevision}; review it before saving`,
				);
			}
			const definition = { ...normalized, revision: currentRevision + 1 };
			for (const delegateId of definition.delegateAgentIds) {
				if (delegateId === definition.id) throw new Error("An agent cannot delegate to itself");
				if (!(await this.get(delegateId))) throw new Error(`Delegate agent ${delegateId} was not found`);
			}
			await mkdir(definition.projectRoot, { recursive: true });
			const target = resolveWithin(this.#definitionsDir, `${definition.id}.json`, "definition");
			const temporary = resolve(dirname(target), `.${definition.id}.${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			await rename(temporary, target);
			this.#emit({
				type: previous || catalogDefinition ? "agent.updated" : "agent.created",
				agentId: definition.id,
			});
			return definition;
		});
	}

	/** Check the current catalog before saving or starting work, never rewriting stored selections. */
	validateModelSettings(settings: Pick<AgentDefinition, "model" | "thinking" | "modelControls">): void {
		const controls = parseAgentModelControls(settings);
		this.#validateModel(settings.model);
		if (controls !== undefined && settings.model) this.#modelControlsValidator?.(settings.model, controls);
	}

	#validateModel(model: ModelRef | undefined): void {
		if (!model || !this.#modelCatalog) return;
		const catalog = this.#modelCatalog();
		if (catalog.some((entry) => entry.provider === model.provider && entry.id === model.id)) return;
		const comparableId = comparableModelText(model.id);
		const suggestion = catalog.find(
			(entry) =>
				entry.provider.toLowerCase() === model.provider.toLowerCase() &&
				(comparableModelText(entry.id) === comparableId || comparableModelText(entry.name) === comparableId),
		);
		const requested = `${model.provider}/${model.id}`;
		if (suggestion) {
			throw new Error(
				`Agent model ${requested} is not a canonical available model. Use ${suggestion.provider}/${suggestion.id} (${suggestion.name}).`,
			);
		}
		throw new Error(`Agent model ${requested} is unavailable. Select a model from the active Pi model catalog.`);
	}

	async delete(id: string): Promise<boolean> {
		assertIdentifier(id, "agent id");
		return this.#queue.run(async () => {
			try {
				await unlink(resolveWithin(this.#definitionsDir, `${id}.json`, "definition"));
				this.#emit({ type: "agent.removed", agentId: id });
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return false;
				throw error;
			}
		});
	}

	subscribe(listener: (event: AgentRegistryEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: AgentRegistryEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	workspacePath(definition: AgentDefinition): string {
		return resolve(definition.projectRoot);
	}

	async readIcon(id: string): Promise<Uint8Array | undefined> {
		const definition = await this.get(id);
		if (!definition?.personaId || !this.#personaDirectory) return undefined;
		try {
			return new Uint8Array(await readFile(resolve(this.#personaDirectory, definition.personaId, "icon.webp")));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async #read(path: string): Promise<AgentDefinition> {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return normalizeDefinition(value, this.#defaultWorkspace);
	}

	async #listCatalog(): Promise<AgentDefinition[]> {
		if (!this.#catalogDirectory) return [];
		let files: string[];
		try {
			files = (await readdir(this.#catalogDirectory)).filter((file) => file.endsWith(".md")).sort();
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return [];
			throw error;
		}
		const definitions = await Promise.all(
			files.map((file) => this.#readCatalog(basename(file, ".md")).catch(() => undefined)),
		);
		return definitions.filter((definition): definition is AgentDefinition => definition !== undefined);
	}

	async #readCatalog(id: string): Promise<AgentDefinition | undefined> {
		if (!this.#catalogDirectory) return undefined;
		assertIdentifier(id, "agent id");
		let content: string;
		try {
			content = await readFile(resolve(this.#catalogDirectory, `${id}.md`), "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
		const { frontmatter, body } = parseFrontmatter(content);
		const name = requiredString(frontmatter.name, "name");
		const tools = commaSeparatedStrings(frontmatter.tools, "tools");
		const personaId = body.match(/<!-- persona:start name=([a-z0-9-]+) -->/)?.[1];
		return {
			id,
			revision: 1,
			source: "pi-agent",
			personaId,
			name,
			description: requiredString(frontmatter.description, "description"),
			model: parseCatalogModel(frontmatter.model),
			budget: undefined,
			thinking: undefined,
			tools,
			capabilities: [],
			memory: frontmatter.memory === "notes" ? "notes" : "none",
			persona: requiredString(body, "agent prompt"),
			projectRoot: this.#defaultWorkspace,
			workspace: ".",
			executor: "session",
			permissionPolicy: tools.some((tool) => ["bash", "edit", "write"].includes(tool))
				? "workspace-write"
				: "read-only",
			schedules: [],
			browser: { access: "disabled", runtime: "managed-chromium", profile: { kind: "ephemeral" } },
			browserWorkflows: [],
			delegateAgentIds: [],
			a2a: { enabled: false },
		};
	}
}

export function normalizeDefinition(value: unknown, defaultWorkspace: string): AgentDefinition {
	const input = record(value, "agent definition");
	const name = requiredString(input.name, "name");
	const id = input.id === undefined ? slugify(name) : requiredString(input.id, "id");
	assertIdentifier(id, "agent id");
	const projectRoot = resolve(
		input.projectRoot === undefined
			? input.workspace === undefined
				? defaultWorkspace
				: requiredString(input.workspace, "workspace")
			: requiredString(input.projectRoot, "projectRoot"),
	);
	if (projectRoot === parse(projectRoot).root) throw new Error("projectRoot must not be a filesystem root");
	const tools = stringArray(input.tools, "tools");
	const capabilities = normalizeCapabilityGrants(input.capabilities);
	const unsupportedTool = tools.find((tool) => !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(tool));
	if (unsupportedTool) throw new Error(`Unsupported agent tool name: ${unsupportedTool}`);
	const permissionPolicy = oneOf(input.permissionPolicy, ["read-only", "workspace-write"], "permissionPolicy");
	if (permissionPolicy === "read-only" && tools.includes("write")) {
		throw new Error("read-only agents cannot enable the write tool");
	}
	const browser = normalizeBrowserPolicy(input.browser);
	const browserWorkflows = normalizeBrowserWorkflows(input.browserWorkflows);
	if (tools.includes("browser") !== (browser.access !== "disabled")) {
		throw new Error("browser tool and browser access policy must be enabled together");
	}
	if (browserWorkflows.length > 0 && browser.access === "disabled") {
		throw new Error("Assigned browser workflows require browser access");
	}
	return {
		id,
		revision:
			typeof input.revision === "number" && Number.isSafeInteger(input.revision) && input.revision > 0
				? input.revision
				: 1,
		source: "managed",
		personaId: input.personaId === undefined ? undefined : validatedIdentifier(input.personaId, "personaId"),
		name,
		description: requiredString(input.description, "description"),
		model: normalizeModel(input.model),
		budget: normalizeBudget(input.budget),
		thinking: normalizeThinking(input.thinking),
		modelControls: parseAgentModelControls(input),
		tools: [...new Set(tools)],
		capabilities,
		memory: oneOf(input.memory, ["none", "notes"], "memory"),
		persona: requiredString(input.persona, "persona"),
		projectRoot,
		workspace: projectRoot,
		executor: oneOf(input.executor, ["session", "harness"], "executor"),
		permissionPolicy,
		schedules: normalizeSchedules(input.schedules),
		browser,
		browserWorkflows,
		delegateAgentIds: identifierArray(input.delegateAgentIds, "delegateAgentIds"),
		a2a: normalizeA2a(input.a2a),
	};
}

function normalizeThinking(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	return oneOf(value, ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "thinking");
}

function normalizeA2a(value: unknown): { enabled: boolean } {
	if (value === undefined) return { enabled: false };
	const input = record(value, "a2a");
	if (typeof input.enabled !== "boolean") throw new Error("a2a.enabled must be a boolean");
	return { enabled: input.enabled };
}

function normalizeBrowserPolicy(value: unknown): AgentBrowserPolicy {
	if (value === undefined) return { access: "disabled", runtime: "managed-chromium", profile: { kind: "ephemeral" } };
	const input = record(value, "browser");
	const access = oneOf(input.access, ["disabled", "loopback", "public-web", "private-network"], "browser.access");
	const runtime =
		input.runtime === undefined
			? "managed-chromium"
			: oneOf(input.runtime, ["managed-chromium", "installed-chrome"], "browser.runtime");
	const profileInput = record(input.profile, "browser.profile");
	const kind = oneOf(profileInput.kind, ["ephemeral", "named"], "browser.profile.kind");
	if (kind === "ephemeral") return { access, runtime, profile: { kind } };
	return { access, runtime, profile: { kind, id: requiredString(profileInput.id, "browser.profile.id") } };
}

function normalizeBrowserWorkflows(value: unknown): AgentBrowserWorkflowGrant[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("browserWorkflows must be an array");
	const grants = value.map((entry, index) => {
		const input = record(entry, `browserWorkflows[${index}]`);
		const id = validatedIdentifier(input.id, `browserWorkflows[${index}].id`);
		if (!Number.isSafeInteger(input.version) || Number(input.version) < 1) {
			throw new Error(`browserWorkflows[${index}].version must be a positive integer`);
		}
		return { id, version: Number(input.version) };
	});
	if (new Set(grants.map((grant) => `${grant.id}@${grant.version}`)).size !== grants.length) {
		throw new Error("browserWorkflows must not contain duplicate grants");
	}
	return grants;
}

export function normalizeCapabilityGrants(value: unknown): AgentCapabilityGrant[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("capabilities must be an array");
	const grants = value.map((entry, index) => {
		const input = record(entry, `capabilities[${index}]`);
		const capabilityId = requiredString(input.capabilityId, `capabilities[${index}].capabilityId`);
		if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(capabilityId)) {
			throw new Error(`capabilities[${index}].capabilityId is invalid`);
		}
		if (!Number.isSafeInteger(input.capabilityVersion) || Number(input.capabilityVersion) < 1) {
			throw new Error(`capabilities[${index}].capabilityVersion must be a positive integer`);
		}
		return {
			capabilityId,
			capabilityVersion: Number(input.capabilityVersion),
			providerId:
				input.providerId === undefined
					? undefined
					: validatedIdentifier(input.providerId, `capabilities[${index}].providerId`),
			approval:
				input.approval === undefined
					? undefined
					: oneOf(input.approval, ["never", "per-run", "always"], `capabilities[${index}].approval`),
			connectionId:
				input.connectionId === undefined
					? undefined
					: requiredString(input.connectionId, `capabilities[${index}].connectionId`),
		};
	});
	if (new Set(grants.map((grant) => grant.capabilityId)).size !== grants.length) {
		throw new Error("capabilities must not contain duplicate grants");
	}
	return grants;
}

function parseCatalogModel(value: unknown): ModelRef | undefined {
	if (value === undefined) return undefined;
	const text = requiredString(value, "model");
	const separator = text.indexOf("/");
	if (separator < 1 || separator === text.length - 1) throw new Error("model must use provider/id format");
	return { provider: text.slice(0, separator), id: text.slice(separator + 1) };
}

function normalizeModel(value: unknown): ModelRef | undefined {
	if (value === undefined) return undefined;
	const model = record(value, "model");
	return { provider: requiredString(model.provider, "model.provider"), id: requiredString(model.id, "model.id") };
}

function normalizeBudget(value: unknown): AgentDefinition["budget"] {
	if (value === undefined) return undefined;
	const budget = record(value, "budget");
	const maxTokens = budget.maxTokens;
	const maxCostUsd = budget.maxCostUsd;
	if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || Number(maxTokens) < 1)) {
		throw new Error("budget.maxTokens must be a positive integer");
	}
	if (maxCostUsd !== undefined && (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd < 0)) {
		throw new Error("budget.maxCostUsd must be a non-negative number");
	}
	if (maxTokens === undefined && maxCostUsd === undefined) return undefined;
	return {
		maxTokens: maxTokens === undefined ? undefined : Number(maxTokens),
		maxCostUsd: maxCostUsd === undefined ? undefined : maxCostUsd,
	};
}

function comparableModelText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeSchedules(value: unknown): AgentRoutineDefinition[] {
	if (!Array.isArray(value)) throw new Error("schedules must be an array");
	return value.map((entry, index) => {
		const schedule = record(entry, `schedules[${index}]`);
		const id = requiredString(schedule.id, `schedules[${index}].id`);
		assertIdentifier(id, "schedule id");
		const intervalMinutes = schedule.intervalMinutes;
		if (!Number.isSafeInteger(intervalMinutes) || Number(intervalMinutes) < 1) {
			throw new Error(`schedules[${index}].intervalMinutes must be a positive integer`);
		}
		if (typeof schedule.enabled !== "boolean") throw new Error(`schedules[${index}].enabled must be a boolean`);
		return {
			id,
			prompt: requiredString(schedule.prompt, `schedules[${index}].prompt`),
			intervalMinutes: Number(intervalMinutes),
			enabled: schedule.enabled,
		};
	});
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((entry, index) => requiredString(entry, `${name}[${index}]`));
}

function identifierArray(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	const values = stringArray(value, name);
	for (const entry of values) assertIdentifier(entry, name);
	return [...new Set(values)];
}

function commaSeparatedStrings(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	return requiredString(value, name)
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	}
	return value as T;
}

function assertIdentifier(value: string, name: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
		throw new Error(`${name} must contain only lowercase letters, numbers, and hyphens`);
	}
}

function validatedIdentifier(value: unknown, name: string): string {
	const identifier = requiredString(value, name);
	assertIdentifier(identifier, name);
	return identifier;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("name must contain at least one letter or number");
	return slug;
}

function resolveWithin(root: string, child: string, name: string): string {
	const resolved = resolve(root, child);
	const pathFromRoot = relative(root, resolved);
	if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) return resolved;
	throw new Error(`Agent ${name} escapes the registry root`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
