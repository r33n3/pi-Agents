import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import type { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import { type PiAgentBundle, PiAgentBundleInstaller } from "../src/core/serve/pi-agent-bundle.ts";
import { PiAgentTeamLauncher } from "../src/core/serve/pi-agent-team-launcher.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validates and idempotently installs one complete WTK Pi team bundle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-bundle-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const registry = new AgentRegistry(join(root, "agents"), {
		defaultWorkspace: workspace,
		modelCatalog: () => [
			{ provider: "ollama", id: "qwen3.8:latest", name: "Qwen 3.8" },
			{ provider: "ollama", id: "qwen3.6:latest", name: "Qwen 3.6" },
		],
	});
	await registry.initialize();
	let taskSequence = 0;
	let emitInvalidResearcherOutput = false;
	let fenceResearcherOutput = false;
	let prefixResearcherOutput = false;
	const tasks = new Map<
		string,
		{
			id: string;
			agentId: string;
			status: "completed";
			result: string;
			usage: { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number };
		}
	>();
	const taskService = {
		createConversation: (agentId: string) =>
			Promise.resolve({ id: `conversation-${agentId}-${taskSequence + 1}`, agentId, createdAt: 0, updatedAt: 0 }),
		submit: (input: { agentId: string; prompt: string }) => {
			const task = {
				id: `task-${++taskSequence}`,
				agentId: input.agentId,
				status: "completed" as const,
				result: input.agentId.endsWith("researcher")
					? emitInvalidResearcherOutput
						? "research complete"
						: fenceResearcherOutput
							? `Research complete.\n\n\`\`\`json\n${JSON.stringify({ messages: [{ id: "m-1" }] })}\n\`\`\``
							: prefixResearcherOutput
								? `Research complete.\n${JSON.stringify({ messages: [{ id: "m-1" }] })}`
								: JSON.stringify({ messages: [{ id: "m-1" }] })
					: JSON.stringify({ status: "success", report: "2026-08-28.html" }),
				usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100, costUsd: 0.001 },
			};
			tasks.set(task.id, task);
			return Promise.resolve(task);
		},
		waitForCompletion: (id: string) => Promise.resolve(tasks.get(id)!),
	} as unknown as AgentTaskService;
	const workflows = new WorkflowService(join(root, "workflows"), registry, taskService);
	await workflows.initialize();
	const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	const bundle = fixtureBundle();
	const unreviewedBindings = {
		projectRoot: workspace,
		credentialRefs: ["google-workspace"],
		models: {
			researcher: { provider: "ollama", id: "qwen3.8:latest" },
			writer: { provider: "ollama", id: "qwen3.8:latest" },
		},
		capabilities: {
			researcher: [
				{
					capabilityId: "email.read",
					capabilityVersion: 1,
					providerId: "google-workspace",
					connectionId: "google-workspace-primary",
					approval: "never",
				},
			],
		},
	};
	const { bindings, review } = installer.reviewBindings(bundle, unreviewedBindings, "test-operator");

	assert.equal(installer.validate(bundle).valid, false);
	assert.deepEqual(installer.validate(bundle).missingBindings, [
		"model:researcher",
		"credential:google-workspace",
		"capability:researcher:email.read@1",
		"model:writer",
		"review:bindings",
	]);
	assert.equal(review.reviewedBy, "test-operator");
	assert.deepEqual(installer.validate(bundle, { ...bindings, credentialRefs: [] }).missingBindings, [
		"credential:google-workspace",
		"review:bindings",
	]);
	assert.equal(installer.validate(bundle, bindings).valid, true);

	const first = await installer.install(bundle, bindings);
	const second = await installer.install(bundle, bindings);
	assert.equal(first.disposition, "created");
	assert.equal(second.disposition, "reused");
	assert.deepEqual(second.receipt, first.receipt);
	assert.deepEqual(first.receipt.agentIds, ["daily-mail-team-writer", "daily-mail-team-researcher"]);
	assert.match(first.receipt.bindingDigest, /^[0-9a-f]{64}$/);
	assert.match(first.receipt.authorityDigest, /^[0-9a-f]{64}$/);
	assert.match(first.receipt.effectiveDeploymentDigest, /^[0-9a-f]{64}$/);
	assert.equal((await registry.get("daily-mail-team-researcher"))?.revision, 1);
	assert.equal(workflows.getDefinition("daily-mail-workflow")?.nodes.length, 2);
	assert.equal(workflows.getDefinition("daily-mail-workflow")?.pattern, "parallel");
	assert.equal(workflows.getDefinition("daily-mail-workflow")?.supervisorAgentId, undefined);
	const rebound = installer.reviewBindings(
		bundle,
		{
			...unreviewedBindings,
			models: {
				researcher: { provider: "ollama", id: "qwen3.6:latest" },
				writer: { provider: "ollama", id: "qwen3.6:latest" },
			},
		},
		"test-operator",
	).bindings;
	const reboundRecord = await installer.install(bundle, rebound);
	assert.equal(reboundRecord.disposition, "updated");
	assert.equal(reboundRecord.receipt.bindingReview.bindingDigest, rebound.review.bindingDigest);
	assert.equal((await registry.get("daily-mail-team-researcher"))?.model?.id, "qwen3.6:latest");
	assert.equal((await registry.get("daily-mail-team-researcher"))?.revision, 2);
	const evidence = await installer.smoke("daily-mail-team", "Review yesterday's mail");
	assert.equal(evidence.executionStatus, "completed");
	assert.equal(evidence.contractDigest, "b".repeat(64));
	assert.deepEqual(evidence.bindingReview, rebound.review);
	assert.deepEqual(
		evidence.nodes.map((node) => node.budget),
		[
			{ maxTokens: 200, maxCostUsd: 0.01, observedOutputTokens: 20, observedCostUsd: 0.001, status: "passed" },
			{ maxTokens: 400, maxCostUsd: 0.02, observedOutputTokens: 20, observedCostUsd: 0.001, status: "passed" },
		],
	);
	assert.deepEqual(
		evidence.nodes.map((node) => ({ id: node.nodeId, predecessors: node.predecessorNodeIds })),
		[
			{ id: "read-mail", predecessors: [] },
			{ id: "write-report", predecessors: ["read-mail"] },
		],
	);
	assert.deepEqual(
		evidence.nodes.map((node) => node.outputContract),
		[
			{ status: "passed", findings: [] },
			{ status: "passed", findings: [] },
		],
	);
	fenceResearcherOutput = true;
	const normalized = await installer.smoke("daily-mail-team", "Review yesterday's mail with fencing");
	assert.equal(normalized.executionStatus, "completed");
	assert.deepEqual(normalized.nodes[0]!.outputContract, {
		status: "passed",
		findings: ["PI_OUTPUT_JSON_FENCE_NORMALIZED"],
	});
	fenceResearcherOutput = false;
	prefixResearcherOutput = true;
	const trailing = await installer.smoke("daily-mail-team", "Review yesterday's mail with a preamble");
	assert.equal(trailing.executionStatus, "completed");
	assert.deepEqual(trailing.nodes[0]!.outputContract, {
		status: "passed",
		findings: ["PI_OUTPUT_TRAILING_JSON_NORMALIZED"],
	});
	prefixResearcherOutput = false;
	emitInvalidResearcherOutput = true;
	const rejected = await installer.smoke("daily-mail-team", "Review yesterday's mail again");
	assert.equal(rejected.executionStatus, "failed");
	assert.deepEqual(
		rejected.nodes.map((node) => ({ status: node.status, output: node.outputContract.status })),
		[{ status: "failed", output: "failed" }],
	);
});

