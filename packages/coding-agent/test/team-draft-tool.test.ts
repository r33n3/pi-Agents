import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import type { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { PiAgentBundleInstaller } from "../src/core/serve/pi-agent-bundle.ts";
import { PiAgentTeamLauncher } from "../src/core/serve/pi-agent-team-launcher.ts";
import { createTeamDraftTool } from "../src/core/serve/team-draft-tool.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("prepares an ordered team without deploying, then uses the existing reviewed launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-draft-"));
	const provider = registerFauxProvider();
	try {
		const model = provider.getModel();
		const registry = new AgentRegistry(join(root, "agents"), { defaultWorkspace: root, modelCatalog: () => [model] });
		await registry.initialize();
		const tasks = { ensureConversation: async () => ({ id: "test-inbox" }) } as unknown as AgentTaskService;
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
		const launcher = new PiAgentTeamLauncher(installer, tasks, workflows);
		const tool = createTeamDraftTool(launcher);
		const result = await tool.execute(
			"draft",
			{
				name: "Review team",
				steps: [
					{ name: "Reader", instructions: "Read the input", tools: ["read"] },
					{ name: "Checker", instructions: "Check the previous result", tools: ["read"] },
					{ name: "Coordinator", instructions: "Summarize the checked result" },
				],
			},
			undefined,
			undefined,
			{ cwd: root, model } as ExtensionContext,
		);
		const details = result.details as { teamDraft: ReturnType<PiAgentTeamLauncher["prepareWithLocalDefaults"]> };
		const draft = details.teamDraft;
		expect(await registry.list()).toEqual([]);
		expect(draft.preview.team.roles.map((role) => role.name)).toEqual(["Reader", "Checker", "Coordinator"]);
		expect(draft.bundle.workflow.edges).toEqual([
			{ from: "step-1", to: "step-2" },
			{ from: "step-2", to: "step-3" },
		]);
		const launched = await launcher.launch(
			draft.bundle,
			draft.bindings,
			draft.preview.approvalDigest,
			"test-operator",
		);
		expect(launched.target.agentIds).toHaveLength(3);
		expect(launched.target.coordinatorAgentId).toContain("step-3");
		expect(
			(await registry.list()).every(
				(agent) => agent.permissionPolicy === "read-only" && agent.schedules.length === 0,
			),
		).toBe(true);
		const retry = await launcher.launch(draft.bundle, draft.bindings, draft.preview.approvalDigest, "test-operator");
		expect(retry.disposition).toBe("reused");
	} finally {
		provider.unregister();
		await rm(root, { recursive: true, force: true });
	}
});
