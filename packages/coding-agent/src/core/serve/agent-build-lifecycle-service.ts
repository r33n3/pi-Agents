import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type AgentBuildStage =
	| "draft"
	| "ready-to-test"
	| "testing"
	| "proof-ready"
	| "needs-refinement"
	| "proven"
	| "promoted"
	| "automated";

export interface AgentBuildProof {
	runId: string;
	agentRevision: number;
	prompt: string;
	status: "running" | "succeeded" | "failed" | "aborted";
	finishedAt?: number;
}

export interface AgentBuildRecord {
	id: string;
	revision: number;
	name: string;
	objective: string;
	projectRoot: string;
	stage: AgentBuildStage;
	agentId?: string;
	agentRevision?: number;
	proof?: AgentBuildProof;
	skill?: { name: string; path: string; sourceRunId: string };
	routineIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface AgentBuildDraftInput {
	name: string;
	objective: string;
	projectRoot: string;
}

/** Owns the proof-before-promotion lifecycle independently from model-generated builder prose. */
export class AgentBuildLifecycleService {
	readonly #registry: AgentRegistry;
	readonly #runs: AgentRunManager;
	readonly #path: string;
	readonly #queue = new SerialOperationQueue();
	readonly #records = new Map<string, AgentBuildRecord>();
	#initialized = false;

