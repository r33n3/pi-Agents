import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
	AgentDefinition,
	AgentDefinitionInput,
	AgentExecutorKind,
	AgentMemoryKind,
	AgentPermissionPolicy,
	AgentRegistry,
} from "./agent-registry.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";
import type { BrowserAccess } from "./browser-policy.ts";
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
	artifactBaselines?: Record<string, AgentBuildArtifactSnapshot | null>;
}

export type AgentBuildCriterionExpectation = "required-improvement" | "non-regression" | "advisory";
export type AgentBuildCriterionCategory =
	| "goal-obligation"
	| "workflow-fit"
	| "preference-tradeoff"
	| "success-preservation"
	| "output-contract"
	| "grounding-integrity"
	| "refusal-honesty"
	| "safety-authority"
	| "reliability";

export type AgentBuildCriterionEvaluator =
	| { type: "human" }
	| { type: "tool-receipt"; toolNames: string[]; minimumSuccesses: number; requireNonEmpty: boolean }
	| { type: "tool-errors"; toolNames: string[]; maximumErrors: number }
	| { type: "workspace-mutation"; toolNames: string[]; minimumSuccesses: number }
	| { type: "result-text"; mode: "contains" | "omits"; text: string }
	| { type: "artifact-text"; path: string; mode: "contains" | "omits"; text: string }
	| { type: "artifact-change"; path: string };

export interface AgentBuildCriterion {
	id: string;
	label: string;
	description: string;
	category: AgentBuildCriterionCategory;
	expectation: AgentBuildCriterionExpectation;
	evaluator: AgentBuildCriterionEvaluator;
}

export interface AgentBuildCriterionResult {
	criterionId: string;
	status: "pass" | "fail" | "unverified";
	summary: string;
	evidence: string[];
}

export interface AgentBuildEvaluation {
	runId: string;
	evaluatedAt: number;
	checks: AgentBuildCriterionResult[];
}

export interface AgentBuildProofAttempt {
	proof: AgentBuildProof;
	evaluation?: AgentBuildEvaluation;
}

export interface AgentBuildFeedback {
	id: string;
	proofRunId: string;
	rating: 1 | 2 | 3 | 4 | 5;
	summary: string;
	answers: Array<{
		aspect: "goal-obligation" | "workflow-fit" | "preference-tradeoff" | "success-preservation";
		question: string;
		answer: string;
	}>;
	createdAt: number;
}

interface AgentBuildArtifactSnapshot {
	modifiedAt: number;
	size: number;
}

export interface AgentBuildRecord {
	id: string;
	revision: number;
	name: string;
	objective: string;
	projectRoot: string;
	configuration?: AgentBuildConfiguration;
	activeConfiguration?: AgentBuildConfiguration;
	candidateRevision?: number;
	automationIntent?: AgentBuildAutomationIntent;
	criteria: AgentBuildCriterion[];
	feedback: AgentBuildFeedback[];
	evaluation?: AgentBuildEvaluation;
	proofHistory: AgentBuildProofAttempt[];
	stage: AgentBuildStage;
	agentId?: string;
	agentRevision?: number;
	proof?: AgentBuildProof;
	proofPrompt?: string;
	skill?: { name: string; path: string; sourceRunId: string };
	routineIds: string[];
	createdAt: number;
	updatedAt: number;
}

export interface AgentBuildDraftInput {
	name: string;
	objective: string;
	projectRoot: string;
	configuration?: unknown;
	automationIntent?: unknown;
	criteria?: unknown;
	agentId?: string;
}

export interface AgentBuildFeedbackInput {
	rating: number;
	summary: string;
	answers?: unknown;
	criteria?: unknown;
}

export interface AgentBuildConfiguration {
	name: string;
	description: string;
	persona: string;
	projectRoot: string;
	tools: string[];
	model?: { provider: string; id: string };
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	memory: AgentMemoryKind;
	executor: AgentExecutorKind;
	permissionPolicy: AgentPermissionPolicy;
	browserAccess: BrowserAccess;
	delegateAgentIds: string[];
	exposeA2a: boolean;
}

