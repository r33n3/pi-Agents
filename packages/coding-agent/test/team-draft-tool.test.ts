import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import type { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { PiAgentBundleInstaller } from "../src/core/serve/pi-agent-bundle.ts";
import { PiAgentTeamLauncher } from "../src/core/serve/pi-agent-team-launcher.ts";
import { createTeamDraftTool } from "../src/core/serve/team-draft-tool.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("prepares an ordered team without deploying, then uses the existing reviewed launcher", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-draft-"));
	const provider = registerFauxProvider();
	try {
		const model = provider.getModel();
		const registry = new AgentRegistry(join(root, "agents"), { defaultWorkspace: root, modelCatalog: () => [model] });
		await registry.initialize();
		const tasks = { ensureRoomConversation: async () => ({ id: "test-inbox" }) } as unknown as AgentTaskService;
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
		const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await rooms.initialize();
		const launcher = new PiAgentTeamLauncher(installer, tasks, workflows, rooms, registry);
		const tool = createTeamDraftTool(launcher);
		const result = await tool.execute(
			"draft",
			{
				name: "Review team",
				steps: [
					{ name: "Reader", instructions: "Read the input", tools: ["read"], capabilities: [] },
					{ name: "Checker", instructions: "Check the previous result", tools: ["read"], capabilities: [] },
					{ name: "Coordinator", instructions: "Summarize the checked result", capabilities: [] },
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
		expect(rooms.getDefinition(launched.target.roomId!)?.supervisorAgentId).toBe(launched.target.coordinatorAgentId);
		expect(rooms.listRuns()).toEqual([]);
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

test("new research drafts discover, bind and launch configured services without account logins or manual grants", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-research-draft-"));
	const provider = registerFauxProvider();
	let configured = true;
	try {
		const model = provider.getModel();
		const broker = new CapabilityBroker(join(root, "broker"), {
			activeToolNames: () => ["searxng_search", "firecrawl_scrape", "firecrawl_search"],
			environmentValue: (name) =>
				configured
					? (
							{
								SEARXNG_BASE_URL: "http://127.0.0.1:8888",
								FIRECRAWL_BASE_URL: "http://127.0.0.1:3002",
							} as Record<string, string>
						)[name]
					: undefined,
		});
		await broker.initialize();
		for (const id of ["pi-searxng", "pi-firecrawl"]) {
			await broker.reviewProvider(id, true);
			await broker.enableProvider(id, true);
		}
		await broker.setDefaultProvider("web.search", "pi-searxng", true);
		const registry = new AgentRegistry(join(root, "agents"), {
			defaultWorkspace: root,
			modelCatalog: () => [model],
			capabilityValidator: (grants, executor) => broker.validateGrants(grants, executor),
		});
		await registry.initialize();
		const tasks = { ensureRoomConversation: async () => ({ id: "research-inbox" }) } as unknown as AgentTaskService;
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		const installer = new PiAgentBundleInstaller(join(root, "installs"), registry, workflows);
		const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, new TeamResources(broker));
		await rooms.initialize();
		const launcher = new PiAgentTeamLauncher(installer, tasks, workflows, rooms, registry, undefined, broker);
		const tool = createTeamDraftTool(launcher);
		const context = { cwd: root, model } as ExtensionContext;
		const discovery = await tool.execute("discover", {}, undefined, undefined, context);
		expect(discovery.details).toMatchObject({
			capabilities: expect.arrayContaining([
				expect.objectContaining({ id: "web.search", providers: expect.arrayContaining(["pi-searxng"]) }),
				expect.objectContaining({ id: "web.scrape", providers: ["pi-firecrawl"] }),
			]),
		});
		expect(JSON.stringify(discovery)).not.toContain("127.0.0.1");
		const input = {
			name: "Live research team",
			steps: [
				{
					name: "Researcher",
					instructions: "Find current flight information and read sources.",
					capabilities: [{ id: "web.search" }, { id: "web.scrape" }],
				},
				{ name: "Coordinator", instructions: "Summarize sourced research with limitations.", capabilities: [] },
			],
		};
		const result = await tool.execute("draft", input, undefined, undefined, context);
		const { teamDraft: draft } = result.details as {
			teamDraft: ReturnType<PiAgentTeamLauncher["prepareWithLocalDefaults"]>;
		};
		expect(draft.preview.team.roles[0]?.toolNames).toEqual(["searxng_search", "firecrawl_scrape"]);
		expect(draft.preview.team.roles[1]?.capabilityGrantCount).toBe(0);
		expect(draft.bindings.capabilities?.["step-1"]).toEqual([
			{ capabilityId: "web.search", capabilityVersion: 1, providerId: "pi-searxng", approval: "never" },
			{ capabilityId: "web.scrape", capabilityVersion: 1, providerId: "pi-firecrawl", approval: "never" },
		]);
		expect(await registry.list()).toEqual([]);
		configured = false;
		await expect(
			launcher.launch(draft.bundle, draft.bindings, draft.preview.approvalDigest, "tester"),
		).rejects.toThrow("unavailable");
		await expect(tool.execute("missing", input, undefined, undefined, context)).rejects.toThrow(
			"Team requires web.search",
		);
		expect(await registry.list()).toEqual([]);
		configured = true;
		await broker.disableProvider("pi-searxng", true);
		await expect(
			launcher.launch(draft.bundle, draft.bindings, draft.preview.approvalDigest, "tester"),
		).rejects.toThrow("not enabled");
		await broker.enableProvider("pi-searxng", true);
		const launched = await launcher.launch(draft.bundle, draft.bindings, draft.preview.approvalDigest, "tester");
		const researcher = await registry.get(launched.target.agentIds[0]!);
		expect(broker.resolveToolNames(researcher!.capabilities, "harness")).toEqual([
			"searxng_search",
			"firecrawl_scrape",
		]);
		expect(rooms.getDefinition(launched.target.roomId!)?.toolIds).toBeUndefined();
		expect(() => launcher.resolveDraftCapabilities([{ id: "web.crawl" }])).toThrow("Team requires web.crawl");
		expect(() => launcher.resolveDraftCapabilities([{ id: "web.search", providerId: "invented-provider" }])).toThrow(
			"invented-provider",
		);
	} finally {
		provider.unregister();
		await rm(root, { recursive: true, force: true });
	}
});
