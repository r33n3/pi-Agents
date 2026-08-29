import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentDefinition, AgentDefinitionInput, AgentPermissionPolicy, AgentRegistry } from "./agent-registry.ts";
import type { AgentRunUsage } from "./agent-run-manager.ts";
import type { AgentCapabilityGrant } from "./capability-broker.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";
import type { WorkflowDefinition, WorkflowDefinitionInput, WorkflowService } from "./workflow-service.ts";

export interface PiAgentBundleTool {
	name: string;
	credentialRef?: string;
}

export interface PiAgentBundleRole {
	id: string;
	name: string;
	description: string;
	instructions: string;
	acceptanceCriteria: string[];
	outputSchema: Record<string, unknown>;
	tools: PiAgentBundleTool[];
	permissionPolicy: AgentPermissionPolicy;
	memory: {
		readableNamespaces: string[];
		writableNamespaces: string[];
		maxInjectionItems?: number;
		sensitivityCeiling?: "public" | "internal" | "confidential" | "restricted";
	};
	policies: {
		escalationRules: string[];
		stopConditions: string[];
		forbiddenTools: string[];
		guardrails: string[];
	};
	modelRequirement?: { tier: string; maxTokens?: number; maxCostUsd?: number };
	delegateRoleIds: string[];
}

export interface PiAgentBundleWorkflowNode {
	id: string;
	roleId: string;
	prompt: string;
	required: boolean;
}

export interface PiAgentBundle {
	schemaVersion: "pi.agents.bundle.v1";
	bundleId: string;
	packageId: string;
	effectiveSourceDigest: string;
	contractDigest: string;
	executionForm: "pi-team-v1";
	roles: PiAgentBundleRole[];
	workflow: {
		id: string;
		name: string;
		coordinatorRoleId: string;
		nodes: PiAgentBundleWorkflowNode[];
		edges: Array<{ from: string; to: string }>;
		maxConcurrency: number;
		maxDelegationDepth: number;
		failurePolicy: "stop";
	};
	assurance: {
		adapterId: string;
		adapterVersion: string;
	};
}

export interface PiAgentBundleBindings {
	projectRoot: string;
	models: Record<string, ModelRef>;
	credentialRefs?: string[];
	capabilities?: Record<string, AgentCapabilityGrant[]>;
	review: PiAgentBundleBindingReview;
}

export type PiAgentBundleUnreviewedBindings = Omit<PiAgentBundleBindings, "review">;

export interface PiAgentBundleBindingReview {
	schemaVersion: "pi.agents.binding-review.v1";
	bundleDigest: string;
	bindingDigest: string;
	reviewedBy: string;
	reviewedAt: string;
}

export interface PiAgentBundleValidation {
	valid: boolean;
	bundle?: PiAgentBundle;
	bundleDigest?: string;
	missingBindings: string[];
	findings: Array<{ code: string; message: string }>;
}

export interface PiAgentBundleInstallRecord {
	schemaVersion: "pi.agents.install.v1";
	bundleId: string;
	packageId: string;
	effectiveSourceDigest: string;
	contractDigest: string;
	bundleDigest: string;
	executionForm: "pi-team-v1";
	adapter: { id: string; version: string };
	bindingReview: PiAgentBundleBindingReview;
	installedAt: string;
	agentIds: string[];
	workflowId: string;
	nodeBudgets: Record<string, PiAgentBundleBudget>;
}

export interface PiAgentBundleBudget {
	maxTokens?: number;
	maxCostUsd?: number;
}

export interface PiAgentBundleRuntimeEvidence {
	schemaVersion: "pi.agents.runtime-evidence.v1";
	evidenceId: string;
	bundleId: string;
	packageId: string;
	effectiveSourceDigest: string;
	contractDigest: string;
	bundleDigest: string;
	executionForm: "pi-team-v1";
	adapter: { id: string; version: string };
	bindingReview: PiAgentBundleBindingReview;
	workflowId: string;
	workflowRunId: string;
	startedAt: number;
	finishedAt: number;
	verdict: "goal-accomplished" | "goal-not-accomplished";
	nodes: Array<{
		nodeId: string;
		status: "completed" | "failed" | "blocked";
		required: boolean;
		predecessorNodeIds: string[];
		taskId?: string;
		usage?: AgentRunUsage;
		budget: PiAgentBundleBudget & {
			observedOutputTokens: number;
			observedCostUsd: number;
			status: "passed" | "failed" | "not-declared";
		};
		outputContract: {
			status: "passed" | "failed" | "not-declared";
			findings: string[];
		};
	}>;
	error?: string;
}