export interface AgentBuildAutomationIntent {
	task: string;
	cadence: string;
	timezone: string;
	mode: "replace" | "additional";
	confirmed: boolean;
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
			if (draft.agentId) return this.#stageAgentDraft(draft);
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
				name: draft.name,
				objective: draft.objective,
				projectRoot: draft.projectRoot,
				configuration: draft.configuration,
				automationIntent: draft.automationIntent,
				criteria: draft.criteria ?? starterCriteria(),
				feedback: [],
				proofHistory: [],
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
			record.name = draft.name;
			record.objective = draft.objective;
			record.projectRoot = draft.projectRoot;
			record.configuration = draft.configuration ?? record.configuration;
			record.automationIntent = draft.automationIntent ?? record.automationIntent;
			record.criteria = draft.criteria ?? record.criteria;
			if (record.agentId) {
				const active = await this.#requiredAgent(record.agentId);
				record.agentRevision = active.revision;
				record.activeConfiguration = configurationFromAgent(active);
				record.candidateRevision = active.revision + 1;
			}
			this.#invalidateEvidence(record);
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async stageDraft(input: AgentBuildDraftInput): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const draft = normalizeDraft(input);
			if (draft.agentId) return this.#stageAgentDraft(draft);
			const existingAgent = (await this.#registry.list()).find(
				(agent) => agent.name.toLowerCase() === draft.name.toLowerCase(),
			);
			if (existingAgent) return this.#stageAgentDraft({ ...draft, agentId: existingAgent.id });
			const existingDraft = [...this.#records.values()].find(
				(record) => !record.agentId && record.name.toLowerCase() === draft.name.toLowerCase(),
			);
			if (existingDraft) {
				existingDraft.name = draft.name;
				existingDraft.objective = draft.objective;
				existingDraft.projectRoot = draft.projectRoot;
				existingDraft.configuration = draft.configuration ?? existingDraft.configuration;
				existingDraft.automationIntent = draft.automationIntent ?? existingDraft.automationIntent;
				existingDraft.criteria = draft.criteria ?? existingDraft.criteria;
				this.#invalidateEvidence(existingDraft);
				this.#touch(existingDraft);
				await this.#persist();
				return cloneRecord(existingDraft);
			}
			const now = Date.now();
			const record: AgentBuildRecord = {
				id: `build-${randomUUID()}`,
				revision: 1,
				name: draft.name,
				objective: draft.objective,
				projectRoot: draft.projectRoot,
				configuration: draft.configuration,
				automationIntent: draft.automationIntent,
				criteria: draft.criteria ?? starterCriteria(),
				feedback: [],
				proofHistory: [],
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
				configuration: configurationFromAgent(definition),
				activeConfiguration: configurationFromAgent(definition),
				criteria: starterCriteria(),
				feedback: [],
				proofHistory: [],
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

	async publishDraft(id: string): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			if (record.agentId) throw new Error("Existing-agent edits must pass proof before promotion");
			if (!record.configuration) throw new Error("Complete the agent package before publishing it");
			const definition = await this.#registry.save(newAgentInput(record.configuration));
			record.agentId = definition.id;
			record.agentRevision = definition.revision;
			record.activeConfiguration = configurationFromAgent(definition);
			record.configuration = configurationFromAgent(definition);
			record.candidateRevision = undefined;
			record.stage = "ready-to-test";
			this.#touch(record);
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
			this.#archiveProof(record);
			const artifactBaselines = await captureArtifactBaselines(record);
			const activeDefinition = await this.#requiredAgent(record.agentId);
			const run =
				record.candidateRevision && record.configuration
					? await this.#runs.startCandidate(
							candidateDefinition(activeDefinition, record.configuration, record.candidateRevision),
							request,
						)
					: await this.#runs.start(record.agentId, request, "manual");
			record.proof = {
				runId: run.id,
				agentRevision: run.agentRevision,
				prompt: request,
				status: "running",
				artifactBaselines,
			};
			record.proofPrompt = request;
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
			if (accepted && hasBlockingEvaluationResult(record)) {
				throw new Error("Resolve every required failed or unverified evidence check before accepting this proof");
			}
			if (accepted && record.evaluation) {
				for (const check of record.evaluation.checks) {
					const criterion = record.criteria.find((candidate) => candidate.id === check.criterionId);
					if (criterion?.evaluator.type === "human") {
						check.status = "pass";
						check.summary = "Accepted during human proof review";
					}
				}
			}
			record.stage = accepted ? "proven" : "needs-refinement";
			this.#touch(record);
			await this.#persist();
			return cloneRecord(record);
		});
	}

	async recordFeedback(id: string, input: AgentBuildFeedbackInput): Promise<AgentBuildRecord> {
		return this.#queue.run(async () => {
			await this.initialize();
			const record = this.#required(id);
			await this.#refresh(record);
			if (!record.proof || record.proof.status !== "succeeded") {
				throw new Error("Feedback must be attached to a completed proof");
			}
			const rating = parseRating(input.rating);
			const feedback: AgentBuildFeedback = {
				id: `feedback-${randomUUID()}`,
				proofRunId: record.proof.runId,
				rating,
				summary: requiredString(input.summary, "feedback summary"),
				answers: parseFeedbackAnswers(input.answers),
				createdAt: Date.now(),
			};
			record.feedback.push(feedback);
			const criteria = parseCriteria(input.criteria);
			if (criteria) {
				record.criteria = mergeCriteria(record.criteria, criteria);
				record.evaluation = await evaluateProof(record, this.#runs);
			}
			if (rating <= 3) record.stage = "needs-refinement";
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
			if (record.candidateRevision && record.configuration && record.agentId) {
				const active = await this.#requiredAgent(record.agentId);
				if (active.revision !== record.agentRevision) {
					throw new Error("The active agent changed after this candidate was proven; restage and rerun the proof");
				}
				const promoted = await this.#registry.save(candidateInput(active, record.configuration));
				record.agentRevision = promoted.revision;
				record.activeConfiguration = configurationFromAgent(promoted);
				record.configuration = configurationFromAgent(promoted);
				record.candidateRevision = undefined;
			}
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
		record.configuration = configurationFromAgent(definition);
		record.activeConfiguration = configurationFromAgent(definition);
		record.candidateRevision = undefined;
		if (revisionChanged) {
			this.#archiveProof(record);
			record.proof = undefined;
			record.evaluation = undefined;
		}
		if (!record.proof) record.stage = "ready-to-test";
		this.#touch(record);
		return true;
	}

	async #stageAgentDraft(draft: NormalizedAgentBuildDraft): Promise<AgentBuildRecord> {
		const agentId = draft.agentId!;
		const definition = await this.#requiredAgent(agentId);
		const record = [...this.#records.values()].find((candidate) => candidate.agentId === agentId) ?? {
			id: `build-${randomUUID()}`,
			revision: 0,
			name: definition.name,
			objective: definition.description,
			projectRoot: definition.projectRoot,
			stage: "draft" as const,
			agentId,
			agentRevision: definition.revision,
			criteria: starterCriteria(),
			feedback: [],
			proofHistory: [],
			routineIds: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		record.name = draft.name;
		record.objective = draft.objective;
		record.projectRoot = draft.projectRoot;
		record.configuration = draft.configuration ?? record.configuration ?? configurationFromAgent(definition);
		record.activeConfiguration = configurationFromAgent(definition);
		record.candidateRevision = definition.revision + 1;
		record.automationIntent = draft.automationIntent ?? record.automationIntent;
		record.criteria = draft.criteria ?? record.criteria;
		record.agentId = agentId;
		record.agentRevision = definition.revision;
		this.#invalidateEvidence(record);
		this.#touch(record);
		this.#records.set(record.id, record);
		await this.#persist();
		return cloneRecord(record);
	}

	#invalidateEvidence(record: AgentBuildRecord): void {
		this.#archiveProof(record);
		record.proof = undefined;
		record.evaluation = undefined;
		record.stage = "draft";
	}

	#archiveProof(record: AgentBuildRecord): void {
		if (!record.proof || record.proofHistory.some((attempt) => attempt.proof.runId === record.proof?.runId)) return;
		record.proofHistory.push({
			proof: structuredClone(record.proof),
			evaluation: record.evaluation ? structuredClone(record.evaluation) : undefined,
		});
		if (record.proofHistory.length > 20) record.proofHistory.splice(0, record.proofHistory.length - 20);
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
		const changed =
			record.proof.status !== status ||
			record.proof.finishedAt !== run.finishedAt ||
			(status === "succeeded" && record.evaluation?.runId !== record.proof.runId);
		if (!changed) return false;
		record.proof.status = status;
		record.proof.finishedAt = run.finishedAt;
		const expectedRevision = record.candidateRevision ?? record.agentRevision;
		if (run.agentRevision !== expectedRevision || run.agentRevision !== record.proof.agentRevision) {
			record.stage = "ready-to-test";
			record.proof = undefined;
		} else if (status === "running") record.stage = "testing";
		else if (status === "succeeded") {
			record.evaluation = await evaluateProof(record, this.#runs);
			record.stage = hasBlockingEvaluationResult(record) ? "needs-refinement" : "proof-ready";
		} else record.stage = "needs-refinement";
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

interface NormalizedAgentBuildDraft {
	name: string;
	objective: string;
	projectRoot: string;
	configuration?: AgentBuildConfiguration;
	automationIntent?: AgentBuildAutomationIntent;
	criteria?: AgentBuildCriterion[];
	agentId?: string;
}

function normalizeDraft(input: AgentBuildDraftInput): NormalizedAgentBuildDraft {
	const name = input.name.trim();
	const objective = input.objective.trim();
	const projectRoot = resolve(input.projectRoot.trim());
	if (!name || name.length > 128) throw new Error("Agent draft name must be 1-128 characters");
	if (!objective || objective.length > 2_048) throw new Error("Agent draft objective must be 1-2048 characters");
	if (!input.projectRoot.trim()) throw new Error("Agent draft project root is required");
	return {
		name,
		objective,
		projectRoot,
		configuration: parseConfiguration(input.configuration),
		automationIntent: parseAutomationIntent(input.automationIntent),
		criteria: parseCriteria(input.criteria),
		agentId: input.agentId === undefined ? undefined : validatedIdentifier(input.agentId, "agent id"),
	};
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
		configuration: parseConfiguration(record.configuration),
		activeConfiguration: parseConfiguration(record.activeConfiguration),
		candidateRevision:
			record.candidateRevision === undefined || !Number.isSafeInteger(record.candidateRevision)
				? undefined
				: Number(record.candidateRevision),
		automationIntent: parseAutomationIntent(record.automationIntent),
		criteria: parseCriteria(record.criteria) ?? starterCriteria(),
		feedback: parseFeedback(record.feedback),
		evaluation: parseEvaluation(record.evaluation),
		proofHistory: parseProofHistory(record.proofHistory),
		stage: record.stage,
		agentId: optionalString(record.agentId),
		agentRevision:
			record.agentRevision === undefined || !Number.isSafeInteger(record.agentRevision)
				? undefined
				: Number(record.agentRevision),
		proof: parseProof(record.proof),
		proofPrompt: optionalString(record.proofPrompt),
		skill: parseSkill(record.skill),
		routineIds: Array.isArray(record.routineIds)
			? record.routineIds.map((entry) => requiredString(entry, "routine id"))
			: [],
		createdAt: Number(record.createdAt),
		updatedAt: Number(record.updatedAt),
	};
}

