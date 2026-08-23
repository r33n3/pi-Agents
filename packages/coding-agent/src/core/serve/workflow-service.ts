import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentTask, AgentTaskService } from "./agent-task-service.ts";
import type { BrowserOwner, BrowserWorkspace } from "./browser-session-manager.ts";
import type { BrowserWorkflowRunner } from "./browser-workflow-runner.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type WorkflowPattern = "sequential" | "parallel" | "supervisor";

export interface AgentWorkflowNode {
	id: string;
	kind?: "agent";
	agentId: string;
	prompt: string;
}

export interface BrowserWorkflowNode {
	id: string;
	kind: "browser-workflow";
	workflowId: string;
	workflowVersion: number;
	parameters: Record<string, string | number | boolean>;
}

export type WorkflowNode = AgentWorkflowNode | BrowserWorkflowNode;

export interface WorkflowEdge {
	from: string;
	to: string;
}

export interface WorkflowDefinition {
	id: string;
	name: string;
	pattern: WorkflowPattern;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	supervisorAgentId?: string;
	maxConcurrency: number;
	maxDelegationDepth: number;
	failurePolicy: "stop" | "continue" | "supervisor-decides";
}

export type WorkflowDefinitionInput = Omit<WorkflowDefinition, "id"> & { id?: string };

export interface WorkflowRun {
	id: string;
	workflowId: string;
	status: "running" | "completed" | "failed" | "cancelled";
	prompt: string;
	createdAt: number;
	finishedAt?: number;
	taskIds: string[];
	browserRunIds: string[];
	result?: string;
	error?: string;
}

interface WorkflowNodeResult {
	id: string;
	label: string;
	completed: boolean;
	agentTaskId?: string;
	result?: string;
	error?: string;
}

/** Owns validated workflow definitions and executes them through AgentTaskService. */
export class WorkflowService {
	readonly #definitionsDir: string;
	readonly #runsDir: string;
	readonly #registry: AgentRegistry;
	readonly #tasks: AgentTaskService;
	readonly #browser: { runner: BrowserWorkflowRunner; owner: BrowserOwner; workspace: BrowserWorkspace } | undefined;
	readonly #queue = new SerialOperationQueue();
	readonly #definitions = new Map<string, WorkflowDefinition>();
	readonly #runs = new Map<string, WorkflowRun>();

	constructor(
		root: string,
		registry: AgentRegistry,
		tasks: AgentTaskService,
		browser?: { runner: BrowserWorkflowRunner; owner: BrowserOwner; workspace: BrowserWorkspace },
	) {
		this.#definitionsDir = resolve(root, "definitions");
		this.#runsDir = resolve(root, "runs");
		this.#registry = registry;
		this.#tasks = tasks;
		this.#browser = browser;
	}

