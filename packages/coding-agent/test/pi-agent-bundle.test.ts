import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import type { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { type PiAgentBundle, PiAgentBundleInstaller } from "../src/core/serve/pi-agent-bundle.ts";
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
	};
	const { bindings, review } = installer.reviewBindings(bundle, unreviewedBindings, "test-operator");

	assert.equal(installer.validate(bundle).valid, false);
	assert.deepEqual(installer.validate(bundle).missingBindings, [
		"model:researcher",
		"credential:google-workspace",
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
	assert.deepEqual(second, first);
	assert.deepEqual(first.agentIds, ["daily-mail-team-writer", "daily-mail-team-researcher"]);
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
	assert.equal(reboundRecord.bindingReview.bindingDigest, rebound.review.bindingDigest);
	assert.equal((await registry.get("daily-mail-team-researcher"))?.model?.id, "qwen3.6:latest");
	assert.equal((await registry.get("daily-mail-team-researcher"))?.revision, 2);
	const evidence = await installer.smoke("daily-mail-team", "Review yesterday's mail");
	assert.equal(evidence.verdict, "goal-accomplished");
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
	assert.equal(normalized.verdict, "goal-accomplished");
	assert.deepEqual(normalized.nodes[0]!.outputContract, {
		status: "passed",
		findings: ["PI_OUTPUT_JSON_FENCE_NORMALIZED"],
	});
	fenceResearcherOutput = false;
	prefixResearcherOutput = true;
	const trailing = await installer.smoke("daily-mail-team", "Review yesterday's mail with a preamble");
	assert.equal(trailing.verdict, "goal-accomplished");
	assert.deepEqual(trailing.nodes[0]!.outputContract, {
		status: "passed",
		findings: ["PI_OUTPUT_TRAILING_JSON_NORMALIZED"],
	});
	prefixResearcherOutput = false;
	emitInvalidResearcherOutput = true;
	const rejected = await installer.smoke("daily-mail-team", "Review yesterday's mail again");
	assert.equal(rejected.verdict, "goal-not-accomplished");
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
		},
		"test-operator",
	).bindings;
	bundle.roles[0]!.tools.push({ name: "write" });

	const result = installer.validate(bundle, bindings);
	assert.equal(result.valid, false);
	assert.match(result.findings[0]!.message, /Read-only role researcher/);
	assert.deepEqual(await registry.list(), []);
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
				tools: [{ name: "google_workspace_email_search", credentialRef: "google-workspace" }],
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