function configurationFromAgent(definition: AgentDefinition): AgentBuildConfiguration {
	return {
		name: definition.name,
		description: definition.description,
		persona: definition.persona,
		projectRoot: definition.projectRoot,
		tools: [...definition.tools],
		model: definition.model ? { ...definition.model } : undefined,
		thinking: definition.thinking,
		memory: definition.memory,
		executor: definition.executor,
		permissionPolicy: definition.permissionPolicy,
		browserAccess: definition.browser?.access ?? "disabled",
		delegateAgentIds: [...definition.delegateAgentIds],
		exposeA2a: definition.a2a.enabled,
	};
}

function candidateDefinition(
	active: AgentDefinition,
	configuration: AgentBuildConfiguration,
	revision: number,
): AgentDefinition {
	return {
		...active,
		...candidateInput(active, configuration),
		revision,
		source: active.source,
		workspace: resolve(configuration.projectRoot),
		projectRoot: resolve(configuration.projectRoot),
		browser: {
			access: configuration.browserAccess,
			runtime: active.browser?.runtime ?? "managed-chromium",
			profile: structuredClone(active.browser?.profile ?? { kind: "ephemeral" }),
		},
	};
}

function candidateInput(active: AgentDefinition, configuration: AgentBuildConfiguration): AgentDefinitionInput {
	return {
		id: active.id,
		personaId: active.personaId,
		name: configuration.name,
		description: configuration.description,
		model: configuration.model,
		budget: active.budget,
		thinking: configuration.thinking,
		tools: [...configuration.tools],
		capabilities: structuredClone(active.capabilities),
		memory: configuration.memory,
		persona: configuration.persona,
		projectRoot: configuration.projectRoot,
		executor: configuration.executor,
		permissionPolicy: configuration.permissionPolicy,
		schedules: structuredClone(active.schedules),
		browser: {
			access: configuration.browserAccess,
			runtime: active.browser?.runtime ?? "managed-chromium",
			profile: structuredClone(active.browser?.profile ?? { kind: "ephemeral" }),
		},
		browserWorkflows: structuredClone(active.browserWorkflows),
		delegateAgentIds: [...configuration.delegateAgentIds],
		a2a: { enabled: configuration.exposeA2a },
	};
}

