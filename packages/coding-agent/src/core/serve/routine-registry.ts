import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import { validateCron } from "./cron-schedule.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type RoutineTarget =
	| { kind: "agent"; agentId: string }
	| { kind: "workflow"; workflowId: string }
	| {
			kind: "browser-workflow";
			workflowId: string;
			workflowVersion: number;
			parameters: Record<string, string | number | boolean>;
	  }
	| { kind: "acp"; connectionId: string }
	| { kind: "skill"; skillName: string };

export interface RoutineDefinition {
	id: string;
	name: string;
	prompt: string;
	enabled: boolean;
	cron: string;
	timezone: string;
	maxDurationMinutes: number;
	target: RoutineTarget;
	model?: ModelRef;
	cwd?: string;
}

export type RoutineDefinitionInput = Omit<RoutineDefinition, "id"> & { id?: string };

/** Owns durable routine definitions independently from their execution targets. */
export class RoutineRegistry {
	readonly #directory: string;
	readonly #queue = new SerialOperationQueue();
	readonly #browserWorkflowCatalog: ((id: string, version: number) => boolean) | undefined;
	readonly #validator: ((definition: RoutineDefinition) => Promise<void> | void) | undefined;

	constructor(
		directory: string,
		browserWorkflowCatalog?: (id: string, version: number) => boolean,
		validator?: (definition: RoutineDefinition) => Promise<void> | void,
	) {
		this.#directory = resolve(directory);
		this.#browserWorkflowCatalog = browserWorkflowCatalog;
		this.#validator = validator;
	}

	async initialize(): Promise<void> {
		await mkdir(this.#directory, { recursive: true });
	}

	async list(): Promise<RoutineDefinition[]> {
		await this.initialize();
		const files = (await readdir(this.#directory)).filter((file) => file.endsWith(".json")).sort();
		return Promise.all(files.map((file) => this.#read(resolve(this.#directory, file))));
	}

	async get(id: string): Promise<RoutineDefinition | undefined> {
		assertIdentifier(id, "routine id");
		await this.initialize();
		try {
			return await this.#read(resolve(this.#directory, `${id}.json`));
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async save(input: RoutineDefinitionInput): Promise<RoutineDefinition> {
		return this.#queue.run(async () => {
			await this.initialize();
			const definition = normalizeRoutine(input);
			await this.validate(definition);
			const target = resolve(this.#directory, `${definition.id}.json`);
			const temporary = resolve(dirname(target), `.${definition.id}.${randomUUID()}.tmp`);
			await writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
			await rename(temporary, target);
			return definition;
		});
	}

	async validate(definition: RoutineDefinition): Promise<void> {
		if (
			definition.target.kind === "browser-workflow" &&
			this.#browserWorkflowCatalog &&
			!this.#browserWorkflowCatalog(definition.target.workflowId, definition.target.workflowVersion)
		) {
			throw new Error(
				`Browser workflow ${definition.target.workflowId} version ${definition.target.workflowVersion} is not active`,
			);
		}
		await this.#validator?.(definition);
	}

	async delete(id: string): Promise<boolean> {
		assertIdentifier(id, "routine id");
		return this.#queue.run(async () => {
			try {
				await unlink(resolve(this.#directory, `${id}.json`));
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return false;
				throw error;
			}
		});
	}

	async #read(path: string): Promise<RoutineDefinition> {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		return normalizeRoutine(value);
	}
}

function normalizeRoutine(value: unknown): RoutineDefinition {
	const input = record(value, "routine definition");
	const name = requiredString(input.name, "name");
	const id = input.id === undefined ? slugify(name) : requiredString(input.id, "id");
	assertIdentifier(id, "routine id");
	if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
	const cron = requiredString(input.cron, "cron");
	const timezone = requiredString(input.timezone, "timezone");
	validateCron(cron, timezone);
	if (!Number.isSafeInteger(input.maxDurationMinutes) || Number(input.maxDurationMinutes) < 1) {
		throw new Error("maxDurationMinutes must be a positive integer");
	}
	return {
		id,
		name,
		prompt: requiredString(input.prompt, "prompt"),
		enabled: input.enabled,
		cron,
		timezone,
		maxDurationMinutes: Number(input.maxDurationMinutes),
		target: normalizeTarget(input.target),
		model: input.model === undefined ? undefined : normalizeModel(input.model),
		cwd: input.cwd === undefined ? undefined : requiredString(input.cwd, "cwd"),
	};
}

function normalizeTarget(value: unknown): RoutineTarget {
	const target = record(value, "target");
	switch (target.kind) {
		case "agent": {
			const agentId = requiredString(target.agentId, "target.agentId");
			assertIdentifier(agentId, "target agent id");
			return { kind: "agent", agentId };
		}
		case "workflow": {
			const workflowId = requiredString(target.workflowId, "target.workflowId");
			assertIdentifier(workflowId, "target workflow id");
			return { kind: "workflow", workflowId };
		}
		case "browser-workflow": {
			const workflowId = requiredString(target.workflowId, "target.workflowId");
			assertIdentifier(workflowId, "target browser workflow id");
			if (!Number.isSafeInteger(target.workflowVersion) || Number(target.workflowVersion) < 1) {
				throw new Error("target.workflowVersion must be a positive integer");
			}
			return {
				kind: "browser-workflow",
				workflowId,
				workflowVersion: Number(target.workflowVersion),
				parameters: normalizeParameters(target.parameters),
			};
		}
		case "acp": {
			const connectionId = requiredString(target.connectionId, "target.connectionId");
			assertIdentifier(connectionId, "target connection id");
			return { kind: "acp", connectionId };
		}
		case "skill": {
			const skillName = requiredString(target.skillName, "target.skillName");
			if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(skillName)) {
				throw new Error("target skill name contains unsupported characters");
			}
			return { kind: "skill", skillName };
		}
		default:
			throw new Error("target.kind must be one of: agent, workflow, browser-workflow, acp, skill");
	}
}

function normalizeParameters(value: unknown): Record<string, string | number | boolean> {
	const parameters = record(value, "target.parameters");
	const normalized: Record<string, string | number | boolean> = {};
	for (const [name, entry] of Object.entries(parameters)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new Error("target parameter name is invalid");
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`target parameter ${name} must be a string, number, or boolean`);
		}
		normalized[name] = entry;
	}
	return normalized;
}

function normalizeModel(value: unknown): ModelRef {
	const model = record(value, "model");
	return { provider: requiredString(model.provider, "model.provider"), id: requiredString(model.id, "model.id") };
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
