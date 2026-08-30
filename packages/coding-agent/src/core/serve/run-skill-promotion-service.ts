import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadSkillsFromDir } from "../skills.ts";
import type { AgentBuildLifecycleService } from "./agent-build-lifecycle-service.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";

const MAX_INSTRUCTIONS_LENGTH = 65_536;

export interface RunSkillPromotionInput {
	runId: string;
	name: string;
	description: string;
	instructions: string;
}

export interface RunSkillPromotionResult {
	runId: string;
	name: string;
	path: string;
}

/** Converts a reviewed successful run pattern into one validated user skill. */
export class RunSkillPromotionService {
	readonly #runs: AgentRunManager;
	readonly #skillsRoot: string;
	readonly #lifecycle: AgentBuildLifecycleService | undefined;

	constructor(runs: AgentRunManager, skillsRoot: string, lifecycle?: AgentBuildLifecycleService) {
		this.#runs = runs;
		this.#skillsRoot = resolve(skillsRoot);
		this.#lifecycle = lifecycle;
	}

	async promote(input: RunSkillPromotionInput): Promise<RunSkillPromotionResult> {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.runId)) {
			throw new Error("Run ID must be 1-128 letters, numbers, dots, underscores, or hyphens");
		}
		const run = this.#runs.get(input.runId);
		if (!run) throw new Error(`Run ${input.runId} was not found`);
		if (run.status !== "succeeded") throw new Error("Only a successful run can be promoted");
		if ((await this.#runs.readResult(input.runId)) === undefined) {
			throw new Error("The successful run result is unavailable");
		}
		await this.#lifecycle?.assertPromotionAllowed(input.runId);
		const name = input.name.trim();
		const description = input.description.trim();
		const instructions = input.instructions.trim();
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
			throw new Error("Skill name must be 1-64 lowercase letters, numbers, or single hyphens");
		}
		if (description === "" || description.length > 1_024) {
			throw new Error("Skill description must be 1-1024 characters");
		}
		if (instructions === "" || instructions.length > MAX_INSTRUCTIONS_LENGTH) {
			throw new Error(`Skill instructions must be 1-${MAX_INSTRUCTIONS_LENGTH} characters`);
		}

		await mkdir(this.#skillsRoot, { recursive: true });
		const skillDirectory = resolve(this.#skillsRoot, name);
		if (dirname(skillDirectory) !== this.#skillsRoot) throw new Error("Skill path escapes the user skill directory");
		const lockPath = resolve(this.#skillsRoot, `.promotion-${name}.lock`);
		let lock: Awaited<ReturnType<typeof open>>;
		try {
			lock = await open(lockPath, "wx");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") {
				throw new Error(`Skill ${name} is already being created`);
			}
			throw error;
		}
		const candidateDirectory = resolve(this.#skillsRoot, `.candidate-${randomUUID()}`);
		const candidatePath = resolve(candidateDirectory, "SKILL.md");
		try {
			if (await pathExists(skillDirectory)) throw new Error(`Skill ${name} already exists`);
			await mkdir(candidateDirectory);
			await writeFile(
				candidatePath,
				[
					"---",
					`name: ${name}`,
					`description: ${JSON.stringify(description)}`,
					`source-run-id: ${JSON.stringify(input.runId)}`,
					"---",
					"",
					instructions,
					"",
				].join("\n"),
				"utf8",
			);
			const validation = loadSkillsFromDir({ dir: candidateDirectory, source: "user" });
			if (validation.diagnostics.length > 0 || validation.skills.length !== 1) {
				const detail = validation.diagnostics.map((diagnostic) => diagnostic.message).join("; ");
				throw new Error(`Generated skill did not validate${detail ? `: ${detail}` : ""}`);
			}
			if (validation.skills[0]?.name !== name) throw new Error("Generated skill identity does not match its path");
			await rename(candidateDirectory, skillDirectory);
			const result = { runId: input.runId, name, path: resolve(skillDirectory, "SKILL.md") };
			await this.#lifecycle?.markPromoted(input.runId, result.name, result.path);
			return result;
		} finally {
			await rm(candidateDirectory, { recursive: true, force: true });
			await lock.close();
			await rm(lockPath, { force: true });
		}
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}
