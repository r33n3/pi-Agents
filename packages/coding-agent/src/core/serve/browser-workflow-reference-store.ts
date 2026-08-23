import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import type { BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface BrowserWorkflowReference {
	workflowId: string;
	workflowVersion: number;
}

export interface BrowserFrontendTest extends BrowserWorkflowReference {
	projectRoot: string;
	attachedAt: number;
}

/** Persists project and skill references to immutable active browser workflows without copying steps. */
export class BrowserWorkflowReferenceStore {
	readonly #referencesFile: string;
	readonly #skillsRoot: string;
	readonly #registry: BrowserWorkflowRegistry;
	readonly #queue = new SerialOperationQueue();
	#frontendTests: BrowserFrontendTest[] = [];

	constructor(root: string, skillsRoot: string, registry: BrowserWorkflowRegistry) {
		this.#referencesFile = resolve(root, "frontend-tests.json");
		this.#skillsRoot = resolve(skillsRoot);
		this.#registry = registry;
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(dirname(this.#referencesFile), { recursive: true }),
			mkdir(this.#skillsRoot, { recursive: true }),
		]);
		try {
			const value: unknown = JSON.parse(await readFile(this.#referencesFile, "utf8"));
			this.#frontendTests = parseFrontendTests(value);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			this.#frontendTests = [];
		}
	}

	listFrontendTests(projectRoot?: string): BrowserFrontendTest[] {
		const normalizedRoot = projectRoot === undefined ? undefined : normalizeProjectRoot(projectRoot);
		return this.#frontendTests
			.filter((entry) => normalizedRoot === undefined || entry.projectRoot === normalizedRoot)
			.map((entry) => ({ ...entry }));
	}

	async attachFrontendTest(projectRoot: string, reference: BrowserWorkflowReference): Promise<BrowserFrontendTest> {
		return this.#queue.run(async () => {
			this.#assertActive(reference);
			const entry: BrowserFrontendTest = {
				...reference,
				projectRoot: normalizeProjectRoot(projectRoot),
				attachedAt: Date.now(),
			};
			this.#frontendTests = [
				...this.#frontendTests.filter(
					(current) => current.projectRoot !== entry.projectRoot || current.workflowId !== entry.workflowId,
				),
				entry,
			];
			await writeAtomic(this.#referencesFile, `${JSON.stringify(this.#frontendTests, null, 2)}\n`);
			return { ...entry };
		});
	}

	async createSkill(reference: BrowserWorkflowReference): Promise<{ name: string; path: string }> {
		this.#assertActive(reference);
		const workflow = this.#registry.get(reference.workflowId, reference.workflowVersion)!;
		const name = `browser-${workflow.id}`;
		const skillDirectory = resolve(this.#skillsRoot, name);
		if (dirname(skillDirectory) !== this.#skillsRoot)
			throw new Error("Browser workflow skill escapes the skill root");
		const path = resolve(skillDirectory, "SKILL.md");
		const content = [
			"---",
			`name: ${name}`,
			`description: Run the validated ${workflow.name} browser workflow through Pi's canonical browser runtime.`,
			"---",
			"",
			`Use this skill only for browser workflow \`${workflow.id}\` version ${workflow.version}.`,
			"",
			"1. Call `browser_workflow_list` and confirm the exact ID and version remain available.",
			`2. Call \`browser_workflow_run\` with \`{ "id": "${workflow.id}", "version": ${workflow.version}, "parameters": { ... } }\`.`,
			"3. Report the run status and failing step evidence. Do not recreate or modify the stored steps.",
			"4. Ask the user before any approval-gated external side effect.",
			"",
		].join("\n");
		await writeAtomic(path, content);
		return { name, path };
	}

	#assertActive(reference: BrowserWorkflowReference): void {
		if (this.#registry.getActive(reference.workflowId)?.version !== reference.workflowVersion) {
			throw new Error(`Browser workflow ${reference.workflowId} version ${reference.workflowVersion} is not active`);
		}
	}
}

function parseFrontendTests(value: unknown): BrowserFrontendTest[] {
	if (!Array.isArray(value)) throw new Error("Browser frontend test references must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`Browser frontend test ${index} is invalid`);
		}
		const input = entry as Record<string, unknown>;
		if (typeof input.workflowId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.workflowId)) {
			throw new Error(`Browser frontend test ${index} workflow id is invalid`);
		}
		if (!Number.isSafeInteger(input.workflowVersion) || Number(input.workflowVersion) < 1) {
			throw new Error(`Browser frontend test ${index} version is invalid`);
		}
		if (!Number.isSafeInteger(input.attachedAt) || Number(input.attachedAt) < 0) {
			throw new Error(`Browser frontend test ${index} timestamp is invalid`);
		}
		return {
			workflowId: input.workflowId,
			workflowVersion: Number(input.workflowVersion),
			projectRoot: normalizeProjectRoot(input.projectRoot),
			attachedAt: Number(input.attachedAt),
		};
	});
}

function normalizeProjectRoot(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Frontend test project root is required");
	const projectRoot = resolve(value.trim());
	if (!isAbsolute(projectRoot) || projectRoot === parse(projectRoot).root) {
		throw new Error("Frontend test project root must be an absolute non-root directory");
	}
	return projectRoot;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