test("fails closed before writing agents when bundle authority is widened", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-bundle-invalid-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const registry = new AgentRegistry(join(root, "agents"), { defaultWorkspace: workspace });
	await registry.initialize();
	const workflows = new WorkflowService(join(root, "workflows"), registry, {} as AgentTaskService);
	await workflows.initialize();
	const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	const bundle = fixtureBundle();
	const bindings = installer.reviewBindings(
		bundle,
		{
			projectRoot: workspace,
			credentialRefs: ["google-workspace"],
			models: {
				researcher: { provider: "ollama", id: "qwen3.8:latest" },
				writer: { provider: "ollama", id: "qwen3.8:latest" },
			},
			capabilities: {
				researcher: [
					{
						capabilityId: "email.read",
						capabilityVersion: 1,
						providerId: "google-workspace",
						connectionId: "google-workspace-primary",
						approval: "never",
					},
				],
			},
		},
		"test-operator",
	).bindings;
	bundle.roles[0]!.tools.push({ name: "write", version: 1, effect: "write" });

	const result = installer.validate(bundle, bindings);
	assert.equal(result.valid, false);
	assert.match(result.findings[0]!.message, /Read-only role researcher/);
	assert.deepEqual(await registry.list(), []);
});

test("recovers an interrupted prepared install before accepting retries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-bundle-recovery-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const registry = new AgentRegistry(join(root, "agents"), { defaultWorkspace: workspace });
	await registry.initialize();
	const workflows = new WorkflowService(join(root, "workflows"), registry, {} as AgentTaskService);
	await workflows.initialize();
	const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	const bundle = fixtureBundle();
	const bindings = installer.reviewBindings(
		bundle,
		{
			projectRoot: workspace,
			credentialRefs: ["google-workspace"],
			models: {
				researcher: { provider: "ollama", id: "qwen3.8:latest" },
				writer: { provider: "ollama", id: "qwen3.8:latest" },
			},
			capabilities: {
				researcher: [
					{
						capabilityId: "email.read",
						capabilityVersion: 1,
						providerId: "google-workspace",
						connectionId: "google-workspace-primary",
						approval: "never",
					},
				],
			},
		},
		"test-operator",
	).bindings;
	const saveWorkflow = workflows.save.bind(workflows);
	let interrupted = true;
	workflows.save = async (input) => {
		if (interrupted) {
			interrupted = false;
			throw new Error("simulated process interruption");
		}
		return saveWorkflow(input);
	};
	await assert.rejects(installer.install(bundle, bindings), /simulated process interruption/);
	const transactionPath = join(root, "installs", "transactions", "daily-mail-team.json");
	const prepared = await readFile(transactionPath, "utf8");
	assert.match(prepared, /pi\.agents\.install-transaction\.v1/);
	assert.doesNotMatch(prepared, /accessToken|clientSecret|apiKey/);

	workflows.save = saveWorkflow;
	const restarted = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	await restarted.initialize();
	const retried = await restarted.install(bundle, bindings);
	assert.equal(retried.disposition, "reused");
	assert.equal(workflows.getDefinition("daily-mail-workflow")?.nodes.length, 2);
	assert.deepEqual((await registry.list()).map((agent) => agent.id).sort(), [
		"daily-mail-team-researcher",
		"daily-mail-team-writer",
	]);
	await assert.rejects(readFile(transactionPath, "utf8"), /ENOENT/);
});

