import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
	AgentBuildDraftInput,
	AgentBuildFeedbackInput,
	AgentBuildLifecycleService,
	AgentBuildRecord,
} from "./agent-build-lifecycle-service.ts";
import {
	type CapabilityApprovalActionBinding,
	createCapabilityApprovalActionBinding,
} from "./capability-approval-service.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

const STORE_VERSION = 1 as const;
const DEFAULT_PROPOSAL_TTL_MS = 5 * 60 * 1_000;
const MAX_SOURCE_MESSAGE_IDS = 100;

export type ConversationBuildMode = "create" | "edit" | "improve";
export type AgentBuildActionKind =
	| "publish"
	| "publish-and-schedule"
	| "run-proof"
	| "accept-proof"
	| "reject-proof"
	| "promote"
	| "schedule";
export type AgentBuildMaterialTopic =
	| "outcome"
	| "scope"
	| "recipient"
	| "authority"
	| "data-source"
	| "schedule"
	| "cost"
	| "acceptance"
	| "identity";

export interface AgentBuildAssumption {
	id: string;
	topic: string;
	value: string;
	rationale: string;
	sourceMessageId?: string;
	status: "active" | "replaced" | "confirmed";
}

export interface AgentBuildAssumptionInput {
	id?: string;
	topic: string;
	value: string;
	rationale: string;
}

export interface AgentBuildClarification {
	id: string;
	topic: string;
	materialTopic: AgentBuildMaterialTopic;
	question: string;
	reason: string;
	blockingActions: AgentBuildActionKind[];
	status: "open" | "answered" | "withdrawn";
	answer?: string;
	answerMessageId?: string;
}

export interface AgentBuildClarificationInput {
	id?: string;
	topic: string;
	materialTopic: AgentBuildMaterialTopic;
	question: string;
	reason: string;
	blockingActions: AgentBuildActionKind[];
}

export interface AgentBuildConversationLink {
	buildId: string;
	sessionId: string;
	mode: ConversationBuildMode;
	sourceMessageIds: string[];
	assumptions: AgentBuildAssumption[];
	clarifications: AgentBuildClarification[];
	activeProposalId?: string;
	lastPresentedBuildRevision: number;
	createdAt: number;
	updatedAt: number;
}

export interface AgentBuildActionProposal {
	id: string;
	buildId: string;
	buildRevision: number;
	sessionId: string;
	action: AgentBuildActionKind;
	binding: CapabilityApprovalActionBinding;
	state: "pending" | "authorized" | "completed" | "failed" | "expired";
	createdAt: number;
	expiresAt: number;
	completedAt?: number;
	result?: unknown;
	error?: string;
}

export interface ConversationBuildView {
	build: AgentBuildRecord;
	link?: AgentBuildConversationLink;
	proposals: AgentBuildActionProposal[];
	readiness: {
		ready: boolean;
		blockers: string[];
	};
}

export interface ApplyConversationBuildIntent {
	sessionId: string;
	mode: ConversationBuildMode;
	sourceMessageId?: string;
	buildId?: string;
	expectedBuildRevision?: number;
	draft: AgentBuildDraftInput;
	assumptions?: AgentBuildAssumptionInput[];
	clarifications?: AgentBuildClarificationInput[];
	answeredClarificationIds?: string[];
}

interface PersistedState {
	version: typeof STORE_VERSION;
	links: Record<string, AgentBuildConversationLink>;
	proposals: Record<string, AgentBuildActionProposal>;
}

/** Links conversational intent to the existing build lifecycle without becoming another lifecycle authority. */
export class ConversationBuildCoordinator {
	readonly #lifecycle: AgentBuildLifecycleService;
	readonly #path: string;
	readonly #queue = new SerialOperationQueue();
	#state: PersistedState = { version: STORE_VERSION, links: {}, proposals: {} };
	#initialized = false;