function newAgentInput(configuration: AgentBuildConfiguration): AgentDefinitionInput {
	return {
		name: configuration.name,
		description: configuration.description,
		model: configuration.model,
		thinking: configuration.thinking,
		tools: [...configuration.tools],
		capabilities: [],
		memory: configuration.memory,
		persona: configuration.persona,
		projectRoot: configuration.projectRoot,
		executor: configuration.executor,
		permissionPolicy: configuration.permissionPolicy,
		schedules: [],
		browser: {
			access: configuration.browserAccess,
			runtime: "managed-chromium",
			profile: { kind: "ephemeral" },
		},
		browserWorkflows: [],
		delegateAgentIds: [...configuration.delegateAgentIds],
		a2a: { enabled: configuration.exposeA2a },
	};
}

function parseConfiguration(value: unknown): AgentBuildConfiguration | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid agent build configuration");
	}
	const configuration = value as Record<string, unknown>;
	const model = configuration.model;
	let parsedModel: AgentBuildConfiguration["model"];
	if (model !== undefined) {
		if (typeof model !== "object" || model === null || Array.isArray(model)) {
			throw new Error("Invalid agent build model");
		}
		const reference = model as Record<string, unknown>;
		parsedModel = {
			provider: requiredString(reference.provider, "model provider"),
			id: requiredString(reference.id, "model id"),
		};
	}
	return {
		name: requiredString(configuration.name, "configuration name"),
		description: requiredString(configuration.description, "configuration description"),
		persona: requiredString(configuration.persona, "configuration persona"),
		projectRoot: resolve(requiredString(configuration.projectRoot, "configuration project root")),
		tools: parseStringArray(configuration.tools, "configuration tools"),
		model: parsedModel,
		thinking:
			configuration.thinking === undefined
				? undefined
				: oneOf(
						configuration.thinking,
						["off", "minimal", "low", "medium", "high", "xhigh", "max"],
						"configuration thinking",
					),
		memory: oneOf(configuration.memory, ["none", "notes"], "configuration memory"),
		executor: oneOf(configuration.executor, ["session", "harness"], "configuration executor"),
		permissionPolicy: oneOf(
			configuration.permissionPolicy,
			["read-only", "workspace-write"],
			"configuration permission policy",
		),
		browserAccess: oneOf(
			configuration.browserAccess,
			["disabled", "loopback", "public-web", "private-network"],
			"configuration browser access",
		),
		delegateAgentIds: parseStringArray(configuration.delegateAgentIds, "configuration delegate agent ids").map((id) =>
			validatedIdentifier(id, "delegate agent id"),
		),
		exposeA2a: requiredBoolean(configuration.exposeA2a, "configuration exposeA2a"),
	};
}