test("replaces an incomplete early v1 install record with a complete reviewed receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-bundle-legacy-record-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const registry = new AgentRegistry(join(root, "agents"), {
		defaultWorkspace: workspace,
		modelCatalog: () => [{ provider: "ollama", id: "qwen3.8:latest", name: "Qwen 3.8" }],
	});
	await registry.initialize();
	const workflows = new WorkflowService(join(root, "workflows"), registry, {} as AgentTaskService);
	await workflows.initialize();
	const installs = join(root, "installs");
	await mkdir(installs, { recursive: true });
	await writeFile(
		join(installs, "daily-mail-team.json"),
		JSON.stringify({
			schemaVersion: "pi.agents.install.v1",
			bundleId: "daily-mail-team",
			packageId: "daily-mail",
			effectiveSourceDigest: "a".repeat(64),
			contractDigest: "b".repeat(64),
			bundleDigest: "c".repeat(64),
			executionForm: "pi-team-v1",
			adapter: { id: "wtk-pi-agents", version: "1.0.0" },
			bindingReview: {
				schemaVersion: "pi.agents.binding-review.v1",
				bundleDigest: "c".repeat(64),
				bindingDigest: "d".repeat(64),
				reviewedBy: "previous-operator",
				reviewedAt: "2026-08-29T00:00:00.000Z",
			},
			installedAt: "2026-08-29T00:00:00.000Z",
			agentIds: [],
			workflowId: "daily-mail-workflow",
			nodeBudgets: {},
		}),
		"utf8",
	);
	const installer = new PiAgentBundleInstaller(installs, registry, workflows);
	const bundle = fixtureBundle();
	const bindings = installer.reviewBindings(
		bundle,
		{
			projectRoot: workspace,
			credentialRefs: ["google-workspace"],
			models: {
				researcher: { provider: "ollama", id: "qwen3.8:latest" },
				writer: { provider: "ollama", id: "qwen3.8:latest" },
			},
			capabilities: {
				researcher: [
					{
						capabilityId: "email.read",
						capabilityVersion: 1,
						providerId: "google-workspace",
						connectionId: "google-workspace-primary",
						approval: "never",
					},
				],
			},
		},
		"test-operator",
	).bindings;

	const installed = await installer.install(bundle, bindings);
	assert.equal(installed.disposition, "created");
	assert.match(installed.receipt.bindingDigest, /^[0-9a-f]{64}$/);
	assert.match(installed.receipt.authorityDigest, /^[0-9a-f]{64}$/);
	assert.match(installed.receipt.effectiveDeploymentDigest, /^[0-9a-f]{64}$/);
});

