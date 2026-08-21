import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { BrowserAccess } from "./browser-policy.ts";
import type { BrowserProfile } from "./browser-profile-store.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentExecutorKind = "session" | "harness";
export type AgentMemoryKind = "none" | "notes";
export type AgentPermissionPolicy = "read-only" | "workspace-write";
export type AgentDefinitionSource = "managed" | "pi-agent";

export interface AgentBrowserPolicy {
	access: BrowserAccess;
	profile: BrowserProfile;
}

export interface AgentRoutineDefinition {
	id: string;
	prompt: string;
	intervalMinutes: number;
	enabled: boolean;
}

export interface AgentDefinition {
	id: string;
	source: AgentDefinitionSource;
	personaId?: string;
	name: string;
	description: string;
	model?: ModelRef;
	tools: string[];
	memory: AgentMemoryKind;
	persona: string;
	workspace: string;
	executor: AgentExecutorKind;
	permissionPolicy: AgentPermissionPolicy;
	schedules: AgentRoutineDefinition[];
	browser?: AgentBrowserPolicy;
}

export type AgentDefinitionInput = Omit<AgentDefinition, "id" | "personaId" | "source" | "workspace"> & {
	id?: string;
	workspace?: string;
};

export interface AgentRegistryOptions {
	catalogDirectory?: string;
	personaDirectory?: string;
	defaultWorkspace?: string;
}

/** Owns durable agent definitions and guarantees every workspace stays under its configured root. */
export class AgentRegistry {
	readonly #root: string;
	readonly #definitionsDir: string;
	readonly #workspacesDir: string;
	readonly #catalogDirectory: string | undefined;
	readonly #personaDirectory: string | undefined;
	readonly #defaultWorkspace: string;
	readonly #queue = new SerialOperationQueue();

	constructor(root: string, options: AgentRegistryOptions = {}) {
		this.#root = resolve(root);
		this.#definitionsDir = resolve(this.#root, "definitions");
		this.#workspacesDir = resolve(this.#root, "workspaces");
		this.#catalogDirectory = options.catalogDirectory ? resolve(options.catalogDirectory) : undefined;
		this.#personaDirectory = options.personaDirectory ? resolve(options.personaDirectory) : undefined;
		this.#defaultWorkspace = resolve(options.defaultWorkspace ?? process.cwd());
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
		const definitions = new Map(managed.map((definition) => [definition.id, definition]));
		for (const definition of await this.#listCatalog()) definitions.set(definition.id, definition);
		return [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name));
	}

	async get(id: string): Promise<AgentDefinition | undefined> {
		assertIdentifier(id, "agent id");
		await this.initialize();
		const catalogDefinition = await this.#readCatalog(id);
		if (catalogDefinition) return catalogDefinition;
		try {
			return await this.#read(resolve(this.#definitionsDir, `${id}.json`));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async save(input: AgentDefinitionInput): Promise<AgentDefinition> {
		return this.#queue.run(async () => {
			await this.initialize();
			const definition = normalizeDefinition(input);
			if (await this.#readCatalog(definition.id)) {
				throw new Error(`Agent ${definition.id} is managed by the Pi Markdown agent catalog`);
			}
			const workspace = resolveWithin(this.#root, definition.workspace, "workspace");
			await mkdir(workspace, { recursive: true });
			const target = resolveWithin(this.#definitionsDir, `${definition.id}.json`, "definition");
			const temporary = resolve(dirname(target), `.${definition.id}.${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			await rename(temporary, target);
			return definition;
		});
	}

	workspacePath(definition: AgentDefinition): string {
		if (definition.source === "pi-agent") return this.#defaultWorkspace;
		return resolveWithin(this.#root, definition.workspace, "workspace");
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
		return normalizeDefinition(value);
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
			source: "pi-agent",
			personaId,
			name,
			description: requiredString(frontmatter.description, "description"),
			model: parseCatalogModel(frontmatter.model),
			tools,
			memory: frontmatter.memory === "notes" ? "notes" : "none",
			persona: requiredString(body, "agent prompt"),
			workspace: ".",
			executor: "session",
			permissionPolicy: tools.some((tool) => ["bash", "edit", "write"].includes(tool))
				? "workspace-write"
				: "read-only",
			schedules: [],
			browser: { access: "disabled", profile: { kind: "ephemeral" } },
		};
	}
}

function normalizeDefinition(value: unknown): AgentDefinition {
	const input = record(value, "agent definition");
	const name = requiredString(input.name, "name");
	const id = input.id === undefined ? slugify(name) : requiredString(input.id, "id");
	assertIdentifier(id, "agent id");
	const workspace = input.workspace === undefined ? `workspaces/${id}` : requiredString(input.workspace, "workspace");
	if (isAbsolute(workspace)) throw new Error("Agent workspace must be relative to the registry root");
	const tools = stringArray(input.tools, "tools");
	const unsupportedTool = tools.find((tool) => !["read", "list", "write", "browser"].includes(tool));
	if (unsupportedTool) throw new Error(`Unsupported isolated agent tool: ${unsupportedTool}`);
	const permissionPolicy = oneOf(input.permissionPolicy, ["read-only", "workspace-write"], "permissionPolicy");
	if (permissionPolicy === "read-only" && tools.includes("write")) {
		throw new Error("read-only agents cannot enable the write tool");
	}
	const browser = normalizeBrowserPolicy(input.browser);
	if (tools.includes("browser") !== (browser.access !== "disabled")) {
		throw new Error("browser tool and browser access policy must be enabled together");
	}
	return {
		id,
		source: "managed",
		name,
		description: requiredString(input.description, "description"),
		model: normalizeModel(input.model),
		tools: [...new Set(tools)],
		memory: oneOf(input.memory, ["none", "notes"], "memory"),
		persona: requiredString(input.persona, "persona"),
		workspace,
		executor: oneOf(input.executor, ["session", "harness"], "executor"),
		permissionPolicy,
		schedules: normalizeSchedules(input.schedules),
		browser,
	};
}

function normalizeBrowserPolicy(value: unknown): AgentBrowserPolicy {
	if (value === undefined) return { access: "disabled", profile: { kind: "ephemeral" } };
	const input = record(value, "browser");
	const access = oneOf(input.access, ["disabled", "loopback", "public-web", "private-network"], "browser.access");
	const profileInput = record(input.profile, "browser.profile");
	const kind = oneOf(profileInput.kind, ["ephemeral", "named"], "browser.profile.kind");
	if (kind === "ephemeral") return { access, profile: { kind } };
	return { access, profile: { kind, id: requiredString(profileInput.id, "browser.profile.id") } };
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
