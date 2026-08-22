import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

export interface PersonaCatalogEntry {
	id: string;
	name: string;
	category: string;
	description: string;
	instructions: string;
	image?: string;
}

/** Reads the generated Personas catalog without allowing catalog paths to escape its project root. */
export class PersonaCatalog {
	readonly #projectRoot: string;
	readonly #catalogPath: string;
	readonly #publicRoot: string;
	#entries: PersonaCatalogEntry[] = [];

	constructor(projectRoot: string) {
		this.#projectRoot = resolve(projectRoot);
		this.#catalogPath = resolve(this.#projectRoot, "site", "src", "personas.generated.json");
		this.#publicRoot = resolve(this.#projectRoot, "site", "public");
	}

	async initialize(): Promise<void> {
		const value: unknown = JSON.parse(await readFile(this.#catalogPath, "utf8"));
		if (!Array.isArray(value)) throw new Error("Persona catalog must contain an array");
		this.#entries = value.map((entry, index) => normalizePersona(entry, index));
	}

	list(): PersonaCatalogEntry[] {
		return this.#entries.map((entry) => ({ ...entry }));
	}

	get(id: string): PersonaCatalogEntry | undefined {
		const entry = this.#entries.find((candidate) => candidate.id === id);
		return entry ? { ...entry } : undefined;
	}

	async readImage(id: string): Promise<{ data: Uint8Array; contentType: string } | undefined> {
		const entry = this.#entries.find((candidate) => candidate.id === id);
		if (!entry?.image) return undefined;
		const path = resolveWithin(this.#publicRoot, entry.image);
		try {
			return { data: new Uint8Array(await readFile(path)), contentType: imageContentType(path) };
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}
}

export function resolvePersonaProject(agentDir: string, configured?: string): string | undefined {
	const candidates = [
		process.env.PI_PERSONAS_DIR,
		configured,
		resolve(process.cwd(), "..", "Personas"),
		resolve(agentDir, "..", "..", "Personas"),
	];
	return candidates.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizePersona(value: unknown, index: number): PersonaCatalogEntry {
	const input = object(value, `personas[${index}]`);
	const id = requiredString(input.name, `personas[${index}].name`);
	if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error(`Invalid persona id: ${id}`);
	return {
		id,
		name: requiredString(input.displayName, `personas[${index}].displayName`),
		category: requiredString(input.category, `personas[${index}].category`),
		description: requiredString(input.description, `personas[${index}].description`),
		instructions: requiredString(input.instructions, `personas[${index}].instructions`),
		image: input.image === undefined ? undefined : requiredString(input.image, `personas[${index}].image`),
	};
}

function resolveWithin(root: string, child: string): string {
	if (isAbsolute(child)) throw new Error("Persona image path must be relative");
	const path = resolve(root, child);
	const fromRoot = relative(root, path);
	if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return path;
	throw new Error("Persona image escapes the public directory");
}

function imageContentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