test("prepares and idempotently launches a reviewed team into its coordinator conversation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-team-launcher-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	const registry = new AgentRegistry(join(root, "agents"), {
		defaultWorkspace: workspace,
		modelCatalog: () => [{ provider: "ollama", id: "qwen3.8:latest", name: "Qwen 3.8" }],
	});
	await registry.initialize();
	const conversations = new Map<string, string>();
	const teamTasks = new Map<string, { id: string; agentId: string; status: "completed"; result: string }>();
	let taskCompletionGate: Promise<void> | undefined;
	const taskService = {
		ensureConversation: (agentId: string) => {
			const id = conversations.get(agentId) ?? `conversation-${agentId}`;
			conversations.set(agentId, id);
			return Promise.resolve({ id, agentId, createdAt: 0, updatedAt: 0 });
		},
		createConversation: (agentId: string) =>
			Promise.resolve({ id: `workflow-${agentId}-${teamTasks.size}`, agentId, createdAt: 0, updatedAt: 0 }),
		submit: (input: { agentId: string }) => {
			const task = {
				id: `team-task-${teamTasks.size + 1}`,
				agentId: input.agentId,
				status: "completed" as const,
				result: input.agentId.endsWith("researcher")
					? JSON.stringify({ messages: [] })
					: JSON.stringify({ status: "success", report: "report.html" }),
			};
			teamTasks.set(task.id, task);
			return Promise.resolve(task);
		},
		waitForCompletion: async (taskId: string) => {
			await taskCompletionGate;
			return teamTasks.get(taskId)!;
		},
		listTasks: () => [...teamTasks.values()],
	} as unknown as AgentTaskService;
	const workflows = new WorkflowService(join(root, "workflows"), registry, taskService);
	await workflows.initialize();
	const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	const connections = new CapabilityConnectionRegistry(join(root, "connections"));
	await connections.initialize();
	await connections.save({
		id: "google-workspace-primary",
		providerId: "google-workspace",
		accountLabel: "Personal",
		secretRef: "managed:google/personal",
		scopes: ["mail.read"],
		capabilityIds: ["email.read"],
	});
	const launcher = new PiAgentTeamLauncher(installer, taskService, workflows, connections);
	const bundle = fixtureBundle();
	const bindings = {
		projectRoot: workspace,
		credentialRefs: ["google-workspace"],
		models: {
			researcher: { provider: "ollama", id: "qwen3.8:latest" },
			writer: { provider: "ollama", id: "qwen3.8:latest" },
		},
		capabilities: {
			researcher: [
				{
					capabilityId: "email.read",
					capabilityVersion: 1,
					providerId: "google-workspace",
					connectionId: "google-workspace-primary",
					approval: "never" as const,
				},
			],
		},
	};

	const prepared = launcher.prepare(bundle, bindings);
	const defaults = launcher.prepareWithLocalDefaults(bundle, workspace, {
		provider: "ollama",
		id: "qwen3.8:latest",
	});
	assert.deepEqual(defaults.bindings, bindings);
	assert.equal(defaults.preview.approvalDigest, prepared.approvalDigest);
	assert.match(prepared.approvalDigest, /^[0-9a-f]{64}$/);
	assert.equal(prepared.team.coordinatorRoleId, "researcher");
	assert.deepEqual(
		prepared.team.roles.map((role) => ({ id: role.id, model: role.model.id, grants: role.capabilityGrantCount })),
		[
			{ id: "researcher", model: "qwen3.8:latest", grants: 1 },
			{ id: "writer", model: "qwen3.8:latest", grants: 0 },
		],
	);
	assert.doesNotMatch(JSON.stringify(prepared), /accessToken|clientSecret|apiKey/);

	const first = await launcher.launch(bundle, bindings, prepared.approvalDigest, "test-operator");
	const second = await launcher.launch(bundle, bindings, prepared.approvalDigest, "test-operator");
	assert.equal(first.disposition, "created");
	assert.equal(second.disposition, "reused");
	assert.equal(first.target.coordinatorAgentId, "daily-mail-team-researcher");
	assert.equal(second.target.conversationId, first.target.conversationId);
	assert.equal(conversations.size, 1);
	assert.equal(launcher.state(first.target.coordinatorAgentId).team?.runs.length, 0);
	const workspaceA = join(root, "workspace-a");
	const workspaceB = join(root, "workspace-b");
	await Promise.all([mkdir(workspaceA), mkdir(workspaceB)]);
	const candidateA = { ...bindings, projectRoot: workspaceA };
	const candidateB = { ...bindings, projectRoot: workspaceB };
	const preparedA = launcher.prepare(bundle, candidateA);
	const preparedB = launcher.prepare(bundle, candidateB);
	const concurrentUpdates = await Promise.allSettled([
		launcher.launch(bundle, candidateA, preparedA.approvalDigest, "test-operator"),
		launcher.launch(bundle, candidateB, preparedB.approvalDigest, "test-operator"),
	]);
	assert.equal(concurrentUpdates[0]?.status, "fulfilled");
	assert.equal(concurrentUpdates[1]?.status, "rejected");
	if (concurrentUpdates[1]?.status === "rejected") {
		assert.match(String(concurrentUpdates[1].reason), /installed baseline changed after review/);
	}
	let releaseTaskCompletion: (() => void) | undefined;
	taskCompletionGate = new Promise((resolve) => {
		releaseTaskCompletion = resolve;
	});
	const active = await launcher.run(first.target.coordinatorAgentId, "Hold this review open");
	const activeRunId = active.team?.runs[0]?.id;
	assert.ok(activeRunId);
	const activeRebind = { ...bindings, projectRoot: workspaceB };
	const activeRebindReview = launcher.prepare(bundle, activeRebind);
	await assert.rejects(
		launcher.launch(bundle, activeRebind, activeRebindReview.approvalDigest, "test-operator"),
		/Stop the active team run/,
	);
	releaseTaskCompletion?.();
	await workflows.waitForCompletion(activeRunId);
	taskCompletionGate = undefined;
	const started = await launcher.run(first.target.coordinatorAgentId, "Review yesterday's mail");
	const runId = started.team?.runs[0]?.id;
	assert.ok(runId);
	await workflows.waitForCompletion(runId);
	const completed = launcher.state(first.target.coordinatorAgentId);
	assert.equal(completed.team?.runs[0]?.status, "completed");
	assert.deepEqual(
		completed.team?.runs[0]?.nodes.map((node) => node.status),
		["completed", "completed"],
	);
	const restartedInstaller = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
	await restartedInstaller.initialize();
	const restartedLauncher = new PiAgentTeamLauncher(restartedInstaller, taskService, workflows);
	assert.equal(restartedLauncher.state(first.target.coordinatorAgentId).team?.runs[0]?.status, "completed");

	await assert.rejects(
		launcher.launch(
			bundle,
			{ ...bindings, projectRoot: join(root, "other-workspace") },
			prepared.approvalDigest,
			"test-operator",
		),
		/changed after review/,
	);
});