	constructor(root: string, registry: AgentRegistry, runs: AgentRunManager) {
		this.#registry = registry;
		this.#runs = runs;
		this.#path = resolve(root, "agent-builds.json");
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(dirname(this.#path), { recursive: true });
		try {
			const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (!Array.isArray(value)) throw new Error("Agent build lifecycle store must be an array");
			for (const entry of value) {
				const record = parseRecord(entry);
				this.#records.set(record.id, record);
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		this.#initialized = true;
	}

	async list(): Promise<AgentBuildRecord[]> {
		await this.initialize();
		const records: AgentBuildRecord[] = [];
		for (const id of this.#records.keys()) records.push(await this.get(id));
		return records.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async get(id: string): Promise<AgentBuildRecord> {
		assertIdentifier(id, "build id");
		await this.initialize();
		return this.#queue.run(async () => {
			const record = this.#required(id);
			const changed = await this.#refresh(record);
			if (changed) await this.#persist();
			return cloneRecord(record);
		});
	}

	async createDraft(input: AgentBuildDraftInput): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const draft = normalizeDraft(input);
			const existingAgent = (await this.#registry.list()).find(
				(agent) => agent.name.toLowerCase() === draft.name.toLowerCase(),
			);
			if (existingAgent) {
				throw new Error(`Agent ${existingAgent.name} already exists. Open it to edit or duplicate it.`);
			}
			const duplicateDraft = [...this.#records.values()].find(
				(record) => !record.agentId && record.name.toLowerCase() === draft.name.toLowerCase(),
			);
			if (duplicateDraft) return cloneRecord(duplicateDraft);
			const now = Date.now();
			const record: AgentBuildRecord = {
				id: `build-${randomUUID()}`,
				revision: 1,
				...draft,
				stage: "draft",
				routineIds: [],
				createdAt: now,
				updatedAt: now,
			};
			this.#records.set(record.id, record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async updateDraft(id: string, input: AgentBuildDraftInput): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			const draft = normalizeDraft(input);
			if (record.agentId && draft.name !== record.name) {
				throw new Error("A deployed agent name cannot be changed through its build draft");
			}
			Object.assign(record, draft);
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async ensureForAgent(agentId: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const definition = await this.#requiredAgent(agentId);
			const existing = [...this.#records.values()].find((record) => record.agentId === agentId);
			if (existing) {
				const changed = await this.#alignAgent(existing, definition);
				if (changed) await this.#persist();
				return cloneRecord(existing);
			}
			const now = Date.now();
			const record: AgentBuildRecord = {
				id: `build-${randomUUID()}`,
				revision: 1,
				name: definition.name,
				objective: definition.description,
				projectRoot: definition.projectRoot,
				stage: "ready-to-test",
				agentId: definition.id,
				agentRevision: definition.revision,
				routineIds: [],
				createdAt: now,
				updatedAt: now,
			};
			this.#records.set(record.id, record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async linkAgent(id: string, agentId: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			const definition = await this.#requiredAgent(agentId);
			const other = [...this.#records.values()].find(
				(candidate) => candidate.id !== id && candidate.agentId === agentId,
			);
			if (other) {
				this.#records.delete(id);
				await this.#alignAgent(other, definition);
				await this.#persist();
				return cloneRecord(other);
			}
			record.agentId = definition.id;
			await this.#alignAgent(record, definition);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async startProof(id: string, prompt: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			await this.#refresh(record);
			if (!record.agentId || record.agentRevision === undefined) {
				throw new Error("Deploy the draft before running its proof");
			}
			if (record.stage === "testing") throw new Error("This build already has an active proof run");
			const request = prompt.trim();
			if (!request) throw new Error("A concrete one-time proof task is required");
			const run = await this.#runs.start(record.agentId, request, "manual");
			record.proof = {
				runId: run.id,
				agentRevision: run.agentRevision,
				prompt: request,
				status: "running",
			};
			record.stage = "testing";
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async reviewProof(id: string, accepted: boolean): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			await this.#refresh(record);
			if (!record.proof || record.proof.status !== "succeeded" || record.stage !== "proof-ready") {
				throw new Error("A successful current-revision proof must be reviewed first");
			}
			record.stage = accepted ? "proven" : "needs-refinement";
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async assertPromotionAllowed(runId: string): Promise<AgentBuildRecord> {
		await this.initialize();
		return this.#queue.run(async () => {
			const record = [...this.#records.values()].find((candidate) => candidate.proof?.runId === runId);
			if (!record) throw new Error("This run is not the reviewed proof for an agent build");
			await this.#refresh(record);
			if (
				!record.proof ||
				record.proof.runId !== runId ||
				!["proven", "promoted", "automated"].includes(record.stage)
			) {
				throw new Error("Review and accept this current-revision proof before promoting it to a skill");
			}
			return cloneRecord(record);
		});
	}

	async markPromoted(runId: string, name: string, path: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = [...this.#records.values()].find((candidate) => candidate.proof?.runId === runId);
			if (!record) throw new Error("The promoted proof is not attached to an agent build");
			record.skill = { name, path, sourceRunId: runId };
			record.stage = record.routineIds.length > 0 ? "automated" : "promoted";
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async assertAutomationAllowed(agentId: string): Promise<AgentBuildRecord> {
		await this.initialize();
		return this.#queue.run(async () => {
			const record = [...this.#records.values()].find((candidate) => candidate.agentId === agentId);
			if (!record) throw new Error("Prove and promote this agent before adding automation");
			await this.#refresh(record);
			if (!record.skill || !["promoted", "automated"].includes(record.stage)) {
				throw new Error("Prove this agent, accept the result, and promote it to a skill before adding automation");
			}
			return cloneRecord(record);
		});
	}

	async markAutomated(agentId: string, routineId: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = [...this.#records.values()].find((candidate) => candidate.agentId === agentId);
			if (!record?.skill) throw new Error("The agent build has not been promoted to a skill");
			if (!record.routineIds.includes(routineId)) record.routineIds.push(routineId);
			record.stage = "automated";
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	#required(id: string): AgentBuildRecord {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Agent build ${id} was not found`);
		return record;
	}

	async #requiredAgent(id: string): Promise<AgentDefinition> {
		const definition = await this.#registry.get(id);
		if (!definition) throw new Error(`Agent ${id} was not found`);
		return definition;
	}

	async #alignAgent(record: AgentBuildRecord, definition: AgentDefinition): Promise<boolean> {
		const changed =
			record.agentId !== definition.id ||
			record.agentRevision !== definition.revision ||
			record.name !== definition.name ||
			record.objective !== definition.description ||
			record.projectRoot !== definition.projectRoot;
		if (!changed) return this.#refresh(record);
		const revisionChanged = record.agentRevision !== undefined && record.agentRevision !== definition.revision;
		record.agentId = definition.id;
		record.agentRevision = definition.revision;
		record.name = definition.name;
		record.objective = definition.description;
		record.projectRoot = definition.projectRoot;
		if (revisionChanged) {
			record.proof = undefined;
			record.skill = undefined;
			record.routineIds = [];
		}
		if (!record.proof) record.stage = "ready-to-test";
		this.#touch(record);
		return true;
	}

	async #refresh(record: AgentBuildRecord): Promise<boolean> {
		if (record.agentId) {
			const definition = await this.#registry.get(record.agentId);
			if (definition && definition.revision !== record.agentRevision) return this.#alignAgent(record, definition);
		}
		if (!record.proof) return false;
		const run = this.#runs.get(record.proof.runId);
		if (!run) {
			record.stage = "needs-refinement";
			record.proof.status = "failed";
			this.#touch(record);
			return true;
		}
		const status = run.status === "starting" || run.status === "running" ? "running" : run.status;
		const changed = record.proof.status !== status || record.proof.finishedAt !== run.finishedAt;
		if (!changed) return false;
		record.proof.status = status;
		record.proof.finishedAt = run.finishedAt;
		if (run.agentRevision !== record.agentRevision || run.agentRevision !== record.proof.agentRevision) {
			record.stage = "ready-to-test";
			record.proof = undefined;
		} else if (status === "running") record.stage = "testing";
		else if (status === "succeeded") record.stage = "proof-ready";
		else record.stage = "needs-refinement";
		this.#touch(record);
		return true;
	}

	#touch(record: AgentBuildRecord): void {
		record.revision += 1;
		record.updatedAt = Date.now();
	}

	async #persist(): Promise<void> {
		const temporary = `${this.#path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify([...this.#records.values()], null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, this.#path);
	}
}

function normalizeDraft(input: AgentBuildDraftInput): AgentBuildDraftInput {
	const name = input.name.trim();
	const objective = input.objective.trim();
	const projectRoot = resolve(input.projectRoot.trim());
	if (!name || name.length > 128) throw new Error("Agent draft name must be 1-128 characters");
	if (!objective || objective.length > 2_048) throw new Error("Agent draft objective must be 1-2048 characters");
	if (!input.projectRoot.trim()) throw new Error("Agent draft project root is required");
	return { name, objective, projectRoot };
}

function parseRecord(value: unknown): AgentBuildRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid agent build record");
	const record = value as Partial<AgentBuildRecord>;
	assertIdentifier(requiredString(record.id, "build id"), "build id");
	if (!Number.isSafeInteger(record.revision) || Number(record.revision) < 1) throw new Error("Invalid build revision");
	if (!isStage(record.stage)) throw new Error("Invalid agent build stage");
	if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt))
		throw new Error("Invalid build timestamp");
	return {
		id: record.id!,
		revision: Number(record.revision),
		name: requiredString(record.name, "build name"),
		objective: requiredString(record.objective, "build objective"),
		projectRoot: requiredString(record.projectRoot, "build project root"),
		stage: record.stage,
		agentId: optionalString(record.agentId),
		agentRevision:
			record.agentRevision === undefined || !Number.isSafeInteger(record.agentRevision)
				? undefined
				: Number(record.agentRevision),
		proof: parseProof(record.proof),
		skill: parseSkill(record.skill),
		routineIds: Array.isArray(record.routineIds)
			? record.routineIds.map((entry) => requiredString(entry, "routine id"))
			: [],
		createdAt: Number(record.createdAt),
		updatedAt: Number(record.updatedAt),
	};
}

function parseProof(value: unknown): AgentBuildProof | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid build proof");
	const proof = value as Partial<AgentBuildProof>;
	if (!Number.isSafeInteger(proof.agentRevision) || Number(proof.agentRevision) < 1) {
		throw new Error("Invalid proof agent revision");
	}
	if (!proofStatus(proof.status)) throw new Error("Invalid build proof status");
	return {
		runId: requiredString(proof.runId, "proof run id"),
		agentRevision: Number(proof.agentRevision),
		prompt: requiredString(proof.prompt, "proof prompt"),
		status: proof.status,
		finishedAt: typeof proof.finishedAt === "number" ? proof.finishedAt : undefined,
	};
}

function parseSkill(value: unknown): AgentBuildRecord["skill"] {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid promoted skill");
	const skill = value as Record<string, unknown>;
	return {
		name: requiredString(skill.name, "skill name"),
		path: requiredString(skill.path, "skill path"),
		sourceRunId: requiredString(skill.sourceRunId, "skill source run id"),
	};
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertIdentifier(value: string, name: string): void {
	if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) {
		throw new Error(`${name} must contain only lowercase letters, numbers, and hyphens`);
	}
}

function isStage(value: unknown): value is AgentBuildStage {
	return [
		"draft",
		"ready-to-test",
		"testing",
		"proof-ready",
		"needs-refinement",
		"proven",
		"promoted",
		"automated",
	].includes(String(value));
}

function proofStatus(value: unknown): value is AgentBuildProof["status"] {
	return ["running", "succeeded", "failed", "aborted"].includes(String(value));
}

function cloneRecord(record: AgentBuildRecord): AgentBuildRecord {
	return structuredClone(record);
}