	constructor(root: string, lifecycle: AgentBuildLifecycleService) {
		this.#lifecycle = lifecycle;
		this.#path = resolve(root, "agent-build-conversations.json");
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await mkdir(dirname(this.#path), { recursive: true });
		try {
			this.#state = parseState(JSON.parse(await readFile(this.#path, "utf8")) as unknown);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			await this.#persist();
		}
		this.#initialized = true;
	}

	async applyIntent(input: ApplyConversationBuildIntent): Promise<ConversationBuildView> {
		return this.#queue.run(async () => {
			await this.initialize();
			const sessionId = requiredString(input.sessionId, "sessionId");
			const sourceMessageId = optionalString(input.sourceMessageId);
			const assumptions = normalizeAssumptionInputs(input.assumptions);
			const clarifications = normalizeClarificationInputs(input.clarifications);
			const answeredIds = stringArray(input.answeredClarificationIds, "answeredClarificationIds");
			let build: AgentBuildRecord;
			if (input.buildId) {
				if (!Number.isSafeInteger(input.expectedBuildRevision) || Number(input.expectedBuildRevision) < 1) {
					throw new Error("expectedBuildRevision is required when updating a conversational build");
				}
				build = await this.#lifecycle.updateDraft(input.buildId, input.draft, Number(input.expectedBuildRevision));
			} else {
				build = await this.#lifecycle.stageDraft(input.draft);
			}
			const link = this.#upsertLink(build, sessionId, input.mode, sourceMessageId);
			mergeAssumptions(link, assumptions, sourceMessageId);
			answerClarifications(link, answeredIds, undefined, sourceMessageId);
			mergeClarifications(link, clarifications);
			link.lastPresentedBuildRevision = build.revision;
			link.updatedAt = Date.now();
			this.#expireBuildProposals(build.id, "The draft changed after this action was prepared");
			await this.#persist();
			return this.#view(build, link);
		});
	}