function parseAutomationIntent(value: unknown): AgentBuildAutomationIntent | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid agent build automation intent");
	}
	const intent = value as Record<string, unknown>;
	return {
		task: requiredString(intent.task, "automation task"),
		cadence: requiredString(intent.cadence, "automation cadence"),
		timezone:
			intent.timezone === undefined
				? Intl.DateTimeFormat().resolvedOptions().timeZone
				: requiredString(intent.timezone, "automation timezone"),
		mode: oneOf(intent.mode, ["replace", "additional"], "automation mode"),
		confirmed: requiredBoolean(intent.confirmed, "automation confirmation"),
	};
}

function starterCriteria(): AgentBuildCriterion[] {
	return [
		starterCriterion("goal-accomplishment", "Goal accomplished", "goal-obligation", "required-improvement"),
		starterCriterion("required-output-contract", "Required output contract", "output-contract", "non-regression"),
		starterCriterion(
			"grounding-integrity",
			"Grounding and evidence integrity",
			"grounding-integrity",
			"non-regression",
		),
		starterCriterion("refusal-honesty", "Uncertainty and refusal honesty", "refusal-honesty", "non-regression"),
		starterCriterion("safety-authority", "Safety and authority boundaries", "safety-authority", "non-regression"),
	];
}

function starterCriterion(
	id: string,
	label: string,
	category: AgentBuildCriterionCategory,
	expectation: AgentBuildCriterionExpectation,
): AgentBuildCriterion {
	return { id, label, description: label, category, expectation, evaluator: { type: "human" } };
}

function parseCriteria(value: unknown): AgentBuildCriterion[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("improvement criteria must be an array");
	const criteria = value.map((entry, index) => parseCriterion(entry, index));
	if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
		throw new Error("improvement criterion ids must be unique");
	}
	return criteria;
}

function parseCriterion(value: unknown, index: number): AgentBuildCriterion {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`improvement criteria[${index}] must be an object`);
	}
	const criterion = value as Record<string, unknown>;
	const id = requiredString(criterion.id, `improvement criteria[${index}].id`);
	assertIdentifier(id, `improvement criteria[${index}].id`);
	return {
		id,
		label: requiredString(criterion.label, `improvement criteria[${index}].label`),
		description: requiredString(criterion.description, `improvement criteria[${index}].description`),
		category: oneOf(
			criterion.category,
			[
				"goal-obligation",
				"workflow-fit",
				"preference-tradeoff",
				"success-preservation",
				"output-contract",
				"grounding-integrity",
				"refusal-honesty",
				"safety-authority",
				"reliability",
			],
			`improvement criteria[${index}].category`,
		),
		expectation: oneOf(
			criterion.expectation,
			["required-improvement", "non-regression", "advisory"],
			`improvement criteria[${index}].expectation`,
		),
		evaluator: parseCriterionEvaluator(criterion.evaluator, index),
	};
}