interface PiAgentBundleInstallPlan {
	bundle: PiAgentBundle;
	bundleDigest: string;
	agents: AgentDefinitionInput[];
	workflow: WorkflowDefinitionInput;
}

/** Validates and installs generated WTK team projections without exposing Pi registry paths. */
export class PiAgentBundleInstaller {
	readonly #root: string;
	readonly #registry: AgentRegistry;
	readonly #workflows: WorkflowService;
	readonly #queue = new SerialOperationQueue();

	constructor(root: string, registry: AgentRegistry, workflows: WorkflowService) {
		this.#root = resolve(root);
		this.#registry = registry;
		this.#workflows = workflows;
	}

	validate(value: unknown, bindings?: PiAgentBundleBindings): PiAgentBundleValidation {
		return validateBundle(value, bindings);
	}

	reviewBindings(
		value: unknown,
		bindingsValue: unknown,
		reviewedByValue: unknown,
	): { bindings: PiAgentBundleBindings; review: PiAgentBundleBindingReview } {
		const bundle = parsePiAgentBundle(value);
		const bindings = parsePiAgentBundleUnreviewedBindings(bindingsValue);
		const missing = missingLocalBindings(bundle, {
			...bindings,
			review: placeholderBindingReview(),
		});
		if (missing.length > 0) throw new Error(`Pi agent bindings are incomplete: ${missing.join(", ")}`);
		const review: PiAgentBundleBindingReview = {
			schemaVersion: "pi.agents.binding-review.v1",
			bundleDigest: digestBundle(bundle),
			bindingDigest: digestPiAgentBundleBindings(bindings),
			reviewedBy: string(reviewedByValue, "reviewedBy"),
			reviewedAt: new Date().toISOString(),
		};
		return { bindings: { ...bindings, review }, review };
	}

