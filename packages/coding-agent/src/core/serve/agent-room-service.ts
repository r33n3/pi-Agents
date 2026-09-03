import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentContextAuthor } from "./agent-context-package.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentTaskService } from "./agent-task-service.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";
import type { WorkflowDefinitionInput, WorkflowNodeRun, WorkflowRun, WorkflowService } from "./workflow-service.ts";

export interface AgentRoomLimits {
	maxRounds: number;
	maxMessages: number;
	maxConcurrency: number;
	maxDurationMs: number;
	maxTotalTokens: number;
	maxCostUsd: number;
}

export interface AgentRoomMember {
	agentId: string;
	role: string;
}

export interface AgentRoomDefinition {
	version: 1;
	id: string;
	name: string;
	purpose: string;
	members: AgentRoomMember[];
	limits: AgentRoomLimits;
	conversationId: string;
	createdAt: number;
	updatedAt: number;
}

export interface AgentRoomDefinitionInput {
	id?: string;
	name: string;
	purpose: string;
	members: AgentRoomMember[];
	limits?: Partial<AgentRoomLimits>;
}

export type AgentRoomTurnOutcome = "reply" | "pass" | "needs-user" | "failed" | "cancelled";

export interface AgentRoomTurn {
	memberIndex: number;
	agentId: string;
	taskId?: string;
	status: AgentRoomTurnOutcome;
	message: string;
	/** Explicit requests for another full-room round; absent on older retained evidence. */
	requestAgentIds?: string[];
	totalTokens: number;
	costUsd: number;
}

export interface AgentRoomRound {
	id: string;
	number: number;
	workflowRunId: string;
	status: "completed" | "needs-user" | "failed" | "cancelled";
	startedAt: number;
	finishedAt: number;
	turns: AgentRoomTurn[];
}

export type AgentRoomRunStatus = "running" | "completed" | "needs-user" | "bounded" | "failed" | "cancelled";

export interface AgentRoomRun {
	version: 1;
	id: string;
	roomId: string;
	status: AgentRoomRunStatus;
	goal: string;
	createdAt: number;
	deadlineAt: number;
	finishedAt?: number;
	rounds: AgentRoomRound[];
	workflowRunIds: string[];
	taskIds: string[];
	messageCount: number;
	totalTokens: number;
	costUsd: number;
	currentWorkflowRunId?: string;
	userQuestion?: string;
	result?: string;
	error?: string;
}

const DEFAULT_LIMITS: AgentRoomLimits = {
	maxRounds: 3,
	maxMessages: 48,
	maxConcurrency: 3,
	maxDurationMs: 10 * 60_000,
	maxTotalTokens: 200_000,
	maxCostUsd: 20,
};

/** Owns bounded local room definitions and immutable, task-backed round evidence. */
export class AgentRoomService implements AsyncDisposable {
	readonly #definitionsDir: string;
	readonly #runsDir: string;
	readonly #registry: AgentRegistry;
	readonly #tasks: AgentTaskService;
	readonly #workflows: WorkflowService;
	readonly #queue = new SerialOperationQueue();
	readonly #definitions = new Map<string, AgentRoomDefinition>();
	readonly #runs = new Map<string, AgentRoomRun>();
	readonly #completions = new Map<string, Promise<void>>();
	#disposed = false;

	constructor(root: string, registry: AgentRegistry, tasks: AgentTaskService, workflows: WorkflowService) {
		this.#definitionsDir = resolve(root, "definitions");
		this.#runsDir = resolve(root, "runs");
		this.#registry = registry;
		this.#tasks = tasks;
		this.#workflows = workflows;
	}