function parseCriterionEvaluator(value: unknown, index: number): AgentBuildCriterionEvaluator {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`improvement criteria[${index}].evaluator must be an object`);
	}
	const evaluator = value as Record<string, unknown>;
	const type = requiredString(evaluator.type, `improvement criteria[${index}].evaluator.type`);
	if (type === "human") return { type };
	if (type === "tool-receipt") {
		return {
			type,
			toolNames: nonEmptyStringArray(evaluator.toolNames, "tool receipt names"),
			minimumSuccesses: nonNegativeInteger(evaluator.minimumSuccesses, "minimum tool successes"),
			requireNonEmpty: requiredBoolean(evaluator.requireNonEmpty, "require non-empty tool results"),
		};
	}
	if (type === "tool-errors") {
		return {
			type,
			toolNames: nonEmptyStringArray(evaluator.toolNames, "tool error names"),
			maximumErrors: nonNegativeInteger(evaluator.maximumErrors, "maximum tool errors"),
		};
	}
	if (type === "workspace-mutation") {
		return {
			type,
			toolNames: nonEmptyStringArray(evaluator.toolNames, "workspace mutation tool names"),
			minimumSuccesses: nonNegativeInteger(evaluator.minimumSuccesses, "minimum workspace mutations"),
		};
	}
	if (type === "result-text") {
		return {
			type,
			mode: oneOf(evaluator.mode, ["contains", "omits"], "result text mode"),
			text: requiredString(evaluator.text, "result text"),
		};
	}
	if (type === "artifact-text") {
		return {
			type,
			path: safeRelativePath(evaluator.path, "artifact text path"),
			mode: oneOf(evaluator.mode, ["contains", "omits"], "artifact text mode"),
			text: requiredString(evaluator.text, "artifact text"),
		};
	}
	if (type === "artifact-change") {
		return { type, path: safeRelativePath(evaluator.path, "artifact change path") };
	}
	throw new Error(`Unsupported improvement criterion evaluator: ${type}`);
}

function parseFeedback(value: unknown): AgentBuildFeedback[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("build feedback must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`build feedback[${index}] must be an object`);
		}
		const feedback = entry as Record<string, unknown>;
		return {
			id: requiredString(feedback.id, "feedback id"),
			proofRunId: requiredString(feedback.proofRunId, "feedback proof run id"),
			rating: parseRating(feedback.rating),
			summary: requiredString(feedback.summary, "feedback summary"),
			answers: parseFeedbackAnswers(feedback.answers),
			createdAt: finiteNumber(feedback.createdAt, "feedback createdAt"),
		};
	});
}

function parseFeedbackAnswers(value: unknown): AgentBuildFeedback["answers"] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 3) throw new Error("feedback answers must contain at most 3 answers");
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`feedback answers[${index}] must be an object`);
		}
		const answer = entry as Record<string, unknown>;
		return {
			aspect: oneOf(
				answer.aspect,
				["goal-obligation", "workflow-fit", "preference-tradeoff", "success-preservation"],
				`feedback answers[${index}].aspect`,
			),
			question: requiredString(answer.question, `feedback answers[${index}].question`),
			answer: requiredString(answer.answer, `feedback answers[${index}].answer`),
		};
	});
}

function parseEvaluation(value: unknown): AgentBuildEvaluation | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid proof evaluation");
	const evaluation = value as Record<string, unknown>;
	if (!Array.isArray(evaluation.checks)) throw new Error("Proof evaluation checks must be an array");
	return {
		runId: requiredString(evaluation.runId, "evaluation run id"),
		evaluatedAt: finiteNumber(evaluation.evaluatedAt, "evaluation timestamp"),
		checks: evaluation.checks.map((entry, index) => {
			if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
				throw new Error(`evaluation checks[${index}] must be an object`);
			}
			const check = entry as Record<string, unknown>;
			return {
				criterionId: requiredString(check.criterionId, "evaluation criterion id"),
				status: oneOf(check.status, ["pass", "fail", "unverified"], "evaluation status"),
				summary: requiredString(check.summary, "evaluation summary"),
				evidence: parseStringArray(check.evidence, "evaluation evidence"),
			};
		}),
	};
}

function parseProofHistory(value: unknown): AgentBuildProofAttempt[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("Proof history must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
			throw new Error(`proof history[${index}] must be an object`);
		}
		const attempt = entry as Record<string, unknown>;
		const proof = parseProof(attempt.proof);
		if (!proof) throw new Error(`proof history[${index}] is missing proof evidence`);
		return { proof, evaluation: parseEvaluation(attempt.evaluation) };
	});
}

function mergeCriteria(current: AgentBuildCriterion[], additions: AgentBuildCriterion[]): AgentBuildCriterion[] {
	const merged = new Map(current.map((criterion) => [criterion.id, criterion]));
	for (const criterion of additions) merged.set(criterion.id, criterion);
	return [...merged.values()];
}

