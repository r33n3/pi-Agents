import { createHash } from "node:crypto";
import type { ModelRef } from "@earendil-works/pi-protocol";
import type { AgentTaskService } from "./agent-task-service.ts";
import type { CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import {
	type PiAgentBundle,
	type PiAgentBundleInstaller,
	type PiAgentBundleInstallRecord,
	type PiAgentBundleUnreviewedBindings,
	parsePiAgentBundle,
	piAgentBundleRoleAgentId,
} from "./pi-agent-bundle.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";
import type { WorkflowService } from "./workflow-service.ts";

export interface PiAgentTeamPreview {
	schemaVersion: "pi.agents.team-preview.v1";
	approvalDigest: string;
	team: {
		bundleId: string;
		packageId: string;
		name: string;
		coordinatorRoleId: string;
		roles: Array<{
			id: string;
			name: string;
			description: string;
			model: { provider: string; id: string };
			permissionPolicy: "read-only" | "workspace-write";
			toolNames: string[];
			capabilityGrantCount: number;
		}>;
		workflow: {
			id: string;
			nodeCount: number;
			maxConcurrency: number;
			maxDelegationDepth: number;
		};
	};
	bindings: {
		projectRoot: string;
		credentialRefs: string[];
	};
}

export interface PiAgentTeamLaunchResult {
	schemaVersion: "pi.agents.team-launch-result.v1";
	disposition: "created" | "reused" | "updated";
	receipt: PiAgentBundleInstallRecord;
	target: {
		coordinatorAgentId: string;
		conversationId: string;
		agentIds: string[];
		workflowId: string;
	};
}

export interface PiAgentTeamState {
	schemaVersion: "pi.agents.team-state.v1";
	installed: boolean;
	team?: {
		bundleId: string;
		packageId: string;
		coordinatorAgentId: string;
		agentIds: string[];
		workflow: { id: string; name: string };
		runs: Array<{
			id: string;
			status: "running" | "completed" | "failed" | "cancelled";
			prompt: string;
			createdAt: number;
			finishedAt?: number;
			result?: string;
			error?: string;
			nodes: Array<{
				id: string;
				label: string;
				status: "queued" | "running" | "completed" | "failed" | "blocked";
				progress?: string;
				result?: string;
				error?: string;
			}>;
		}>;
	};
}

/** Owns the reviewed bundle-to-conversation transition for the common team launch path. */
export class PiAgentTeamLauncher {
	readonly #installer: PiAgentBundleInstaller;
	readonly #tasks: AgentTaskService;
	readonly #workflows: WorkflowService;
	readonly #connections: CapabilityConnectionRegistry | undefined;
	readonly #launches = new SerialOperationQueue();

	constructor(
		installer: PiAgentBundleInstaller,
		tasks: AgentTaskService,
		workflows: WorkflowService,
		connections?: CapabilityConnectionRegistry,
	) {
		this.#installer = installer;
		this.#tasks = tasks;
		this.#workflows = workflows;
		this.#connections = connections;
	}

	prepareWithLocalDefaults(
		bundleValue: unknown,
		projectRoot: string,
		model: ModelRef,
	): { bundle: PiAgentBundle; bindings: PiAgentBundleUnreviewedBindings; preview: PiAgentTeamPreview } {
		const bundle = parsePiAgentBundle(bundleValue);
		const connections = this.#connections?.snapshot().filter((connection) => connection.status === "active") ?? [];
		const credentialRefs = new Set<string>();
		const capabilities: NonNullable<PiAgentBundleUnreviewedBindings["capabilities"]> = {};
		for (const role of bundle.roles) {
			const grants = new Map<string, NonNullable<PiAgentBundleUnreviewedBindings["capabilities"]>[string][number]>();
			for (const tool of role.tools) {
				if (tool.credentialRef) credentialRefs.add(tool.credentialRef);
				const requirement = tool.capability;
				if (!requirement) continue;
				if (requirement.credentialSlot) credentialRefs.add(requirement.credentialSlot);
				const providerId = requirement.providerId;
				const connection = connections.find(
					(candidate) =>
						(providerId === undefined || candidate.providerId === providerId) &&
						candidate.capabilityIds.includes(requirement.id),
				);
				if (!connection) {
					throw new Error(
						`Connect an active ${providerId ?? requirement.id} account that grants ${requirement.id} before launching this team`,
					);
				}
				grants.set(`${requirement.id}@${requirement.version}`, {
					capabilityId: requirement.id,
					capabilityVersion: requirement.version,
					providerId: connection.providerId,
					connectionId: connection.id,
					approval: requirement.approvalFloor,
				});
			}
			if (grants.size > 0) capabilities[role.id] = [...grants.values()];
		}
		const bindings: PiAgentBundleUnreviewedBindings = {
			projectRoot: projectRoot.trim(),
			models: Object.fromEntries(bundle.roles.map((role) => [role.id, { ...model }])),
			...(credentialRefs.size > 0 ? { credentialRefs: [...credentialRefs].sort() } : {}),
			...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
		};
		return { bundle, bindings, preview: this.prepare(bundle, bindings) };
	}

	prepare(bundleValue: unknown, bindingsValue: unknown): PiAgentTeamPreview {
		const bundle = parsePiAgentBundle(bundleValue);
		const { bindings, review } = this.#installer.reviewBindings(bundle, bindingsValue, "pending-review");
		const validation = this.#installer.validate(bundle, bindings);
		if (!validation.valid) {
			throw new Error(validation.findings.map((finding) => finding.message).join(" ") || "Team is not ready");
		}
		const coordinatorAgentId = piAgentBundleRoleAgentId(bundle.bundleId, bundle.workflow.coordinatorRoleId);
		const installed = this.#installer.installedTeamForCoordinator(coordinatorAgentId);
		return preview(
			bundle,
			bindings,
			approvalDigest(review.bundleDigest, review.bindingDigest, installed?.effectiveDeploymentDigest),
		);
	}

	async launch(
		bundleValue: unknown,
		bindingsValue: unknown,
		expectedApprovalDigest: string,
		reviewedBy: string,
	): Promise<PiAgentTeamLaunchResult> {
		return this.#launches.run(async () => {
			const prepared = this.prepare(bundleValue, bindingsValue);
			const bundle = parsePiAgentBundle(bundleValue);
			const coordinatorAgentId = piAgentBundleRoleAgentId(bundle.bundleId, bundle.workflow.coordinatorRoleId);
			const current = this.#installer.installedTeamForCoordinator(coordinatorAgentId);
			const reviewed = this.#installer.reviewBindings(bundle, bindingsValue, reviewedBy);
			const exactRetry =
				current?.bundleDigest === reviewed.review.bundleDigest &&
				current.bindingDigest === reviewed.review.bindingDigest;
			if (prepared.approvalDigest !== expectedApprovalDigest && !exactRetry) {
				throw new Error("Team package, local bindings, or installed baseline changed after review");
			}
			if (
				current &&
				!exactRetry &&
				this.#workflows.listRuns(current.workflowId).some((run) => run.status === "running")
			) {
				throw new Error("Stop the active team run before changing its installed package or bindings");
			}
			const installed = await this.#installer.install(bundle, reviewed.bindings);
			const conversation = await this.#tasks.ensureConversation(coordinatorAgentId);
			return {
				schemaVersion: "pi.agents.team-launch-result.v1",
				disposition: installed.disposition,
				receipt: installed.receipt,
				target: {
					coordinatorAgentId,
					conversationId: conversation.id,
					agentIds: [...installed.receipt.agentIds],
					workflowId: installed.receipt.workflowId,
				},
			};
		});
	}

	state(coordinatorAgentId: string): PiAgentTeamState {
		const receipt = this.#installer.installedTeamForCoordinator(coordinatorAgentId);
		if (!receipt) return { schemaVersion: "pi.agents.team-state.v1", installed: false };
		const workflow = this.#workflows.getDefinition(receipt.workflowId);
		if (!workflow) throw new Error(`Installed team workflow ${receipt.workflowId} was not found`);
		return {
			schemaVersion: "pi.agents.team-state.v1",
			installed: true,
			team: {
				bundleId: receipt.bundleId,
				packageId: receipt.packageId,
				coordinatorAgentId: receipt.coordinatorAgentId,
				agentIds: [...receipt.agentIds],
				workflow: { id: workflow.id, name: workflow.name },
				runs: this.#workflows
					.listRuns(workflow.id)
					.slice(0, 5)
					.map((run) => {
						const tasks = this.#tasks.listTasks({ workflowRunId: run.id });
						const taskById = new Map(tasks.map((task) => [task.id, task]));
						const completedNodes = new Set(run.nodeResults.map((node) => node.nodeId));
						return {
							id: run.id,
							status: run.status,
							prompt: run.prompt,
							createdAt: run.createdAt,
							finishedAt: run.finishedAt,
							result: run.result,
							error: run.error,
							nodes: workflow.nodes.map((node) => {
								const result = run.nodeResults.find((candidate) => candidate.nodeId === node.id);
								const task = result?.agentTaskId
									? taskById.get(result.agentTaskId)
									: tasks.find(
											(candidate) =>
												candidate.agentId === (node.kind === "browser-workflow" ? "" : node.agentId),
										);
								return {
									id: node.id,
									label: result?.label ?? (node.kind === "browser-workflow" ? node.workflowId : node.agentId),
									status:
										result?.status ??
										(task ? taskStatus(task.status) : completedNodes.has(node.id) ? "completed" : "queued"),
									progress: task?.progressMessage,
									result: result?.result,
									error: result?.error ?? task?.error,
								};
							}),
						};
					}),
			},
		};
	}

	async run(coordinatorAgentId: string, prompt: string): Promise<PiAgentTeamState> {
		const state = this.state(coordinatorAgentId);
		if (!state.installed || !state.team) throw new Error("The selected agent is not an installed team coordinator");
		if (state.team.runs.some((run) => run.status === "running"))
			throw new Error("This team already has a running task");
		await this.#workflows.start(state.team.workflow.id, prompt);
		return this.state(coordinatorAgentId);
	}

	async cancel(coordinatorAgentId: string, runId: string): Promise<PiAgentTeamState> {
		const state = this.state(coordinatorAgentId);
		if (!state.installed || !state.team) throw new Error("The selected agent is not an installed team coordinator");
		const run = state.team.runs.find((candidate) => candidate.id === runId);
		if (!run) throw new Error("The team run was not found");
		await this.#workflows.cancel(run.id);
		return this.state(coordinatorAgentId);
	}
}