	async initialize(): Promise<void> {
		await Promise.all([mkdir(this.#definitionsDir, { recursive: true }), mkdir(this.#runsDir, { recursive: true })]);
		for (const file of (await readdir(this.#definitionsDir)).filter((entry) => entry.endsWith(".json"))) {
			try {
				const definition = parseDefinition(JSON.parse(await readFile(resolve(this.#definitionsDir, file), "utf8")));
				await this.#validateMembers(definition.members);
				this.#definitions.set(definition.id, definition);
			} catch {
				// Invalid room definitions remain unavailable until corrected.
			}
		}
		for (const entry of await readdir(this.#runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const run = parseRun(JSON.parse(await readFile(resolve(this.#runsDir, entry.name, "run.json"), "utf8")));
				if (run.status === "running") {
					await this.#recoverInterruptedRound(run);
					run.status = "failed";
					run.finishedAt = Date.now();
					run.error = "Serve host stopped before the room round completed";
					run.currentWorkflowRunId = undefined;
					await this.#persistRun(run);
				}
				this.#runs.set(run.id, run);
			} catch {
				// Malformed room runs are not exposed.
			}
		}
	}

	listDefinitions(): AgentRoomDefinition[] {
		return [...this.#definitions.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(cloneDefinition);
	}

	getDefinition(id: string): AgentRoomDefinition | undefined {
		const definition = this.#definitions.get(id);
		return definition ? cloneDefinition(definition) : undefined;
	}

	listRuns(roomId?: string): AgentRoomRun[] {
		return [...this.#runs.values()]
			.filter((run) => roomId === undefined || run.roomId === roomId)
			.sort((left, right) => right.createdAt - left.createdAt)
			.map(cloneRun);
	}

	getRun(id: string): AgentRoomRun | undefined {
		const run = this.#runs.get(id);
		return run ? cloneRun(run) : undefined;
	}

	async save(input: AgentRoomDefinitionInput): Promise<AgentRoomDefinition> {
		return this.#queue.run(async () => {
			const normalized = normalizeDefinitionInput(input);
			await this.#validateMembers(normalized.members);
			const existing = this.#definitions.get(normalized.id);
			if (existing && this.listRuns(existing.id).some((run) => run.status === "running")) {
				throw new Error("A room with an active run cannot be edited");
			}
			const conversation = await this.#tasks.ensureRoomConversation(normalized.id);
			const now = Date.now();
			const definition: AgentRoomDefinition = {
				version: 1,
				...normalized,
				conversationId: conversation.id,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			await writeAtomic(
				resolve(this.#definitionsDir, `${definition.id}.json`),
				`${JSON.stringify(definition, null, 2)}\n`,
			);
			this.#definitions.set(definition.id, definition);
			return cloneDefinition(definition);
		});
	}

	async delete(id: string): Promise<boolean> {
		return this.#queue.run(async () => {
			const normalizedId = requiredIdentifier(id, "room.id");
			if (this.listRuns(normalizedId).some((run) => run.status === "running")) {
				throw new Error("A room with an active run cannot be deleted");
			}
			try {
				await unlink(resolve(this.#definitionsDir, `${normalizedId}.json`));
				this.#definitions.delete(normalizedId);
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return false;
				throw error;
			}
		});
	}

	async start(roomId: string, goal: string): Promise<AgentRoomRun> {
		if (this.#disposed) throw new Error("Agent room service is disposed");
		const definition = this.#definitions.get(roomId);
		if (!definition) throw new Error(`Room ${roomId} was not found`);
		const normalizedGoal = boundedText(goal, "room goal", 16 * 1024);
		if (this.listRuns(roomId).some((run) => run.status === "running" || run.status === "needs-user")) {
			throw new Error("The room already has an active run");
		}
		const now = Date.now();
		const run: AgentRoomRun = {
			version: 1,
			id: randomUUID(),
			roomId,
			status: "running",
			goal: normalizedGoal,
			createdAt: now,
			deadlineAt: now + definition.limits.maxDurationMs,
			rounds: [],
			workflowRunIds: [],
			taskIds: [],
			messageCount: 1,
			totalTokens: 0,
			costUsd: 0,
		};
		this.#runs.set(run.id, run);
		await this.#tasks.appendRoomMessage({
			roomId,
			id: `room:${run.id}:goal`,
			author: { kind: "user", id: "local-user" },
			text: normalizedGoal,
		});
		await this.#persistRun(run);
		this.#launch(definition, run);
		return cloneRun(run);
	}

	async resume(runId: string, message: string): Promise<AgentRoomRun> {
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Room run ${runId} was not found`);
		if (run.status !== "needs-user") throw new Error(`Room run ${runId} is not waiting for user input`);
		const definition = this.#definitions.get(run.roomId);
		if (!definition) throw new Error(`Room ${run.roomId} was not found`);
		const normalizedMessage = boundedText(message, "room user message", 16 * 1024);
		if (run.messageCount + 1 > definition.limits.maxMessages) throw new Error("Room message limit is reached");
		await this.#tasks.appendRoomMessage({
			roomId: run.roomId,
			id: `room:${run.id}:user:${run.messageCount + 1}`,
			author: { kind: "user", id: "local-user" },
			text: normalizedMessage,
		});
		run.goal = `${run.goal}\n\nUser clarification:\n${normalizedMessage}`;
		run.messageCount += 1;
		run.status = "running";
		run.userQuestion = undefined;
		run.error = undefined;
		await this.#persistRun(run);
		this.#launch(definition, run);
		return cloneRun(run);
	}

	async waitForCompletion(runId: string): Promise<AgentRoomRun> {
		await this.#completions.get(runId);
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Room run ${runId} was not found`);
		return cloneRun(run);
	}

	async cancel(runId: string): Promise<AgentRoomRun> {
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Room run ${runId} was not found`);
		if (run.status !== "running" && run.status !== "needs-user") return cloneRun(run);
		const workflowRunId = run.currentWorkflowRunId;
		run.status = "cancelled";
		run.finishedAt = Date.now();
		run.error = "Room run was cancelled";
		run.currentWorkflowRunId = undefined;
		await this.#persistRun(run);
		if (workflowRunId) {
			await this.#workflows.cancel(workflowRunId);
			const workflow = this.#workflows.getRun(workflowRunId);
			if (workflow) {
				appendUnique(run.taskIds, workflow.taskIds);
				const definition = this.#definitions.get(run.roomId);
				if (
					definition &&
					workflow.nodeResults.length > 0 &&
					!run.rounds.some((round) => round.workflowRunId === workflow.id)
				) {
					const round = await this.#completeRound(definition, run, workflow, run.rounds.length + 1);
					round.status = "cancelled";
					run.rounds.push(round);
				}
				await this.#persistRun(run);
			}
		}
		return cloneRun(run);
	}

	dispose(): Promise<void> {
		this.#disposed = true;
		return this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#launch(definition: AgentRoomDefinition, run: AgentRoomRun): void {
		const completion = this.#execute(definition, run);
		this.#completions.set(run.id, completion);
		void completion.finally(() => {
			if (this.#completions.get(run.id) === completion) this.#completions.delete(run.id);
		});
	}

	async #execute(definition: AgentRoomDefinition, run: AgentRoomRun): Promise<void> {
		try {
			while (run.status === "running") {
				if (Date.now() >= run.deadlineAt) return await this.#finishBounded(run, "Room duration limit is reached");
				if (run.rounds.length >= definition.limits.maxRounds) {
					return await this.#finishBounded(run, "Room round limit is reached");
				}
				if (run.messageCount + definition.members.length > definition.limits.maxMessages) {
					return await this.#finishBounded(run, "Room message limit is reached");
				}
				const roundNumber = run.rounds.length + 1;
				const workflow = await this.#workflows.startAdHoc(
					roomWorkflow(definition, run.id, roundNumber),
					roomPrompt(definition, run),
					{ id: definition.id, runId: run.id, round: roundNumber },
				);
				run.currentWorkflowRunId = workflow.id;
				run.workflowRunIds.push(workflow.id);
				await this.#persistRun(run);
				const completed = await withDeadline(
					this.#workflows.waitForCompletion(workflow.id),
					Math.max(1, run.deadlineAt - Date.now()),
				);
				if (!completed) {
					await this.#workflows.cancel(workflow.id).catch(() => undefined);
					return await this.#finishBounded(run, "Room duration limit is reached");
				}
				if (this.#runs.get(run.id)?.status === "cancelled") return;
				const round = await this.#completeRound(definition, run, completed, roundNumber);
				run.rounds.push(round);
				run.currentWorkflowRunId = undefined;
				for (const turn of round.turns) {
					run.messageCount += 1;
					run.totalTokens += turn.totalTokens;
					run.costUsd += turn.costUsd;
				}
				await this.#persistRun(run);
				if (round.status === "needs-user") {
					run.status = "needs-user";
					run.userQuestion = round.turns
						.filter((turn) => turn.status === "needs-user")
						.map((turn) => `${turn.agentId}: ${turn.message}`)
						.join("\n");
					return await this.#persistRun(run);
				}
				if (round.status === "failed") {
					run.status = "failed";
					run.finishedAt = Date.now();
					run.error = "One or more room members failed to produce a valid turn";
					return await this.#persistRun(run);
				}
				if (run.totalTokens > definition.limits.maxTotalTokens) {
					return await this.#finishBounded(run, "Room token limit is reached");
				}
				if (run.costUsd > definition.limits.maxCostUsd) {
					return await this.#finishBounded(run, "Room cost limit is reached");
				}
				if (round.turns.every((turn) => turn.requestAgentIds?.length === 0)) {
					run.status = "completed";
					run.finishedAt = Date.now();
					run.result = roomResult(run);
					return await this.#persistRun(run);
				}
			}
		} catch (error) {
			if (run.status === "cancelled") return;
			run.status = "failed";
			run.finishedAt = Date.now();
			run.currentWorkflowRunId = undefined;
			run.error = error instanceof Error ? error.message : String(error);
			await this.#persistRun(run);
		}
	}

	async #completeRound(
		definition: AgentRoomDefinition,
		run: AgentRoomRun,
		workflow: WorkflowRun,
		roundNumber: number,
	): Promise<AgentRoomRound> {
		const turns: AgentRoomTurn[] = [];
		for (let memberIndex = 0; memberIndex < definition.members.length; memberIndex++) {
			const member = definition.members[memberIndex]!;
			const node = workflow.nodeResults.find((result) => result.nodeId === `member-${memberIndex}`);
			const turn = roomTurn(member, memberIndex, node, definition.members);
			turns.push(turn);
			if (turn.taskId) appendUnique(run.taskIds, [turn.taskId]);
			const task = turn.taskId ? this.#tasks.getTask(turn.taskId) : undefined;
			const author: AgentContextAuthor = {
				kind: "agent",
				agentId: member.agentId,
				agentRevision: task?.contract.agentRevision ?? 1,
			};
			await this.#tasks.appendRoomMessage({
				roomId: definition.id,
				id: `room:${run.id}:round:${roundNumber}:member:${memberIndex}`,
				author,
				text: turn.message,
				taskId: turn.taskId,
			});
		}
		const status = turns.some((turn) => turn.status === "needs-user")
			? "needs-user"
			: turns.some((turn) => turn.status === "failed" || turn.status === "cancelled")
				? "failed"
				: "completed";
		return {
			id: `round-${roundNumber}`,
			number: roundNumber,
			workflowRunId: workflow.id,
			status,
			startedAt: workflow.createdAt,
			finishedAt: workflow.finishedAt ?? Date.now(),
			turns,
		};
	}

	async #recoverInterruptedRound(run: AgentRoomRun): Promise<void> {
		if (!run.currentWorkflowRunId) return;
		const workflow = this.#workflows.getRun(run.currentWorkflowRunId);
		const definition = this.#definitions.get(run.roomId);
		if (!workflow) return;
		appendUnique(run.taskIds, workflow.taskIds);
		if (!definition || workflow.nodeResults.length === 0) return;
		const roundNumber = run.rounds.length + 1;
		if (run.rounds.some((round) => round.workflowRunId === workflow.id)) return;
		const round = await this.#completeRound(definition, run, workflow, roundNumber);
		run.rounds.push(round);
		for (const turn of round.turns) {
			run.messageCount += 1;
			run.totalTokens += turn.totalTokens;
			run.costUsd += turn.costUsd;
		}
	}

	async #finishBounded(run: AgentRoomRun, reason: string): Promise<void> {
		run.status = "bounded";
		run.finishedAt = Date.now();
		run.currentWorkflowRunId = undefined;
		run.result = roomResult(run);
		run.error = reason;
		await this.#persistRun(run);
	}

	async #validateMembers(members: AgentRoomMember[]): Promise<void> {
		for (const member of members) {
			if (!(await this.#registry.get(member.agentId))) throw new Error(`Room agent ${member.agentId} was not found`);
		}
	}

	async #persistRun(run: AgentRoomRun): Promise<void> {
		await writeAtomic(resolve(this.#runsDir, run.id, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
	}
}

function appendUnique(target: string[], values: readonly string[]): void {
	const existing = new Set(target);
	for (const value of values) {
		if (existing.has(value)) continue;
		existing.add(value);
		target.push(value);
	}
}

function normalizeDefinitionInput(
	input: AgentRoomDefinitionInput,
): Omit<AgentRoomDefinition, "version" | "conversationId" | "createdAt" | "updatedAt"> {
	const name = boundedText(input.name, "room.name", 256);
	const id = input.id === undefined ? slugify(name) : requiredIdentifier(input.id, "room.id");
	const purpose = boundedText(input.purpose, "room.purpose", 4096);
	if (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > 8) {
		throw new Error("room.members must contain between 2 and 8 agents");
	}
	const members = input.members.map((member, index) => ({
		agentId: requiredIdentifier(member.agentId, `room.members[${index}].agentId`),
		role: boundedText(member.role, `room.members[${index}].role`, 512),
	}));
	if (new Set(members.map((member) => member.agentId)).size !== members.length) {
		throw new Error("room.members must contain unique agents");
	}
	return { id, name, purpose, members, limits: normalizeLimits(input.limits) };
}

function normalizeLimits(input: Partial<AgentRoomLimits> | undefined): AgentRoomLimits {
	return {
		maxRounds: boundedInteger(input?.maxRounds ?? DEFAULT_LIMITS.maxRounds, "room.limits.maxRounds", 1, 6),
		maxMessages: boundedInteger(input?.maxMessages ?? DEFAULT_LIMITS.maxMessages, "room.limits.maxMessages", 3, 96),
		maxConcurrency: boundedInteger(
			input?.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
			"room.limits.maxConcurrency",
			1,
			4,
		),
		maxDurationMs: boundedInteger(
			input?.maxDurationMs ?? DEFAULT_LIMITS.maxDurationMs,
			"room.limits.maxDurationMs",
			1_000,
			30 * 60_000,
		),
		maxTotalTokens: boundedInteger(
			input?.maxTotalTokens ?? DEFAULT_LIMITS.maxTotalTokens,
			"room.limits.maxTotalTokens",
			1,
			500_000,
		),
		maxCostUsd: boundedNumber(input?.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd, "room.limits.maxCostUsd", 0, 100),
	};
}

function roomWorkflow(definition: AgentRoomDefinition, runId: string, round: number): WorkflowDefinitionInput {
	return {
		id: `room-${definition.id}-${round}`.slice(0, 64).replace(/-$/g, ""),
		name: `${definition.name} round ${round}`,
		pattern: "parallel",
		nodes: definition.members.map((member, index) => ({
			id: `member-${index}`,
			agentId: member.agentId,
			prompt: [
				`You are member ${index + 1} in bounded local room ${definition.id}, run ${runId}, round ${round}.`,
				`Your role: ${member.role}`,
				"Do not delegate. Return only JSON with outcome reply, pass, or needs-user, a concise message, and requestAgentIds.",
				"Use reply when you add material progress, pass when no further contribution is needed, and needs-user only for a blocking human decision.",
				`Room members: ${definition.members.map((entry) => `${entry.agentId} (${entry.role})`).join("; ")}.`,
				"Set requestAgentIds to [] when no follow-up is needed. A reply does not automatically request another round.",
				"Request only listed member IDs (including yourself) when another turn is needed, and explain the requested work in message. Requests start another full-room round, subject to the room limits; they grant no delegation authority.",
				"Members run concurrently and cannot see each other's current-round output. If your role requires reviewing new evidence that is not yet visible, request its author for a follow-up round rather than assuming it was reviewed.",
			].join("\n"),
			outputSchema: {
				type: "object",
				properties: {
					outcome: { enum: ["reply", "pass", "needs-user"] },
					message: { type: "string", minLength: 1, maxLength: 8192 },
					requestAgentIds: {
						type: "array",
						items: { type: "string", enum: definition.members.map((entry) => entry.agentId) },
						maxItems: definition.members.length,
						uniqueItems: true,
					},
				},
				required: ["outcome", "message", "requestAgentIds"],
				additionalProperties: false,
			},
			required: true,
		})),
		edges: [],
		maxConcurrency: Math.min(definition.limits.maxConcurrency, definition.members.length),
		maxDelegationDepth: 1,
		failurePolicy: "continue",
	};
}

function roomPrompt(definition: AgentRoomDefinition, run: AgentRoomRun): string {
	const prior = run.rounds.flatMap((round) =>
		round.turns.map(
			(turn) =>
				`Round ${round.number} · ${turn.agentId} · ${turn.status}: ${turn.message}${turn.requestAgentIds?.length ? `\nRequested follow-up from: ${turn.requestAgentIds.join(", ")}` : ""}`,
		),
	);
	return [
		`Room purpose: ${definition.purpose}`,
		`Goal: ${run.goal}`,
		...(prior.length > 0 ? ["Prior ordered room turns:", ...prior] : []),
	]
		.join("\n\n")
		.slice(0, 32 * 1024);
}

function roomTurn(
	member: AgentRoomMember,
	memberIndex: number,
	node: WorkflowNodeRun | undefined,
	members: AgentRoomMember[],
): AgentRoomTurn {
	if (!node) return failedTurn(member, memberIndex, undefined, "Room member produced no workflow evidence");
	if (node.status !== "completed" || !node.result) {
		return failedTurn(member, memberIndex, node.agentTaskId, node.error ?? "Room member task failed");
	}
	const parsed = parseOutcome(node.result, members);
	if (!parsed) return failedTurn(member, memberIndex, node.agentTaskId, "Room member returned an invalid outcome");
	return {
		memberIndex,
		agentId: member.agentId,
		taskId: node.agentTaskId,
		status: parsed.outcome,
		message: safeText(parsed.message),
		requestAgentIds: parsed.requestAgentIds,
		totalTokens: node.usage?.totalTokens ?? 0,
		costUsd: node.usage?.costUsd ?? 0,
	};
}

function failedTurn(
	member: AgentRoomMember,
	memberIndex: number,
	taskId: string | undefined,
	message: string,
): AgentRoomTurn {
	return {
		memberIndex,
		agentId: member.agentId,
		taskId,
		status: "failed",
		message: safeText(message),
		totalTokens: 0,
		costUsd: 0,
	};
}

function parseOutcome(
	value: string,
	members: AgentRoomMember[],
): { outcome: "reply" | "pass" | "needs-user"; message: string; requestAgentIds: string[] } | undefined {
	const candidates = [
		value.trim(),
		...[...value.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1] ?? ""),
	];
	for (const candidate of candidates) {
		try {
			const record = object(JSON.parse(candidate), "room outcome");
			if (record.outcome !== "reply" && record.outcome !== "pass" && record.outcome !== "needs-user") continue;
			if (typeof record.message !== "string" || !record.message.trim()) continue;
			const requestAgentIds = stringArray(record.requestAgentIds, "room outcome.requestAgentIds");
			if (
				requestAgentIds.length > members.length ||
				new Set(requestAgentIds).size !== requestAgentIds.length ||
				requestAgentIds.some((id) => !members.some((member) => member.agentId === id))
			)
				continue;
			return { outcome: record.outcome, message: record.message.trim(), requestAgentIds };
		} catch {
			// Try the next bounded JSON representation.
		}
	}
	return undefined;
}

function roomResult(run: AgentRoomRun): string {
	return run.rounds
		.flatMap((round) =>
			round.turns.filter((turn) => turn.status === "reply").map((turn) => `${turn.agentId}: ${turn.message}`),
		)
		.join("\n\n")
		.slice(0, 32 * 1024);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolveTimeout) => {
				timeout = setTimeout(() => resolveTimeout(undefined), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function parseDefinition(value: unknown): AgentRoomDefinition {
	const record = object(value, "room definition");
	if (record.version !== 1) throw new Error("Invalid room definition version");
	const normalized = normalizeDefinitionInput({
		id: requiredIdentifier(record.id, "room.id"),
		name: requiredString(record.name, "room.name"),
		purpose: requiredString(record.purpose, "room.purpose"),
		members: parseMembers(record.members),
		limits: object(record.limits, "room.limits") as unknown as Partial<AgentRoomLimits>,
	});
	return {
		version: 1,
		...normalized,
		conversationId: requiredString(record.conversationId, "room.conversationId"),
		createdAt: requiredNumber(record.createdAt, "room.createdAt"),
		updatedAt: requiredNumber(record.updatedAt, "room.updatedAt"),
	};
}

function parseRun(value: unknown): AgentRoomRun {
	const record = object(value, "room run");
	if (record.version !== 1) throw new Error("Invalid room run version");
	const status = record.status;
	if (!isRunStatus(status)) throw new Error("Invalid room run status");
	return {
		version: 1,
		id: requiredString(record.id, "room run.id"),
		roomId: requiredIdentifier(record.roomId, "room run.roomId"),
		status,
		goal: requiredString(record.goal, "room run.goal"),
		createdAt: requiredNumber(record.createdAt, "room run.createdAt"),
		deadlineAt: requiredNumber(record.deadlineAt, "room run.deadlineAt"),
		finishedAt: optionalNumber(record.finishedAt),
		rounds: parseRounds(record.rounds),
		workflowRunIds: stringArray(record.workflowRunIds, "room run.workflowRunIds"),
		taskIds: stringArray(record.taskIds, "room run.taskIds"),
		messageCount: nonNegativeInteger(record.messageCount, "room run.messageCount"),
		totalTokens: nonNegativeNumber(record.totalTokens, "room run.totalTokens"),
		costUsd: nonNegativeNumber(record.costUsd, "room run.costUsd"),
		currentWorkflowRunId: optionalString(record.currentWorkflowRunId),
		userQuestion: optionalString(record.userQuestion),
		result: optionalString(record.result),
		error: optionalString(record.error),
	};
}

function parseRounds(value: unknown): AgentRoomRound[] {
	if (!Array.isArray(value)) throw new Error("room run.rounds must be an array");
	return value.map((entry, index) => {
		const record = object(entry, `room run.rounds[${index}]`);
		const status = record.status;
		if (status !== "completed" && status !== "needs-user" && status !== "failed" && status !== "cancelled") {
			throw new Error("Invalid room round status");
		}
		return {
			id: requiredString(record.id, "room round.id"),
			number: boundedInteger(record.number, "room round.number", 1, Number.MAX_SAFE_INTEGER),
			workflowRunId: requiredString(record.workflowRunId, "room round.workflowRunId"),
			status,
			startedAt: requiredNumber(record.startedAt, "room round.startedAt"),
			finishedAt: requiredNumber(record.finishedAt, "room round.finishedAt"),
			turns: parseTurns(record.turns),
		};
	});
}

function parseTurns(value: unknown): AgentRoomTurn[] {
	if (!Array.isArray(value)) throw new Error("room round.turns must be an array");
	return value.map((entry, index) => {
		const record = object(entry, `room round.turns[${index}]`);
		const status = record.status;
		if (
			status !== "reply" &&
			status !== "pass" &&
			status !== "needs-user" &&
			status !== "failed" &&
			status !== "cancelled"
		) {
			throw new Error("Invalid room turn status");
		}
		return {
			memberIndex: nonNegativeInteger(record.memberIndex, "room turn.memberIndex"),
			agentId: requiredIdentifier(record.agentId, "room turn.agentId"),
			taskId: optionalString(record.taskId),
			status,
			message: requiredString(record.message, "room turn.message"),
			requestAgentIds:
				record.requestAgentIds === undefined
					? undefined
					: stringArray(record.requestAgentIds, "room turn.requestAgentIds"),
			totalTokens: nonNegativeNumber(record.totalTokens, "room turn.totalTokens"),
			costUsd: nonNegativeNumber(record.costUsd, "room turn.costUsd"),
		};
	});
}

function parseMembers(value: unknown): AgentRoomMember[] {
	if (!Array.isArray(value)) throw new Error("room.members must be an array");
	return value.map((entry, index) => {
		const record = object(entry, `room.members[${index}]`);
		return {
			agentId: requiredString(record.agentId, `room.members[${index}].agentId`),
			role: requiredString(record.role, `room.members[${index}].role`),
		};
	});
}

function cloneDefinition(definition: AgentRoomDefinition): AgentRoomDefinition {
	return {
		...definition,
		members: definition.members.map((member) => ({ ...member })),
		limits: { ...definition.limits },
	};
}

function cloneRun(run: AgentRoomRun): AgentRoomRun {
	return {
		...run,
		rounds: run.rounds.map((round) => ({
			...round,
			turns: round.turns.map((turn) => ({
				...turn,
				requestAgentIds: turn.requestAgentIds ? [...turn.requestAgentIds] : undefined,
			})),
		})),
		workflowRunIds: [...run.workflowRunIds],
		taskIds: [...run.taskIds],
	};
}

function isRunStatus(value: unknown): value is AgentRoomRunStatus {
	return (
		value === "running" ||
		value === "completed" ||
		value === "needs-user" ||
		value === "bounded" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function safeText(value: string): string {
	return value
		.replace(/authorization\s*[:=]\s*(?:Bearer\s+)?\S+/gi, "Authorization=[redacted]")
		.replace(/(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*\S+/gi, "$1=[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
		.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[path]")
		.replace(/\/(?:Users|home|tmp|etc|var)\/\S+/g, "[path]")
		.trim()
		.slice(0, 8192);
}

function boundedText(value: unknown, name: string, maximumBytes: number): string {
	const text = requiredString(value, name);
	if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error(`${name} exceeds ${maximumBytes} bytes`);
	return text;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredIdentifier(value: unknown, name: string): string {
	const id = requiredString(value, name);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`${name} contains unsupported characters`);
	return id;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown, name: string): number {
	const number = requiredNumber(value, name);
	if (number < 0) throw new Error(`${name} must be non-negative`);
	return number;
}

function nonNegativeInteger(value: unknown, name: string): number {
	return boundedInteger(value, name, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return Number(value);
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
	const number = requiredNumber(value, name);
	if (number < minimum || number > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	return number;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new Error(`${name} must be an array of strings`);
	}
	return [...value];
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("room.name must contain a letter or number");
	return slug;
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