async function captureArtifactBaselines(
	record: AgentBuildRecord,
): Promise<Record<string, AgentBuildArtifactSnapshot | null> | undefined> {
	const paths = record.criteria.flatMap((criterion) =>
		criterion.evaluator.type === "artifact-change" ? [criterion.evaluator.path] : [],
	);
	if (paths.length === 0) return undefined;
	const baselines: Record<string, AgentBuildArtifactSnapshot | null> = {};
	for (const path of new Set(paths)) baselines[path] = await artifactSnapshot(record.projectRoot, path);
	return baselines;
}

async function evaluateProof(record: AgentBuildRecord, runs: AgentRunManager): Promise<AgentBuildEvaluation> {
	if (!record.proof) throw new Error("A proof is required for evaluation");
	const transcript = (await runs.readTranscript(record.proof.runId)) ?? [];
	const receipts = toolReceipts(transcript);
	const result = (await runs.readResult(record.proof.runId)) ?? "";
	const checks: AgentBuildCriterionResult[] = [];
	for (const criterion of record.criteria) {
		checks.push(await evaluateCriterion(record, criterion, receipts, result));
	}
	return { runId: record.proof.runId, evaluatedAt: Date.now(), checks };
}

interface ToolReceipt {
	toolName: string;
	isError: boolean;
	text: string;
}

function toolReceipts(transcript: readonly unknown[]): ToolReceipt[] {
	const receipts: ToolReceipt[] = [];
	for (const message of transcript) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const value = message as Record<string, unknown>;
		if (value.role !== "toolResult" || typeof value.toolName !== "string") continue;
		receipts.push({
			toolName: value.toolName,
			isError: value.isError === true,
			text: contentText(value.content),
		});
	}
	return receipts;
}

async function evaluateCriterion(
	record: AgentBuildRecord,
	criterion: AgentBuildCriterion,
	receipts: ToolReceipt[],
	result: string,
): Promise<AgentBuildCriterionResult> {
	const evaluator = criterion.evaluator;
	if (evaluator.type === "human") return criterionResult(criterion, "unverified", "Awaiting human review");
	if (evaluator.type === "tool-receipt") {
		const matches = receipts.filter(
			(receipt) =>
				evaluator.toolNames.includes(receipt.toolName) &&
				!receipt.isError &&
				(!evaluator.requireNonEmpty || hasNonEmptyEvidence(receipt.text)),
		);
		return criterionResult(
			criterion,
			matches.length >= evaluator.minimumSuccesses ? "pass" : "fail",
			`${matches.length}/${evaluator.minimumSuccesses} required successful non-empty tool receipts`,
			matches.map((receipt) => receipt.toolName),
		);
	}
	if (evaluator.type === "tool-errors") {
		const errors = receipts.filter((receipt) => evaluator.toolNames.includes(receipt.toolName) && receipt.isError);
		return criterionResult(
			criterion,
			errors.length <= evaluator.maximumErrors ? "pass" : "fail",
			`${errors.length}/${evaluator.maximumErrors} allowed tool errors`,
			errors.map((receipt) => receipt.toolName),
		);
	}
	if (evaluator.type === "workspace-mutation") {
		const mutations = receipts.filter(
			(receipt) => evaluator.toolNames.includes(receipt.toolName) && !receipt.isError,
		);
		return criterionResult(
			criterion,
			mutations.length >= evaluator.minimumSuccesses ? "pass" : "fail",
			`${mutations.length}/${evaluator.minimumSuccesses} required workspace mutations`,
			mutations.map((receipt) => receipt.toolName),
		);
	}
	if (evaluator.type === "result-text") {
		return textCriterionResult(criterion, "run result", result, evaluator.mode, evaluator.text);
	}
	if (evaluator.type === "artifact-text") {
		try {
			const content = await readFile(resolveArtifact(record.projectRoot, evaluator.path), "utf8");
			return textCriterionResult(criterion, evaluator.path, content, evaluator.mode, evaluator.text);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				return criterionResult(criterion, "unverified", `${evaluator.path} does not exist`);
			}
			throw error;
		}
	}
	const baseline = record.proof?.artifactBaselines?.[evaluator.path];
	const current = await artifactSnapshot(record.projectRoot, evaluator.path);
	const changed =
		current !== null &&
		(baseline === null ||
			baseline === undefined ||
			current.modifiedAt !== baseline.modifiedAt ||
			current.size !== baseline.size);
	return criterionResult(
		criterion,
		changed ? "pass" : "fail",
		changed ? `${evaluator.path} changed during this proof` : `${evaluator.path} was reused without modification`,
		[evaluator.path],
	);
}