	async initialize(): Promise<void> {
		await Promise.all([mkdir(this.#definitionsDir, { recursive: true }), mkdir(this.#runsDir, { recursive: true })]);
		for (const file of (await readdir(this.#definitionsDir)).filter((entry) => entry.endsWith(".json"))) {
			try {
				const definition = normalizeWorkflow(
					JSON.parse(await readFile(resolve(this.#definitionsDir, file), "utf8")),
				);
				await this.#validateAgents(definition);
				this.#definitions.set(definition.id, definition);
			} catch {
				// Invalid definitions remain unavailable until corrected.
			}
		}
		for (const entry of await readdir(this.#runsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const run = parseWorkflowRun(
					JSON.parse(await readFile(resolve(this.#runsDir, entry.name, "run.json"), "utf8")),
				);
				if (run.status === "running") {
					run.status = "failed";
					run.finishedAt = Date.now();
					run.error = "Serve host stopped before the workflow completed";
					await this.#persistRun(run);
				}
				this.#runs.set(run.id, run);
			} catch {
				// Malformed workflow runs are not exposed.
			}
		}
	}

	listDefinitions(): WorkflowDefinition[] {
		return [...this.#definitions.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(cloneDefinition);
	}

	getDefinition(id: string): WorkflowDefinition | undefined {
		const definition = this.#definitions.get(id);
		return definition ? cloneDefinition(definition) : undefined;
	}

	async save(input: WorkflowDefinitionInput): Promise<WorkflowDefinition> {
		return this.#queue.run(async () => {
			const definition = normalizeWorkflow(input);
			await this.#validateAgents(definition);
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
			if (this.listRuns(id).some((run) => run.status === "running")) {
				throw new Error("A running workflow cannot be deleted");
			}
			try {
				await unlink(resolve(this.#definitionsDir, `${requiredIdentifier(id, "workflow.id")}.json`));
				this.#definitions.delete(id);
				return true;
			} catch (error) {
				if (isNodeError(error) && error.code === "ENOENT") return false;
				throw error;
			}
		});
	}

	listRuns(workflowId?: string): WorkflowRun[] {
		return [...this.#runs.values()]
			.filter((run) => workflowId === undefined || run.workflowId === workflowId)
			.sort((left, right) => right.createdAt - left.createdAt)
			.map(cloneRun);
	}

	getRun(id: string): WorkflowRun | undefined {
		const run = this.#runs.get(id);
		return run ? cloneRun(run) : undefined;
	}

	async start(workflowId: string, prompt: string): Promise<WorkflowRun> {
		const definition = this.#definitions.get(workflowId);
		if (!definition) throw new Error(`Workflow ${workflowId} was not found`);
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt) throw new Error("Workflow prompt is required");
		const run: WorkflowRun = {
			id: randomUUID(),
			workflowId,
			status: "running",
			prompt: trimmedPrompt,
			createdAt: Date.now(),
			taskIds: [],
			browserRunIds: [],
		};
		this.#runs.set(run.id, run);
		await this.#persistRun(run);
		void this.#execute(definition, run);
		return cloneRun(run);
	}

	async waitForCompletion(runId: string): Promise<WorkflowRun> {
		while (this.#runs.get(runId)?.status === "running") {
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Workflow run ${runId} was not found`);
		return cloneRun(run);
	}

	async cancel(runId: string): Promise<WorkflowRun> {
		const run = this.#runs.get(runId);
		if (!run) throw new Error(`Workflow run ${runId} was not found`);
		if (run.status !== "running") return cloneRun(run);
		await Promise.all(run.taskIds.map((taskId) => this.#tasks.cancel(taskId).catch(() => undefined)));
		await Promise.all(run.browserRunIds.map((runId) => this.#browser?.runner.cancel(runId).catch(() => undefined)));
		run.status = "cancelled";
		run.finishedAt = Date.now();
		run.error = "Workflow was cancelled";
		await this.#persistRun(run);
		return cloneRun(run);
	}

	async #execute(definition: WorkflowDefinition, run: WorkflowRun): Promise<void> {
		try {
			const ordered = topologicalOrder(definition);
			const results =
				definition.pattern === "parallel"
					? await this.#executeParallel(definition, run, ordered)
					: await this.#executeSequential(definition, run, ordered);
			if (definition.pattern === "supervisor") {
				const supervisorAgentId = definition.supervisorAgentId;
				if (!supervisorAgentId) throw new Error("Supervisor workflow is missing its supervisor agent");
				const task = await this.#tasks.submit({
					agentId: supervisorAgentId,
					source: "workflow",
					workflowRunId: run.id,
					prompt: [
						`Goal: ${run.prompt}`,
						"Produce the final report from these delegated results. Include outcome, completed work, unresolved issues, and artifact references.",
						...results.map((result) => `${result.label}: ${result.result ?? result.error ?? "failed"}`),
					].join("\n\n"),
				});
				run.taskIds.push(task.id);
				await this.#persistRun(run);
				const completed = await this.#tasks.waitForCompletion(task.id);
				if (completed.status !== "completed") throw new Error(completed.error ?? "Supervisor task failed");
				run.result = completed.result;
			} else {
				run.result = results
					.map((result) => result.result)
					.filter((value): value is string => value !== undefined)
					.join("\n\n");
			}
			if (run.status === "cancelled") return;
			run.status = "completed";
		} catch (error) {
			if (run.status === "cancelled") return;
			run.status = "failed";
			run.error = error instanceof Error ? error.message : String(error);
		} finally {
			run.finishedAt = Date.now();
			await this.#persistRun(run);
		}
	}

	async #executeSequential(
		definition: WorkflowDefinition,
		run: WorkflowRun,
		ordered: WorkflowNode[],
	): Promise<WorkflowNodeResult[]> {
		const results: WorkflowNodeResult[] = [];
		for (const node of ordered) {
			const completed = await this.#executeNode(node, run, results.at(-1));
			results.push(completed);
			if (!completed.completed && definition.failurePolicy === "stop") {
				throw new Error(completed.error ?? `Workflow node ${node.id} failed`);
			}
		}
		return results;
	}

	async #executeParallel(
		definition: WorkflowDefinition,
		run: WorkflowRun,
		ordered: WorkflowNode[],
	): Promise<WorkflowNodeResult[]> {
		const results: WorkflowNodeResult[] = [];
		for (let offset = 0; offset < ordered.length; offset += definition.maxConcurrency) {
			const batch = ordered.slice(offset, offset + definition.maxConcurrency);
			const completed = await Promise.all(batch.map((node) => this.#executeNode(node, run)));
			results.push(...completed);
			const failed = completed.find((result) => !result.completed);
			if (failed && definition.failurePolicy === "stop")
				throw new Error(failed.error ?? "Parallel workflow task failed");
		}
		return results;
	}

	async #executeNode(node: WorkflowNode, run: WorkflowRun, prior?: WorkflowNodeResult): Promise<WorkflowNodeResult> {
		if (node.kind === "browser-workflow") {
			if (!this.#browser) throw new Error("Browser workflow runtime is unavailable");
			const execution = await this.#browser.runner.startExecute(
				node.workflowId,
				{ owner: this.#browser.owner, workspace: this.#browser.workspace, parameters: node.parameters },
				node.workflowVersion,
			);
			run.browserRunIds.push(execution.runId);
			await this.#persistRun(run);
			const completed = await execution.completion;
			return {
				id: completed.id,
				label: `${node.workflowId}@${node.workflowVersion}`,
				completed: completed.status === "completed",
				result: completed.status === "completed" ? JSON.stringify(completed) : undefined,
				error: completed.error,
			};
		}
		const task = await this.#tasks.submit({
			agentId: node.agentId,
			source: "workflow",
			workflowRunId: run.id,
			parentTaskId: prior?.agentTaskId,
			prompt: [run.prompt, node.prompt, prior?.result ? `Previous result:\n${prior.result}` : undefined]
				.filter((value): value is string => value !== undefined)
				.join("\n\n"),
		});
		run.taskIds.push(task.id);
		await this.#persistRun(run);
		return workflowResult(await this.#tasks.waitForCompletion(task.id));
	}

	async #validateAgents(definition: WorkflowDefinition): Promise<void> {
		for (const node of definition.nodes) {
			if (node.kind !== "browser-workflow") continue;
			if (!this.#browser?.runner.isActiveVersion(node.workflowId, node.workflowVersion)) {
				throw new Error(`Browser workflow ${node.workflowId} version ${node.workflowVersion} is not active`);
			}
		}
		for (const agentId of new Set([
			...definition.nodes.filter(isAgentNode).map((node) => node.agentId),
			...(definition.supervisorAgentId ? [definition.supervisorAgentId] : []),
		])) {
			if (!(await this.#registry.get(agentId))) throw new Error(`Workflow agent ${agentId} was not found`);
		}
		if (definition.pattern === "supervisor" && definition.supervisorAgentId) {
			const supervisor = await this.#registry.get(definition.supervisorAgentId);
			const unauthorized = definition.nodes
				.filter(isAgentNode)
				.find(
					(node) =>
						node.agentId !== definition.supervisorAgentId && !supervisor?.delegateAgentIds.includes(node.agentId),
				);
			if (unauthorized) {
				throw new Error(`Supervisor ${definition.supervisorAgentId} may not delegate to ${unauthorized.agentId}`);
			}
		}
	}

	async #persistRun(run: WorkflowRun): Promise<void> {
		await writeAtomic(resolve(this.#runsDir, run.id, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
	}
}

function normalizeWorkflow(value: unknown): WorkflowDefinition {
	const input = object(value, "workflow definition");
	const name = requiredString(input.name, "workflow.name");
	const id = input.id === undefined ? slugify(name) : requiredIdentifier(input.id, "workflow.id");
	const pattern = oneOf(input.pattern, ["sequential", "parallel", "supervisor"], "workflow.pattern");
	if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new Error("workflow.nodes must not be empty");
	const nodes = input.nodes.map((entry, index): WorkflowNode => {
		const node = object(entry, `workflow.nodes[${index}]`);
		const nodeId = requiredIdentifier(node.id, `workflow.nodes[${index}].id`);
		if (node.kind === "browser-workflow") {
			return {
				id: nodeId,
				kind: "browser-workflow",
				workflowId: requiredIdentifier(node.workflowId, `workflow.nodes[${index}].workflowId`),
				workflowVersion: positiveInteger(
					node.workflowVersion,
					`workflow.nodes[${index}].workflowVersion`,
					Number.MAX_SAFE_INTEGER,
				),
				parameters: normalizeWorkflowParameters(node.parameters, `workflow.nodes[${index}].parameters`),
			};
		}
		if (node.kind !== undefined && node.kind !== "agent") {
			throw new Error(`workflow.nodes[${index}].kind must be agent or browser-workflow`);
		}
		return {
			id: nodeId,
			kind: "agent",
			agentId: requiredIdentifier(node.agentId, `workflow.nodes[${index}].agentId`),
			prompt: requiredString(node.prompt, `workflow.nodes[${index}].prompt`),
		};
	});
	if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error("workflow node ids must be unique");
	if (!Array.isArray(input.edges)) throw new Error("workflow.edges must be an array");
	const edges = input.edges.map((entry, index) => {
		const edge = object(entry, `workflow.edges[${index}]`);
		return {
			from: requiredIdentifier(edge.from, `workflow.edges[${index}].from`),
			to: requiredIdentifier(edge.to, `workflow.edges[${index}].to`),
		};
	});
	const nodeIds = new Set(nodes.map((node) => node.id));
	for (const edge of edges) {
		if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error("workflow edge references an unknown node");
	}
	const maxConcurrency = positiveInteger(input.maxConcurrency, "workflow.maxConcurrency", 16);
	const maxDelegationDepth = positiveInteger(input.maxDelegationDepth, "workflow.maxDelegationDepth", 8);
	const definition: WorkflowDefinition = {
		id,
		name,
		pattern,
		nodes,
		edges,
		supervisorAgentId:
			input.supervisorAgentId === undefined
				? undefined
				: requiredIdentifier(input.supervisorAgentId, "workflow.supervisorAgentId"),
		maxConcurrency,
		maxDelegationDepth,
		failurePolicy: oneOf(input.failurePolicy, ["stop", "continue", "supervisor-decides"], "workflow.failurePolicy"),
	};
	if (pattern === "supervisor" && !definition.supervisorAgentId) {
		throw new Error("supervisorAgentId is required for supervisor workflows");
	}
	topologicalOrder(definition);
	return definition;
}

function topologicalOrder(definition: WorkflowDefinition): WorkflowNode[] {
	const byId = new Map(definition.nodes.map((node) => [node.id, node]));
	const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
	const outgoing = new Map(definition.nodes.map((node) => [node.id, [] as string[]]));
	for (const edge of definition.edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
		outgoing.get(edge.from)?.push(edge.to);
	}
	const ready = definition.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
	const ordered: WorkflowNode[] = [];
	while (ready.length > 0) {
		const id = ready.shift()!;
		ordered.push(byId.get(id)!);
		for (const target of outgoing.get(id) ?? []) {
			const next = (incoming.get(target) ?? 1) - 1;
			incoming.set(target, next);
			if (next === 0) ready.push(target);
		}
	}
	if (ordered.length !== definition.nodes.length) throw new Error("workflow graph contains a cycle");
	return ordered;
}

function parseWorkflowRun(value: unknown): WorkflowRun {
	const input = object(value, "workflow run");
	const status = oneOf(input.status, ["running", "completed", "failed", "cancelled"], "workflow run status");
	if (!Array.isArray(input.taskIds) || !input.taskIds.every((entry) => typeof entry === "string")) {
		throw new Error("workflow run taskIds must be an array of strings");
	}
	if (
		input.browserRunIds !== undefined &&
		(!Array.isArray(input.browserRunIds) || !input.browserRunIds.every((entry) => typeof entry === "string"))
	) {
		throw new Error("workflow run browserRunIds must be an array of strings");
	}
	return {
		id: requiredString(input.id, "workflow run id"),
		workflowId: requiredString(input.workflowId, "workflow run workflowId"),
		status,
		prompt: requiredString(input.prompt, "workflow run prompt"),
		createdAt: requiredNumber(input.createdAt, "workflow run createdAt"),
		finishedAt: typeof input.finishedAt === "number" ? input.finishedAt : undefined,
		taskIds: [...input.taskIds],
		browserRunIds: Array.isArray(input.browserRunIds) ? [...input.browserRunIds] : [],
		result: typeof input.result === "string" ? input.result : undefined,
		error: typeof input.error === "string" ? input.error : undefined,
	};
}

function cloneDefinition(definition: WorkflowDefinition): WorkflowDefinition {
	return {
		...definition,
		nodes: definition.nodes.map((node) =>
			node.kind === "browser-workflow" ? { ...node, parameters: { ...node.parameters } } : { ...node },
		),
		edges: definition.edges.map((edge) => ({ ...edge })),
	};
}

function cloneRun(run: WorkflowRun): WorkflowRun {
	return { ...run, taskIds: [...run.taskIds], browserRunIds: [...run.browserRunIds] };
}

function workflowResult(task: AgentTask): WorkflowNodeResult {
	return {
		id: task.id,
		label: task.agentId,
		completed: task.status === "completed",
		agentTaskId: task.id,
		result: task.result,
		error: task.error,
	};
}

function isAgentNode(node: WorkflowNode): node is AgentWorkflowNode {
	return node.kind !== "browser-workflow";
}

function normalizeWorkflowParameters(value: unknown, name: string): Record<string, string | number | boolean> {
	const input = object(value, name);
	const parameters: Record<string, string | number | boolean> = {};
	for (const [parameter, entry] of Object.entries(input)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(parameter)) throw new Error(`${name} has an invalid parameter name`);
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`${name}.${parameter} must be a string, number, or boolean`);
		}
		parameters[parameter] = entry;
	}
	return parameters;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
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

function requiredIdentifier(value: unknown, name: string): string {
	const id = requiredString(value, name);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`${name} contains unsupported characters`);
	return id;
}

function positiveInteger(value: unknown, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
		throw new Error(`${name} must be an integer between 1 and ${maximum}`);
	}
	return Number(value);
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
	return value;
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T))
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	return value as T;
}

function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	if (!slug) throw new Error("workflow name must contain a letter or number");
	return slug;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