function fixtureBundle(): PiAgentBundle {
	return {
		schemaVersion: "pi.agents.bundle.v1" as const,
		bundleId: "daily-mail-team",
		packageId: "daily-mail",
		effectiveSourceDigest: "a".repeat(64),
		contractDigest: "b".repeat(64),
		executionForm: "pi-team-v1" as const,
		roles: [
			{
				id: "researcher",
				name: "Mail Researcher",
				description: "Reads the previous calendar day of mail.",
				instructions: "Read and categorize the previous calendar day of Gmail messages.",
				acceptanceCriteria: ["All matching messages are accounted for."],
				outputSchema: {
					type: "object",
					required: ["messages"],
					properties: { messages: { type: "array" } },
				},
				tools: [
					{
						name: "google_workspace_email_search",
						version: 1,
						effect: "read",
						credentialRef: "google-workspace",
						capability: {
							id: "email.read",
							version: 1,
							providerId: "google-workspace",
							approvalFloor: "never",
							credentialSlot: "google-workspace",
						},
					},
				],
				permissionPolicy: "read-only" as const,
				memory: { readableNamespaces: ["mail"], writableNamespaces: [] },
				policies: { escalationRules: [], stopConditions: [], forbiddenTools: ["write"], guardrails: [] },
				modelRequirement: { tier: "L1", maxTokens: 200, maxCostUsd: 0.01 },
				delegateRoleIds: ["writer"],
			},
			{
				id: "writer",
				name: "Mail Writer",
				description: "Produces the daily report.",
				instructions: "Create the styled report from the research result.",
				acceptanceCriteria: ["Report has a dated index entry."],
				outputSchema: {
					type: "object",
					required: ["status", "report"],
					properties: { status: { const: "success" }, report: { type: "string" } },
				},
				tools: [],
				permissionPolicy: "workspace-write" as const,
				memory: { readableNamespaces: ["mail"], writableNamespaces: ["mail"] },
				policies: { escalationRules: [], stopConditions: [], forbiddenTools: [], guardrails: [] },
				modelRequirement: { tier: "L2", maxTokens: 400, maxCostUsd: 0.02 },
				delegateRoleIds: [],
			},
		],
		workflow: {
			id: "daily-mail-workflow",
			name: "Daily mail workflow",
			coordinatorRoleId: "researcher",
			nodes: [
				{ id: "read-mail", roleId: "researcher", prompt: "Read mail.", required: true },
				{ id: "write-report", roleId: "writer", prompt: "Write report.", required: true },
			],
			edges: [{ from: "read-mail", to: "write-report" }],
			maxConcurrency: 2,
			maxDelegationDepth: 2,
			failurePolicy: "stop" as const,
		},
		assurance: { adapterId: "wtk-pi-agents", adapterVersion: "1.0.0" },
	};
}