function criterionResult(
	criterion: AgentBuildCriterion,
	status: AgentBuildCriterionResult["status"],
	summary: string,
	evidence: string[] = [],
): AgentBuildCriterionResult {
	return { criterionId: criterion.id, status, summary, evidence };
}

function textCriterionResult(
	criterion: AgentBuildCriterion,
	source: string,
	content: string,
	mode: "contains" | "omits",
	text: string,
): AgentBuildCriterionResult {
	const contains = content.toLocaleLowerCase().includes(text.toLocaleLowerCase());
	const pass = mode === "contains" ? contains : !contains;
	return criterionResult(
		criterion,
		pass ? "pass" : "fail",
		`${source} ${pass ? mode : mode === "contains" ? "does not contain" : "contains"} ${JSON.stringify(text)}`,
		[source],
	);
}

function hasBlockingEvaluationResult(record: AgentBuildRecord): boolean {
	if (!record.evaluation) return false;
	return record.evaluation.checks.some((check) => {
		const criterion = record.criteria.find((candidate) => candidate.id === check.criterionId);
		if (!criterion || criterion.expectation === "advisory" || criterion.evaluator.type === "human") return false;
		return check.status !== "pass";
	});
}

function contentText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
	if (typeof value !== "object" || value === null) return "";
	const content = value as Record<string, unknown>;
	if (typeof content.text === "string") return content.text;
	return contentText(content.content);
}

function hasNonEmptyEvidence(text: string): boolean {
	if (!text.trim()) return false;
	try {
		const value: unknown = JSON.parse(text);
		return structuredPayloadHasEvidence(value);
	} catch {
		return true;
	}
}

function structuredPayloadHasEvidence(value: unknown): boolean {
	if (value === null || value === undefined) return false;
	if (typeof value === "string") return value.trim().length > 0;
	if (typeof value === "number" || typeof value === "boolean") return true;
	if (Array.isArray(value)) return value.length > 0 && value.some(structuredPayloadHasEvidence);
	if (typeof value !== "object") return false;
	const object = value as Record<string, unknown>;
	const collectionKeys = ["entries", "results", "items", "news", "messages", "data"].filter((key) => key in object);
	if (collectionKeys.length > 0) return collectionKeys.some((key) => structuredPayloadHasEvidence(object[key]));
	return Object.values(object).some(structuredPayloadHasEvidence);
}

async function artifactSnapshot(projectRoot: string, path: string): Promise<AgentBuildArtifactSnapshot | null> {
	try {
		const metadata = await stat(resolveArtifact(projectRoot, path));
		return { modifiedAt: metadata.mtimeMs, size: metadata.size };
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function resolveArtifact(projectRoot: string, path: string): string {
	const root = resolve(projectRoot);
	const resolved = resolve(root, safeRelativePath(path, "artifact path"));
	const fromRoot = relative(root, resolved);
	if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return resolved;
	throw new Error("Artifact path escapes the agent project root");
}

function safeRelativePath(value: unknown, name: string): string {
	const path = requiredString(value, name);
	if (isAbsolute(path) || path.split(/[\\/]+/).includes(".."))
		throw new Error(`${name} must stay inside the project root`);
	return path;
}

function nonEmptyStringArray(value: unknown, name: string): string[] {
	const values = parseStringArray(value, name);
	if (values.length === 0) throw new Error(`${name} must not be empty`);
	return values;
}

function nonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative integer`);
	return Number(value);
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
	return value;
}

function parseRating(value: unknown): AgentBuildFeedback["rating"] {
	if (![1, 2, 3, 4, 5].includes(Number(value))) throw new Error("feedback rating must be 1-5");
	return Number(value) as AgentBuildFeedback["rating"];
}

function parseStringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return [...new Set(value.map((entry) => requiredString(entry, name)))];
}

function requiredBoolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	}
	return value as T;
}

function validatedIdentifier(value: string, name: string): string {
	assertIdentifier(value, name);
	return value;
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
		artifactBaselines: parseArtifactBaselines(proof.artifactBaselines),
	};
}

function parseArtifactBaselines(value: unknown): Record<string, AgentBuildArtifactSnapshot | null> | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid proof artifact baselines");
	}
	const baselines: Record<string, AgentBuildArtifactSnapshot | null> = {};
	for (const [path, snapshot] of Object.entries(value as Record<string, unknown>)) {
		safeRelativePath(path, "proof artifact baseline path");
		if (snapshot === null) {
			baselines[path] = null;
			continue;
		}
		if (typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Invalid proof artifact baseline");
		const record = snapshot as Record<string, unknown>;
		baselines[path] = {
			modifiedAt: finiteNumber(record.modifiedAt, "artifact baseline modifiedAt"),
			size: finiteNumber(record.size, "artifact baseline size"),
		};
	}
	return baselines;
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