	async install(value: unknown, bindings: PiAgentBundleBindings): Promise<PiAgentBundleInstallRecord> {
		return this.#queue.run(async () => {
			const plan = createInstallPlan(value, bindings);
			const recordPath = resolve(this.#root, `${plan.bundle.bundleId}.json`);
			const existing = await readInstallRecord(recordPath);
			if (
				existing?.bundleDigest === plan.bundleDigest &&
				sameBindingReview(existing.bindingReview, bindings.review)
			) {
				return existing;
			}

			const previousAgents = new Map<string, AgentDefinition | undefined>();
			for (const agent of plan.agents) previousAgents.set(agent.id!, await this.#registry.get(agent.id!));
			const previousWorkflow = this.#workflows.getDefinition(plan.workflow.id!);
			try {
				for (const agent of plan.agents) await this.#registry.save(agent);
				await this.#workflows.save(plan.workflow);
			} catch (error) {
				await restoreInstallation(
					this.#registry,
					this.#workflows,
					previousAgents,
					previousWorkflow,
					plan.workflow.id!,
				);
				throw error;
			}

			const record: PiAgentBundleInstallRecord = {
				schemaVersion: "pi.agents.install.v1",
				bundleId: plan.bundle.bundleId,
				packageId: plan.bundle.packageId,
				effectiveSourceDigest: plan.bundle.effectiveSourceDigest,
				contractDigest: plan.bundle.contractDigest,
				bundleDigest: plan.bundleDigest,
				executionForm: plan.bundle.executionForm,
				adapter: { id: plan.bundle.assurance.adapterId, version: plan.bundle.assurance.adapterVersion },
				bindingReview: { ...bindings.review },
				installedAt: new Date().toISOString(),
				agentIds: plan.agents.map((agent) => agent.id!),
				workflowId: plan.workflow.id!,
				nodeBudgets: Object.fromEntries(
					plan.bundle.workflow.nodes.map((node) => {
						const role = plan.bundle.roles.find((candidate) => candidate.id === node.roleId)!;
						return [node.id, role.modelRequirement ? budgetFromRequirement(role.modelRequirement) : {}];
					}),
				),
			};
			await writeAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`);
			return record;
		});
	}

	async smoke(bundleId: string, prompt: string): Promise<PiAgentBundleRuntimeEvidence> {
		const id = identifier(bundleId, "bundleId");
		const goal = string(prompt, "prompt");
		const record = await readInstallRecord(resolve(this.#root, `${id}.json`));
		if (!record) throw new Error(`Installed Pi agent bundle ${id} was not found`);
		const started = await this.#workflows.start(record.workflowId, goal);
		const completed = await this.#workflows.waitForCompletion(started.id);
		const nodes: PiAgentBundleRuntimeEvidence["nodes"] = completed.nodeResults.map((node) => {
			const budget = record.nodeBudgets[node.nodeId] ?? {};
			const usage = node.usage;
			return {
				nodeId: node.nodeId,
				status: node.status,
				required: node.required,
				predecessorNodeIds: [...node.predecessorNodeIds],
				taskId: node.agentTaskId,
				usage: usage ? { ...usage } : undefined,
				budget: {
					...budget,
					observedOutputTokens: usage?.outputTokens ?? 0,
					observedCostUsd: usage?.costUsd ?? 0,
					status: budgetStatus(budget, usage),
				},
				outputContract: node.outputContract
					? { status: node.outputContract.status, findings: [...node.outputContract.findings] }
					: { status: "not-declared" as const, findings: [] },
			};
		});
		const requiredNodesPassed = nodes
			.filter((node) => node.required)
			.every(
				(node) =>
					node.status === "completed" &&
					node.outputContract.status === "passed" &&
					node.budget.status !== "failed",
			);
		const evidence: PiAgentBundleRuntimeEvidence = {
			schemaVersion: "pi.agents.runtime-evidence.v1",
			evidenceId: randomUUID(),
			bundleId: record.bundleId,
			packageId: record.packageId,
			effectiveSourceDigest: record.effectiveSourceDigest,
			contractDigest: record.contractDigest,
			bundleDigest: record.bundleDigest,
			executionForm: record.executionForm,
			adapter: { ...record.adapter },
			bindingReview: { ...record.bindingReview },
			workflowId: record.workflowId,
			workflowRunId: completed.id,
			startedAt: completed.createdAt,
			finishedAt: completed.finishedAt ?? Date.now(),
			verdict:
				completed.status === "completed" && requiredNodesPassed ? "goal-accomplished" : "goal-not-accomplished",
			nodes,
			error: completed.error,
		};
		await writeAtomic(
			resolve(this.#root, "evidence", id, `${evidence.evidenceId}.json`),
			`${JSON.stringify(evidence, null, 2)}\n`,
		);
		return evidence;
	}
}

export function parsePiAgentBundle(value: unknown): PiAgentBundle {
	const input = object(value, "Pi agent bundle");
	if (input.schemaVersion !== "pi.agents.bundle.v1") throw new Error("Unsupported Pi agent bundle schemaVersion");
	if (input.executionForm !== "pi-team-v1") throw new Error("Unsupported Pi agent bundle executionForm");
	const bundleId = identifier(input.bundleId, "bundleId");
	const packageId = identifier(input.packageId, "packageId");
	const rolesInput = array(input.roles, "roles");
	if (rolesInput.length < 2) throw new Error("Pi team bundles require at least two roles");
	const roles = rolesInput.map((entry, index) => parseRole(entry, `roles[${index}]`));
	assertUnique(
		roles.map((role) => role.id),
		"role ids",
	);
	const roleIds = new Set(roles.map((role) => role.id));
	for (const role of roles) {
		for (const delegate of role.delegateRoleIds) {
			if (!roleIds.has(delegate)) throw new Error(`Role ${role.id} delegates to unknown role ${delegate}`);
			if (delegate === role.id) throw new Error(`Role ${role.id} cannot delegate to itself`);
		}
		if (
			role.permissionPolicy === "read-only" &&
			role.tools.some((tool) => ["write", "edit", "bash"].includes(tool.name))
		) {
			throw new Error(`Read-only role ${role.id} cannot receive a mutating Pi tool`);
		}
	}
	const workflowInput = object(input.workflow, "workflow");
	const nodes = array(workflowInput.nodes, "workflow.nodes").map((entry, index) => {
		const node = object(entry, `workflow.nodes[${index}]`);
		const roleId = identifier(node.roleId, `workflow.nodes[${index}].roleId`);
		if (!roleIds.has(roleId)) throw new Error(`Workflow node references unknown role ${roleId}`);
		return {
			id: identifier(node.id, `workflow.nodes[${index}].id`),
			roleId,
			prompt: string(node.prompt, `workflow.nodes[${index}].prompt`),
			required: boolean(node.required, `workflow.nodes[${index}].required`),
		};
	});
	assertUnique(
		nodes.map((node) => node.id),
		"workflow node ids",
	);
	const nodeIds = new Set(nodes.map((node) => node.id));
	const edges = array(workflowInput.edges, "workflow.edges").map((entry, index) => {
		const edge = object(entry, `workflow.edges[${index}]`);
		const from = identifier(edge.from, `workflow.edges[${index}].from`);
		const to = identifier(edge.to, `workflow.edges[${index}].to`);
		if (!nodeIds.has(from) || !nodeIds.has(to)) throw new Error("Workflow edge references an unknown node");
		return { from, to };
	});
	assertAcyclic(
		nodes.map((node) => node.id),
		edges,
	);
	const coordinatorRoleId = identifier(workflowInput.coordinatorRoleId, "workflow.coordinatorRoleId");
	if (!roleIds.has(coordinatorRoleId)) throw new Error("workflow.coordinatorRoleId references an unknown role");
	if (workflowInput.failurePolicy !== "stop") throw new Error("pi-team-v1 requires stop-on-required-lane failure");
	const assuranceInput = object(input.assurance, "assurance");
	return {
		schemaVersion: "pi.agents.bundle.v1",
		bundleId,
		packageId,
		effectiveSourceDigest: sha256(input.effectiveSourceDigest, "effectiveSourceDigest"),
		contractDigest: sha256(input.contractDigest, "contractDigest"),
		executionForm: "pi-team-v1",
		roles,
		workflow: {
			id: identifier(workflowInput.id, "workflow.id"),
			name: string(workflowInput.name, "workflow.name"),
			coordinatorRoleId,
			nodes,
			edges,
			maxConcurrency: integer(workflowInput.maxConcurrency, "workflow.maxConcurrency", 16),
			maxDelegationDepth: integer(workflowInput.maxDelegationDepth, "workflow.maxDelegationDepth", 8),
			failurePolicy: "stop",
		},
		assurance: {
			adapterId: identifier(assuranceInput.adapterId, "assurance.adapterId"),
			adapterVersion: string(assuranceInput.adapterVersion, "assurance.adapterVersion"),
		},
	};
}

export function parsePiAgentBundleBindings(value: unknown): PiAgentBundleBindings {
	const bindings = parsePiAgentBundleUnreviewedBindings(value);
	const input = object(value, "Pi agent bundle bindings");
	const reviewInput = object(input.review, "bindings.review");
	return {
		...bindings,
		review: {
			schemaVersion: oneOf(
				reviewInput.schemaVersion,
				["pi.agents.binding-review.v1"],
				"bindings.review.schemaVersion",
			),
			bundleDigest: sha256(reviewInput.bundleDigest, "bindings.review.bundleDigest"),
			bindingDigest: sha256(reviewInput.bindingDigest, "bindings.review.bindingDigest"),
			reviewedBy: string(reviewInput.reviewedBy, "bindings.review.reviewedBy"),
			reviewedAt: timestamp(reviewInput.reviewedAt, "bindings.review.reviewedAt"),
		},
	};
}

export function parsePiAgentBundleUnreviewedBindings(value: unknown): PiAgentBundleUnreviewedBindings {
	const input = object(value, "Pi agent bundle bindings");
	const modelsInput = object(input.models, "bindings.models");
	const models: Record<string, ModelRef> = {};
	for (const [roleId, value] of Object.entries(modelsInput)) {
		identifier(roleId, "bindings.models role id");
		const model = object(value, `bindings.models.${roleId}`);
		models[roleId] = {
			provider: identifier(model.provider, `bindings.models.${roleId}.provider`),
			id: toolName(model.id, `bindings.models.${roleId}.id`),
		};
	}
	const capabilitiesInput =
		input.capabilities === undefined ? undefined : object(input.capabilities, "bindings.capabilities");
	const capabilities: Record<string, AgentCapabilityGrant[]> = {};
	for (const [roleId, grantsValue] of Object.entries(capabilitiesInput ?? {})) {
		identifier(roleId, "bindings.capabilities role id");
		capabilities[roleId] = array(grantsValue, `bindings.capabilities.${roleId}`).map((entry, index) => {
			const grant = object(entry, `bindings.capabilities.${roleId}[${index}]`);
			return {
				capabilityId: toolName(grant.capabilityId, `bindings.capabilities.${roleId}[${index}].capabilityId`),
				capabilityVersion: integer(
					grant.capabilityVersion,
					`bindings.capabilities.${roleId}[${index}].capabilityVersion`,
					Number.MAX_SAFE_INTEGER,
				),
				providerId:
					grant.providerId === undefined
						? undefined
						: identifier(grant.providerId, `bindings.capabilities.${roleId}[${index}].providerId`),
				approval:
					grant.approval === undefined
						? undefined
						: oneOf(
								grant.approval,
								["never", "per-run", "always"],
								`bindings.capabilities.${roleId}[${index}].approval`,
							),
				connectionId:
					grant.connectionId === undefined
						? undefined
						: string(grant.connectionId, `bindings.capabilities.${roleId}[${index}].connectionId`),
			};
		});
	}
	return {
		projectRoot: string(input.projectRoot, "bindings.projectRoot"),
		models,
		credentialRefs:
			input.credentialRefs === undefined
				? undefined
				: strings(input.credentialRefs, "bindings.credentialRefs").map((entry) =>
						identifier(entry, "bindings.credentialRefs entry"),
					),
		capabilities: capabilitiesInput === undefined ? undefined : capabilities,
	};
}

function parseRole(value: unknown, name: string): PiAgentBundleRole {
	const input = object(value, name);
	const memory = object(input.memory, `${name}.memory`);
	const policies = object(input.policies, `${name}.policies`);
	const modelRequirementInput =
		input.modelRequirement === undefined ? undefined : object(input.modelRequirement, `${name}.modelRequirement`);
	return {
		id: identifier(input.id, `${name}.id`),
		name: string(input.name, `${name}.name`),
		description: string(input.description, `${name}.description`),
		instructions: string(input.instructions, `${name}.instructions`),
		acceptanceCriteria: strings(input.acceptanceCriteria, `${name}.acceptanceCriteria`),
		outputSchema: structuredClone(object(input.outputSchema, `${name}.outputSchema`)),
		tools: array(input.tools, `${name}.tools`).map((entry, index) => {
			const tool = object(entry, `${name}.tools[${index}]`);
			return {
				name: toolName(tool.name, `${name}.tools[${index}].name`),
				credentialRef:
					tool.credentialRef === undefined
						? undefined
						: identifier(tool.credentialRef, `${name}.tools[${index}].credentialRef`),
			};
		}),
		permissionPolicy: oneOf(input.permissionPolicy, ["read-only", "workspace-write"], `${name}.permissionPolicy`),
		memory: {
			readableNamespaces: strings(memory.readableNamespaces, `${name}.memory.readableNamespaces`),
			writableNamespaces: strings(memory.writableNamespaces, `${name}.memory.writableNamespaces`),
			maxInjectionItems:
				memory.maxInjectionItems === undefined
					? undefined
					: integer(memory.maxInjectionItems, `${name}.memory.maxInjectionItems`, 1000),
			sensitivityCeiling:
				memory.sensitivityCeiling === undefined
					? undefined
					: oneOf(
							memory.sensitivityCeiling,
							["public", "internal", "confidential", "restricted"],
							`${name}.memory.sensitivityCeiling`,
						),
		},
		policies: {
			escalationRules: strings(policies.escalationRules, `${name}.policies.escalationRules`),
			stopConditions: strings(policies.stopConditions, `${name}.policies.stopConditions`),
			forbiddenTools: strings(policies.forbiddenTools, `${name}.policies.forbiddenTools`),
			guardrails: strings(policies.guardrails, `${name}.policies.guardrails`),
		},
		modelRequirement:
			modelRequirementInput === undefined
				? undefined
				: {
						tier: string(modelRequirementInput.tier, `${name}.modelRequirement.tier`),
						maxTokens:
							modelRequirementInput.maxTokens === undefined
								? undefined
								: integer(
										modelRequirementInput.maxTokens,
										`${name}.modelRequirement.maxTokens`,
										Number.MAX_SAFE_INTEGER,
									),
						maxCostUsd:
							modelRequirementInput.maxCostUsd === undefined
								? undefined
								: nonNegativeNumber(modelRequirementInput.maxCostUsd, `${name}.modelRequirement.maxCostUsd`),
					},
		delegateRoleIds: strings(input.delegateRoleIds, `${name}.delegateRoleIds`).map((entry) =>
			identifier(entry, `${name}.delegateRoleIds`),
		),
	};
}

function createInstallPlan(value: unknown, bindings: PiAgentBundleBindings): PiAgentBundleInstallPlan {
	const validation = validateBundle(value, bindings);
	if (!validation.valid || !validation.bundle || !validation.bundleDigest) {
		throw new Error(validation.findings.map((finding) => finding.message).join(" ") || "Pi bundle validation failed");
	}
	const bundle = validation.bundle;
	const roleAgentId = (roleId: string) => `${bundle.bundleId}-${roleId}`.slice(0, 64);
	const agentsByRole = new Map<string, AgentDefinitionInput>(
		bundle.roles.map((role): [string, AgentDefinitionInput] => [
			role.id,
			{
				id: roleAgentId(role.id),
				name: role.name,
				description: role.description,
				model: bindings.models[role.id],
				tools: role.tools.map((tool) => tool.name),
				capabilities: bindings.capabilities?.[role.id] ?? [],
				memory:
					role.memory.readableNamespaces.length > 0 || role.memory.writableNamespaces.length > 0
						? "notes"
						: "none",
				persona: [
					role.instructions,
					...(Object.keys(role.outputSchema).length > 0
						? [
								"Return exactly one JSON value matching this canonical output schema. Do not add markdown fences, commentary, or reasoning outside the JSON value.",
								JSON.stringify(role.outputSchema),
							]
						: []),
				].join("\n\n"),
				projectRoot: bindings.projectRoot,
				workspace: bindings.projectRoot,
				executor: "harness",
				permissionPolicy: role.permissionPolicy,
				budget: role.modelRequirement ? budgetFromRequirement(role.modelRequirement) : undefined,
				schedules: [],
				delegateAgentIds: role.delegateRoleIds.map(roleAgentId),
				browserWorkflows: [],
				browser: { access: "disabled", runtime: "managed-chromium", profile: { kind: "ephemeral" } },
				a2a: { enabled: false },
			},
		]),
	);
	const agents = installationRoleOrder(bundle.roles).map((roleId) => agentsByRole.get(roleId)!);
	return {
		bundle,
		bundleDigest: validation.bundleDigest,
		agents,
		workflow: {
			id: bundle.workflow.id,
			name: bundle.workflow.name,
			pattern: bundle.workflow.maxConcurrency === 1 ? "sequential" : "parallel",
			nodes: bundle.workflow.nodes.map((node) => ({
				id: node.id,
				kind: "agent",
				agentId: roleAgentId(node.roleId),
				prompt: node.prompt,
				outputSchema: bundle.roles.find((role) => role.id === node.roleId)!.outputSchema,
				required: node.required,
			})),
			edges: bundle.workflow.edges,
			maxConcurrency: bundle.workflow.maxConcurrency,
			maxDelegationDepth: bundle.workflow.maxDelegationDepth,
			failurePolicy: "stop",
		},
	};
}

function installationRoleOrder(roles: PiAgentBundleRole[]): string[] {
	const byId = new Map(roles.map((role) => [role.id, role]));
	const ordered: string[] = [];
	const visited = new Set<string>();
	const visit = (roleId: string): void => {
		if (visited.has(roleId)) return;
		visited.add(roleId);
		for (const delegate of byId.get(roleId)?.delegateRoleIds ?? []) visit(delegate);
		ordered.push(roleId);
	};
	for (const role of roles) visit(role.id);
	return ordered;
}

function validateBundle(value: unknown, bindings?: PiAgentBundleBindings): PiAgentBundleValidation {
	try {
		const bundle = parsePiAgentBundle(value);
		const parsedBindings = bindings === undefined ? undefined : parsePiAgentBundleBindings(bindings);
		const bundleDigest = digestBundle(bundle);
		const missingBindings = parsedBindings
			? missingLocalBindings(bundle, parsedBindings)
			: localBindingRequirements(bundle);
		if (parsedBindings && parsedBindings.review.bundleDigest !== bundleDigest) {
			missingBindings.push("review:bundle");
		}
		if (parsedBindings && parsedBindings.review.bindingDigest !== digestBindings(parsedBindings)) {
			missingBindings.push("review:bindings");
		}
		return {
			valid: missingBindings.length === 0,
			bundle,
			bundleDigest,
			missingBindings,
			findings:
				missingBindings.length === 0
					? [{ code: "PI_BUNDLE_VALID", message: "Bundle structure and local bindings are valid." }]
					: [{ code: "PI_BINDINGS_REQUIRED", message: "Local bindings must be supplied before installation." }],
		};
	} catch (error) {
		return {
			valid: false,
			missingBindings: [],
			findings: [{ code: "PI_BUNDLE_INVALID", message: error instanceof Error ? error.message : String(error) }],
		};
	}
}

function localBindingRequirements(bundle: PiAgentBundle): string[] {
	return [
		...bundle.roles.flatMap((role) => [
			`model:${role.id}`,
			...role.tools.filter((tool) => tool.credentialRef).map((tool) => `credential:${tool.credentialRef}`),
		]),
		"review:bindings",
	];
}

function missingLocalBindings(bundle: PiAgentBundle, bindings: PiAgentBundleBindings): string[] {
	const missing = bundle.roles.filter((role) => !bindings.models[role.id]).map((role) => `model:${role.id}`);
	const resolvedCredentialRefs = new Set(bindings.credentialRefs ?? []);
	for (const requirement of localBindingRequirements(bundle)) {
		if (
			requirement.startsWith("credential:") &&
			!resolvedCredentialRefs.has(requirement.slice("credential:".length))
		) {
			missing.push(requirement);
		}
	}
	if (!bindings.projectRoot.trim()) missing.push("projectRoot");
	return [...new Set(missing)];
}

async function restoreInstallation(
	registry: AgentRegistry,
	workflows: WorkflowService,
	agents: Map<string, AgentDefinition | undefined>,
	workflow: WorkflowDefinition | undefined,
	workflowId: string,
): Promise<void> {
	if (workflow) await workflows.save(workflow);
	else await workflows.delete(workflowId).catch(() => false);
	for (const [id, definition] of agents) {
		if (definition) await registry.save(definition);
		else await registry.delete(id).catch(() => false);
	}
}

async function readInstallRecord(path: string): Promise<PiAgentBundleInstallRecord | undefined> {
	try {
		const value = object(JSON.parse(await readFile(path, "utf8")), "Pi agent install record");
		if (value.schemaVersion !== "pi.agents.install.v1") return undefined;
		const adapter = object(value.adapter, "Pi agent install record adapter");
		return {
			schemaVersion: "pi.agents.install.v1",
			bundleId: identifier(value.bundleId, "Pi agent install record bundleId"),
			packageId: identifier(value.packageId, "Pi agent install record packageId"),
			effectiveSourceDigest: sha256(value.effectiveSourceDigest, "Pi agent install record effectiveSourceDigest"),
			contractDigest: sha256(value.contractDigest, "Pi agent install record contractDigest"),
			bundleDigest: sha256(value.bundleDigest, "Pi agent install record bundleDigest"),
			executionForm: oneOf(value.executionForm, ["pi-team-v1"], "Pi agent install record executionForm"),
			adapter: {
				id: identifier(adapter.id, "Pi agent install record adapter.id"),
				version: string(adapter.version, "Pi agent install record adapter.version"),
			},
			bindingReview: parseBindingReview(value.bindingReview, "Pi agent install record bindingReview"),
			installedAt: string(value.installedAt, "Pi agent install record installedAt"),
			agentIds: strings(value.agentIds, "Pi agent install record agentIds"),
			workflowId: identifier(value.workflowId, "Pi agent install record workflowId"),
			nodeBudgets: parseNodeBudgets(value.nodeBudgets),
		};
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function budgetFromRequirement(requirement: PiAgentBundleRole["modelRequirement"]): PiAgentBundleBudget {
	return {
		maxTokens: requirement?.maxTokens,
		maxCostUsd: requirement?.maxCostUsd,
	};
}

function budgetStatus(
	budget: PiAgentBundleBudget,
	usage: AgentRunUsage | undefined,
): "passed" | "failed" | "not-declared" {
	if (budget.maxTokens === undefined && budget.maxCostUsd === undefined) return "not-declared";
	if (!usage) return "failed";
	if (budget.maxTokens !== undefined && usage.outputTokens > budget.maxTokens) return "failed";
	if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) return "failed";
	return "passed";
}

function parseNodeBudgets(value: unknown): Record<string, PiAgentBundleBudget> {
	const input = object(value, "Pi agent install record nodeBudgets");
	const budgets: Record<string, PiAgentBundleBudget> = {};
	for (const [nodeId, budgetValue] of Object.entries(input)) {
		identifier(nodeId, "Pi agent install record nodeBudgets node id");
		const budget = object(budgetValue, `Pi agent install record nodeBudgets.${nodeId}`);
		budgets[nodeId] = {
			maxTokens:
				budget.maxTokens === undefined
					? undefined
					: integer(
							budget.maxTokens,
							`Pi agent install record nodeBudgets.${nodeId}.maxTokens`,
							Number.MAX_SAFE_INTEGER,
						),
			maxCostUsd:
				budget.maxCostUsd === undefined
					? undefined
					: nonNegativeNumber(budget.maxCostUsd, `Pi agent install record nodeBudgets.${nodeId}.maxCostUsd`),
		};
	}
	return budgets;
}

function digestBundle(bundle: PiAgentBundle): string {
	return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}

export function digestPiAgentBundleBindings(bindings: Omit<PiAgentBundleBindings, "review">): string {
	return digestBindings({
		...bindings,
		review: placeholderBindingReview(),
	});
}

function placeholderBindingReview(): PiAgentBundleBindingReview {
	return {
		schemaVersion: "pi.agents.binding-review.v1",
		bundleDigest: "0".repeat(64),
		bindingDigest: "0".repeat(64),
		reviewedBy: "digest-placeholder",
		reviewedAt: "1970-01-01T00:00:00.000Z",
	};
}

function digestBindings(bindings: PiAgentBundleBindings): string {
	return createHash("sha256")
		.update(
			stableJson({
				projectRoot: resolve(bindings.projectRoot),
				models: bindings.models,
				credentialRefs: [...(bindings.credentialRefs ?? [])].sort(),
				capabilities: bindings.capabilities ?? {},
			}),
		)
		.digest("hex");
}

function parseBindingReview(value: unknown, name: string): PiAgentBundleBindingReview {
	const review = object(value, name);
	return {
		schemaVersion: oneOf(review.schemaVersion, ["pi.agents.binding-review.v1"], `${name}.schemaVersion`),
		bundleDigest: sha256(review.bundleDigest, `${name}.bundleDigest`),
		bindingDigest: sha256(review.bindingDigest, `${name}.bindingDigest`),
		reviewedBy: string(review.reviewedBy, `${name}.reviewedBy`),
		reviewedAt: timestamp(review.reviewedAt, `${name}.reviewedAt`),
	};
}

function sameBindingReview(left: PiAgentBundleBindingReview, right: PiAgentBundleBindingReview): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.bundleDigest === right.bundleDigest &&
		left.bindingDigest === right.bindingDigest &&
		left.reviewedBy === right.reviewedBy &&
		left.reviewedAt === right.reviewedAt
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function assertAcyclic(nodes: string[], edges: Array<{ from: string; to: string }>): void {
	const incoming = new Map(nodes.map((node) => [node, 0]));
	const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
	for (const edge of edges) {
		incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
		outgoing.get(edge.from)?.push(edge.to);
	}
	const ready = nodes.filter((node) => incoming.get(node) === 0);
	let visited = 0;
	while (ready.length > 0) {
		const node = ready.shift()!;
		visited += 1;
		for (const target of outgoing.get(node) ?? []) {
			const next = (incoming.get(target) ?? 1) - 1;
			incoming.set(target, next);
			if (next === 0) ready.push(target);
		}
	}
	if (visited !== nodes.length) throw new Error("Pi team workflow contains a cycle");
}

function assertUnique(values: string[], name: string): void {
	if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value;
}

function strings(value: unknown, name: string): string[] {
	return array(value, name).map((entry, index) => string(entry, `${name}[${index}]`));
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function boolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function identifier(value: unknown, name: string): string {
	const result = string(value, name);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(result)) throw new Error(`${name} contains unsupported characters`);
	return result;
}

function toolName(value: unknown, name: string): string {
	const result = string(value, name);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(result)) throw new Error(`${name} contains unsupported characters`);
	return result;
}

function sha256(value: unknown, name: string): string {
	const result = string(value, name);
	if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${name} must be a lowercase SHA-256 digest`);
	return result;
}

function integer(value: unknown, name: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
		throw new Error(`${name} is out of range`);
	return Number(value);
}

function nonNegativeNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new Error(`${name} must be non-negative`);
	return value;
}

function timestamp(value: unknown, name: string): string {
	const result = string(value, name);
	if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
	return result;
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T))
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	return value as T;
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