	async attach(
		buildId: string,
		sessionId: string,
		mode: ConversationBuildMode,
		sourceMessageId?: string,
	): Promise<ConversationBuildView> {
		return this.#queue.run(async () => {
			await this.initialize();
			const build = await this.#lifecycle.get(buildId);
			const link = this.#upsertLink(
				build,
				requiredString(sessionId, "sessionId"),
				mode,
				optionalString(sourceMessageId),
			);
			await this.#persist();
			return this.#view(build, link);
		});
	}

	async answerClarification(
		buildId: string,
		clarificationId: string,
		answer: string,
		answerMessageId?: string,
	): Promise<ConversationBuildView> {
		return this.#queue.run(async () => {
			await this.initialize();
			const link = this.#requiredLink(buildId);
			answerClarifications(
				link,
				[requiredString(clarificationId, "clarificationId")],
				requiredString(answer, "answer"),
				optionalString(answerMessageId),
			);
			link.updatedAt = Date.now();
			await this.#persist();
			return this.#view(await this.#lifecycle.get(buildId), link);
		});
	}

	async recordFeedback(buildId: string, input: AgentBuildFeedbackInput): Promise<ConversationBuildView> {
		return this.#queue.run(async () => {
			await this.initialize();
			const build = await this.#lifecycle.recordFeedback(buildId, input);
			const link = this.#state.links[buildId];
			if (link) {
				link.lastPresentedBuildRevision = build.revision;
				link.updatedAt = Date.now();
			}
			this.#expireBuildProposals(build.id, "Feedback changed the reviewed build state");
			await this.#persist();
			return this.#view(build, link);
		});
	}

	async inspect(buildId: string): Promise<ConversationBuildView> {
		return this.#queue.run(async () => {
			await this.initialize();
			const changed = this.#expireProposals();
			if (changed) await this.#persist();
			return this.#view(await this.#lifecycle.get(buildId), this.#state.links[buildId]);
		});
	}

	async list(sessionId?: string): Promise<ConversationBuildView[]> {
		return this.#queue.run(async () => {
			await this.initialize();
			const changed = this.#expireProposals();
			if (changed) await this.#persist();
			const links = Object.values(this.#state.links).filter((link) => !sessionId || link.sessionId === sessionId);
			const views = await Promise.all(
				links.map(async (link) => this.#view(await this.#lifecycle.get(link.buildId), link)),
			);
			return views.sort((left, right) => (right.link?.updatedAt ?? 0) - (left.link?.updatedAt ?? 0));
		});
	}

	async prepareAction(input: {
		buildId: string;
		sessionId: string;
		action: AgentBuildActionKind;
		payload: unknown;
		preview: string;
		expiresInSeconds?: number;
	}): Promise<AgentBuildActionProposal> {
		return this.#queue.run(async () => {
			await this.initialize();
			const build = await this.#lifecycle.get(input.buildId);
			const link = this.#requiredLink(build.id);
			const sessionId = requiredString(input.sessionId, "sessionId");
			if (link.sessionId !== sessionId) throw new Error("This build is linked to a different Pi session");
			const action = actionKind(input.action);
			const blockers = link.clarifications.filter(
				(item) =>
					item.status === "open" &&
					(item.blockingActions.includes(action) ||
						(action === "publish-and-schedule" &&
							(item.blockingActions.includes("publish") || item.blockingActions.includes("schedule")))),
			);
			if (blockers.length > 0) {
				throw new Error(`Answer before ${action}: ${blockers.map((item) => item.question).join(" ")}`);
			}
			assertActionReady(build, action);
			this.#expireBuildProposals(build.id, "A newer action proposal replaced this one");
			const now = Date.now();
			const ttlSeconds = input.expiresInSeconds ?? DEFAULT_PROPOSAL_TTL_MS / 1_000;
			if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3_600) {
				throw new Error("Action proposal expiry must be between 30 and 3600 seconds");
			}
			const proposal: AgentBuildActionProposal = {
				id: `proposal-${randomUUID()}`,
				buildId: build.id,
				buildRevision: build.revision,
				sessionId,
				action,
				binding: createCapabilityApprovalActionBinding(input.payload, requiredString(input.preview, "preview")),
				state: "pending",
				createdAt: now,
				expiresAt: now + ttlSeconds * 1_000,
			};
			this.#state.proposals[proposal.id] = proposal;
			link.activeProposalId = proposal.id;
			link.updatedAt = now;
			await this.#persist();
			return structuredClone(proposal);
		});
	}

	async authorizeAction(input: {
		proposalId: string;
		buildId: string;
		sessionId: string;
		action: AgentBuildActionKind;
		payload: unknown;
	}): Promise<AgentBuildActionProposal> {
		return this.#queue.run(async () => {
			await this.initialize();
			const proposal = this.#requiredProposal(input.proposalId);
			if (proposal.state !== "pending") throw new Error(`Action proposal ${proposal.id} is ${proposal.state}`);
			if (proposal.expiresAt <= Date.now()) {
				proposal.state = "expired";
				proposal.error = "The action proposal expired";
				await this.#persist();
				throw new Error("This action proposal expired; review a fresh proposal");
			}
			if (proposal.buildId !== input.buildId || proposal.sessionId !== input.sessionId) {
				throw new Error("The action proposal does not belong to this build and session");
			}
			if (proposal.action !== actionKind(input.action))
				throw new Error("The action proposal does not match the action");
			const build = await this.#lifecycle.get(input.buildId);
			if (build.revision !== proposal.buildRevision) {
				proposal.state = "expired";
				proposal.error = "The build changed after action review";
				await this.#persist();
				throw new Error("The build changed after review; inspect and confirm a fresh action proposal");
			}
			const binding = createCapabilityApprovalActionBinding(input.payload, proposal.binding.preview);
			if (binding.digest !== proposal.binding.digest)
				throw new Error("The action proposal does not match the exact payload");
			proposal.state = "authorized";
			await this.#persist();
			return structuredClone(proposal);
		});
	}

	async completeAction(proposalId: string, result: unknown): Promise<AgentBuildActionProposal> {
		return this.#finishAction(proposalId, "completed", result);
	}

	async failAction(proposalId: string, error: string, result?: unknown): Promise<AgentBuildActionProposal> {
		return this.#finishAction(proposalId, "failed", result, requiredString(error, "error"));
	}

	#upsertLink(
		build: AgentBuildRecord,
		sessionId: string,
		mode: ConversationBuildMode,
		sourceMessageId: string | undefined,
	): AgentBuildConversationLink {
		const now = Date.now();
		const link = this.#state.links[build.id] ?? {
			buildId: build.id,
			sessionId,
			mode,
			sourceMessageIds: [],
			assumptions: [],
			clarifications: [],
			lastPresentedBuildRevision: build.revision,
			createdAt: now,
			updatedAt: now,
		};
		if (link.sessionId !== sessionId) {
			this.#expireBuildProposals(build.id, "The build moved to a different Pi session");
			link.sessionId = sessionId;
			link.sourceMessageIds = [];
		}
		link.mode = mode;
		link.lastPresentedBuildRevision = build.revision;
		link.updatedAt = now;
		if (sourceMessageId && !link.sourceMessageIds.includes(sourceMessageId)) {
			link.sourceMessageIds.push(sourceMessageId);
			if (link.sourceMessageIds.length > MAX_SOURCE_MESSAGE_IDS) link.sourceMessageIds.shift();
		}
		this.#state.links[build.id] = link;
		return link;
	}

	#view(build: AgentBuildRecord, link: AgentBuildConversationLink | undefined): ConversationBuildView {
		const blockers = readinessBlockers(build, link);
		return {
			build: structuredClone(build),
			link: link ? structuredClone(link) : undefined,
			proposals: Object.values(this.#state.proposals)
				.filter((proposal) => proposal.buildId === build.id)
				.sort((left, right) => right.createdAt - left.createdAt)
				.map((proposal) => structuredClone(proposal)),
			readiness: { ready: blockers.length === 0, blockers },
		};
	}

	#requiredLink(buildId: string): AgentBuildConversationLink {
		const link = this.#state.links[buildId];
		if (!link) throw new Error(`Agent build ${buildId} is not linked to a conversation`);
		return link;
	}

	#requiredProposal(proposalId: string): AgentBuildActionProposal {
		const proposal = this.#state.proposals[proposalId];
		if (!proposal) throw new Error(`Action proposal ${proposalId} was not found`);
		return proposal;
	}

	#expireBuildProposals(buildId: string, reason: string): void {
		for (const proposal of Object.values(this.#state.proposals)) {
			if (proposal.buildId !== buildId || proposal.state !== "pending") continue;
			proposal.state = "expired";
			proposal.error = reason;
		}
		const link = this.#state.links[buildId];
		if (link?.activeProposalId && this.#state.proposals[link.activeProposalId]?.state !== "pending") {
			link.activeProposalId = undefined;
		}
	}

	#expireProposals(): boolean {
		let changed = false;
		for (const proposal of Object.values(this.#state.proposals)) {
			if (proposal.state !== "pending" || proposal.expiresAt > Date.now()) continue;
			proposal.state = "expired";
			proposal.error = "The action proposal expired";
			const link = this.#state.links[proposal.buildId];
			if (link?.activeProposalId === proposal.id) link.activeProposalId = undefined;
			changed = true;
		}
		return changed;
	}

	async #finishAction(
		proposalId: string,
		state: "completed" | "failed",
		result?: unknown,
		error?: string,
	): Promise<AgentBuildActionProposal> {
		return this.#queue.run(async () => {
			await this.initialize();
			const proposal = this.#requiredProposal(proposalId);
			if (proposal.state === state) return structuredClone(proposal);
			if (proposal.state !== "authorized") throw new Error(`Action proposal ${proposal.id} is ${proposal.state}`);
			proposal.state = state;
			proposal.completedAt = Date.now();
			proposal.result = result === undefined ? undefined : structuredClone(result);
			proposal.error = error;
			const link = this.#state.links[proposal.buildId];
			if (link?.activeProposalId === proposal.id) link.activeProposalId = undefined;
			if (link) link.updatedAt = Date.now();
			await this.#persist();
			return structuredClone(proposal);
		});
	}

	async #persist(): Promise<void> {
		const temporary = `${this.#path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, this.#path);
	}
}

function mergeAssumptions(
	link: AgentBuildConversationLink,
	inputs: AgentBuildAssumptionInput[],
	sourceMessageId: string | undefined,
): void {
	for (const input of inputs) {
		const unchanged = link.assumptions.find(
			(existing) =>
				existing.topic === input.topic &&
				existing.status === "active" &&
				existing.value === input.value &&
				existing.rationale === input.rationale,
		);
		if (unchanged) {
			unchanged.sourceMessageId = sourceMessageId ?? unchanged.sourceMessageId;
			continue;
		}
		for (const existing of link.assumptions) {
			if (existing.topic === input.topic && existing.status === "active") existing.status = "replaced";
		}
		link.assumptions.push({
			id: input.id ?? `assumption-${randomUUID()}`,
			topic: input.topic,
			value: input.value,
			rationale: input.rationale,
			sourceMessageId,
			status: "active",
		});
	}
	if (link.assumptions.length > 100) link.assumptions.splice(0, link.assumptions.length - 100);
}

function mergeClarifications(link: AgentBuildConversationLink, inputs: AgentBuildClarificationInput[]): void {
	for (const input of inputs) {
		const existing = link.clarifications.find((item) => item.id === input.id || item.topic === input.topic);
		if (existing) {
			const unchangedAnswered =
				existing.status === "answered" &&
				existing.question === input.question &&
				existing.reason === input.reason &&
				existing.materialTopic === input.materialTopic &&
				existing.blockingActions.join("\0") === input.blockingActions.join("\0");
			if (unchangedAnswered) continue;
			if (existing.status !== "open") {
				link.clarifications.push({
					id: input.id ?? `clarification-${randomUUID()}`,
					topic: input.topic,
					materialTopic: input.materialTopic,
					question: input.question,
					reason: input.reason,
					blockingActions: [...input.blockingActions],
					status: "open",
				});
				continue;
			}
			existing.materialTopic = input.materialTopic;
			existing.question = input.question;
			existing.reason = input.reason;
			existing.blockingActions = [...input.blockingActions];
			continue;
		}
		link.clarifications.push({
			id: input.id ?? `clarification-${randomUUID()}`,
			topic: input.topic,
			materialTopic: input.materialTopic,
			question: input.question,
			reason: input.reason,
			blockingActions: [...input.blockingActions],
			status: "open",
		});
	}
	if (link.clarifications.filter((item) => item.status === "open").length > 3) {
		throw new Error("Ask at most three material clarification questions at a time");
	}
}

function answerClarifications(
	link: AgentBuildConversationLink,
	ids: string[],
	answer: string | undefined,
	answerMessageId: string | undefined,
): void {
	for (const id of ids) {
		const clarification = link.clarifications.find((item) => item.id === id);
		if (!clarification) throw new Error(`Clarification ${id} was not found`);
		if (clarification.status !== "open") continue;
		clarification.status = "answered";
		clarification.answer = answer;
		clarification.answerMessageId = answerMessageId;
	}
}

function readinessBlockers(build: AgentBuildRecord, link: AgentBuildConversationLink | undefined): string[] {
	const blockers =
		link?.clarifications
			.filter((item) => item.status === "open" && item.blockingActions.includes("publish"))
			.map((item) => item.question) ?? [];
	if (!build.configuration) blockers.push("Complete the agent package");
	if (!build.agentId && build.stage !== "proven") blockers.push("Run and accept one current candidate proof");
	if (build.stage === "needs-refinement") blockers.push("Resolve the failed proof and test the revised candidate");
	if (build.stage === "testing") blockers.push("Wait for the active candidate test");
	return [...new Set(blockers)];
}

function assertActionReady(build: AgentBuildRecord, action: AgentBuildActionKind): void {
	if (action === "publish" || action === "publish-and-schedule") {
		if (build.agentId) throw new Error("This agent is already published; promote an accepted candidate instead");
		if (build.stage !== "proven") throw new Error("Test and accept this unpublished candidate before publishing it");
		if (action === "publish-and-schedule" && !build.automationIntent?.confirmed) {
			throw new Error("Confirm the exact schedule intent before preparing publication and automation");
		}
		return;
	}
	if (action === "run-proof") {
		if (!build.configuration) throw new Error("Complete the agent package before testing it");
		if (build.stage === "testing") throw new Error("This build already has an active candidate test");
		return;
	}
	if (action === "accept-proof" || action === "reject-proof") {
		if (build.stage !== "proof-ready") throw new Error("A successful current proof must be reviewed first");
		return;
	}
	if (action === "promote") {
		if (!build.agentId) throw new Error("Publish the accepted new agent before promoting its workflow");
		if (build.stage !== "proven") throw new Error("Accept the current proof before promotion");
		return;
	}
	if (!build.agentId || !build.skill || !["promoted", "automated"].includes(build.stage)) {
		throw new Error("Publish, prove, accept, and promote this agent before scheduling it");
	}
}

function normalizeAssumptionInputs(value: AgentBuildAssumptionInput[] | undefined): AgentBuildAssumptionInput[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 32) throw new Error("assumptions must contain at most 32 entries");
	return value.map((item) => ({
		id: optionalString(item.id),
		topic: requiredString(item.topic, "assumption topic"),
		value: requiredString(item.value, "assumption value"),
		rationale: requiredString(item.rationale, "assumption rationale"),
	}));
}

function normalizeClarificationInputs(
	value: AgentBuildClarificationInput[] | undefined,
): AgentBuildClarificationInput[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 3) throw new Error("clarifications must contain at most 3 entries");
	return value.map((item) => ({
		id: optionalString(item.id),
		topic: requiredString(item.topic, "clarification topic"),
		materialTopic: materialTopic(item.materialTopic),
		question: requiredString(item.question, "clarification question"),
		reason: requiredString(item.reason, "clarification reason"),
		blockingActions: [...new Set(item.blockingActions.map(actionKind))],
	}));
}

function parseState(value: unknown): PersistedState {
	const input = record(value, "conversation build state");
	if (input.version !== STORE_VERSION) throw new Error("Conversation build state version is unsupported");
	const linksInput = record(input.links, "conversation build links");
	const proposalsInput = record(input.proposals, "conversation build proposals");
	const links: Record<string, AgentBuildConversationLink> = {};
	const proposals: Record<string, AgentBuildActionProposal> = {};
	for (const [id, entry] of Object.entries(linksInput)) links[id] = parseLink(entry);
	for (const [id, entry] of Object.entries(proposalsInput)) proposals[id] = parseProposal(entry);
	return { version: STORE_VERSION, links, proposals };
}

function parseLink(value: unknown): AgentBuildConversationLink {
	const input = record(value, "conversation build link");
	return {
		buildId: requiredString(input.buildId, "buildId"),
		sessionId: requiredString(input.sessionId, "sessionId"),
		mode: conversationMode(input.mode),
		sourceMessageIds: stringArray(input.sourceMessageIds, "sourceMessageIds"),
		assumptions: array(input.assumptions, "assumptions").map((item) => parseAssumption(item)),
		clarifications: array(input.clarifications, "clarifications").map((item) => parseClarification(item)),
		activeProposalId: optionalString(input.activeProposalId),
		lastPresentedBuildRevision: positiveInteger(input.lastPresentedBuildRevision, "lastPresentedBuildRevision"),
		createdAt: finiteNumber(input.createdAt, "createdAt"),
		updatedAt: finiteNumber(input.updatedAt, "updatedAt"),
	};
}

function parseAssumption(value: unknown): AgentBuildAssumption {
	const input = record(value, "assumption");
	const status = oneOf(input.status, ["active", "replaced", "confirmed"] as const, "assumption status");
	return {
		id: requiredString(input.id, "assumption id"),
		topic: requiredString(input.topic, "assumption topic"),
		value: requiredString(input.value, "assumption value"),
		rationale: requiredString(input.rationale, "assumption rationale"),
		sourceMessageId: optionalString(input.sourceMessageId),
		status,
	};
}

function parseClarification(value: unknown): AgentBuildClarification {
	const input = record(value, "clarification");
	return {
		id: requiredString(input.id, "clarification id"),
		topic: requiredString(input.topic, "clarification topic"),
		materialTopic: materialTopic(input.materialTopic),
		question: requiredString(input.question, "clarification question"),
		reason: requiredString(input.reason, "clarification reason"),
		blockingActions: stringArray(input.blockingActions, "blockingActions").map(actionKind),
		status: oneOf(input.status, ["open", "answered", "withdrawn"] as const, "clarification status"),
		answer: optionalString(input.answer),
		answerMessageId: optionalString(input.answerMessageId),
	};
}

function parseProposal(value: unknown): AgentBuildActionProposal {
	const input = record(value, "action proposal");
	const binding = record(input.binding, "action binding");
	return {
		id: requiredString(input.id, "proposal id"),
		buildId: requiredString(input.buildId, "buildId"),
		buildRevision: positiveInteger(input.buildRevision, "buildRevision"),
		sessionId: requiredString(input.sessionId, "sessionId"),
		action: actionKind(input.action),
		binding: {
			version: oneOf(binding.version, [1] as const, "action binding version"),
			digest: requiredString(binding.digest, "action binding digest"),
			preview: requiredString(binding.preview, "action binding preview"),
		},
		state: oneOf(input.state, ["pending", "authorized", "completed", "failed", "expired"] as const, "proposal state"),
		createdAt: finiteNumber(input.createdAt, "createdAt"),
		expiresAt: finiteNumber(input.expiresAt, "expiresAt"),
		completedAt: input.completedAt === undefined ? undefined : finiteNumber(input.completedAt, "completedAt"),
		result: input.result,
		error: optionalString(input.error),
	};
}

function conversationMode(value: unknown): ConversationBuildMode {
	return oneOf(value, ["create", "edit", "improve"] as const, "conversation build mode");
}

function materialTopic(value: unknown): AgentBuildMaterialTopic {
	return oneOf(
		value,
		[
			"outcome",
			"scope",
			"recipient",
			"authority",
			"data-source",
			"schedule",
			"cost",
			"acceptance",
			"identity",
		] as const,
		"material clarification topic",
	);
}

function actionKind(value: unknown): AgentBuildActionKind {
	return oneOf(
		value,
		["publish", "publish-and-schedule", "run-proof", "accept-proof", "reject-proof", "promote", "schedule"] as const,
		"agent build action",
	);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value;
}

function stringArray(value: unknown, name: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value.map((item) => requiredString(item, name));
}

function positiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
	return Number(value);
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
	return value;
}

function oneOf<const T extends string | number>(value: unknown, choices: readonly T[], name: string): T {
	if (!choices.includes(value as T)) throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	return value as T;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