function taskStatus(status: string): "queued" | "running" | "completed" | "failed" {
	if (status === "completed") return "completed";
	if (status === "failed" || status === "cancelled") return "failed";
	if (status === "queued") return "queued";
	return "running";
}

function preview(bundle: PiAgentBundle, bindings: PiAgentBundleUnreviewedBindings, digest: string): PiAgentTeamPreview {
	return {
		schemaVersion: "pi.agents.team-preview.v1",
		approvalDigest: digest,
		team: {
			bundleId: bundle.bundleId,
			packageId: bundle.packageId,
			name: bundle.workflow.name,
			coordinatorRoleId: bundle.workflow.coordinatorRoleId,
			roles: bundle.roles.map((role) => ({
				id: role.id,
				name: role.name,
				description: role.description,
				model: { ...bindings.models[role.id]! },
				permissionPolicy: role.permissionPolicy,
				toolNames: role.tools.map((tool) => tool.name),
				capabilityGrantCount: bindings.capabilities?.[role.id]?.length ?? 0,
			})),
			workflow: {
				id: bundle.workflow.id,
				nodeCount: bundle.workflow.nodes.length,
				maxConcurrency: bundle.workflow.maxConcurrency,
				maxDelegationDepth: bundle.workflow.maxDelegationDepth,
			},
		},
		bindings: {
			projectRoot: bindings.projectRoot,
			credentialRefs: [...(bindings.credentialRefs ?? [])].sort(),
		},
	};
}

function approvalDigest(bundleDigest: string, bindingDigest: string, installedDeploymentDigest?: string): string {
	return createHash("sha256")
		.update(`${bundleDigest}:${bindingDigest}:${installedDeploymentDigest ?? "uninstalled"}`)
		.digest("hex");
}
