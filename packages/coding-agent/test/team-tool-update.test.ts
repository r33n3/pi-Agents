import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { createScopedAgentTools } from "../src/core/serve/scoped-agent-tools.ts";
import { parseTeamChatUpdate, prepareTeamChatUpdate } from "../src/core/serve/team-chat-update.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { planTeamWork, requestsTeamMember } from "../src/core/serve/team-work-plan.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test.each([
	"Add Google Workspace email draft access to our reporting specialist",
	"Add write tools for our agent",
	"Add email capabilities to our reporting member",
])("adding tools does not recruit: %s", (goal) => {
	expect(requestsTeamMember(goal)).toBe(false);
	expect(planTeamWork(goal, "Travel reports").contribution).toBe("direct");
});

test.each([
	"approve",
	"decline",
	"allowed",
	"inherited",
	"unavailable",
	"revoked",
	"independent-work",
	"dependent-work",
	"unwired-guidance",
	"display-name",
	"bare-approve",
	"configuration-only",
	"bounded-approval",
	"exhausted-approval",
	"queued-approval",
])("chat tool update: %s", async (mode) => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-tools-"));
	const contexts: AgentExecutionContext[] = [];
	let stage = "propose";
	let needsRepair = mode === "unwired-guidance";
	let available = true;
	class Resources extends TeamResources {
		override list() {
			return super.list().filter((tool) => available || tool.id !== "write");
		}
	}
	const resources = new Resources();
	const executor: AgentExecutor = {
		async start(context) {
			contexts.push(context);
			const output: Record<string, unknown> = { outcome: "reply", requestAgentIds: [], message: "Finished" };
			if (needsRepair) {
				output.message = 'Open Settings and reply "Approve tools".';
				needsRepair = false;
			} else if (context.definition.id === "reporter") {
				if (mode === "bare-approve") {
					const write = createScopedAgentTools(context.definition, context.workspace).find(
						(tool) => tool.name === "write",
					)!;
					await write.execute(
						"proof",
						{ path: "tool-approval-proof.txt", content: "Assigned tool executed" },
						undefined,
						undefined,
						{} as ExtensionContext,
					);
				}
				output.message = "Report contribution completed";
			} else if (stage === "propose") {
				output.message = "Draft preview: Hawaii report. Tool changes proposed, not yet saved.";
				output.updateTeam = {
					expectedRevision: 0,
					...(mode === "independent-work" ? { independentAgentIds: ["reporter"] } : {}),
					memberTools: [
						{
							agentId: "reporter",
							toolIds: [
								mode === "unavailable"
									? "google-workspace:email.draft"
									: mode === "display-name"
										? "  Write WORKSPACE files  "
										: "write",
							],
						},
					],
					memberInstructions: [{ agentId: "reporter", instructions: "Prepare concise Hawaii reports" }],
				};
				if (mode === "allowed" || mode === "independent-work" || mode === "dependent-work")
					output.requestAgentIds = ["reporter"];
				stage = mode === "allowed" || mode === "independent-work" ? "finish" : "delegate";
			} else if (stage === "delegate") {
				output.requestAgentIds = ["reporter"];
				stage = "finish";
			}
			return {
				result: Promise.resolve({ output: JSON.stringify(output), transcript: [] }),
				subscribe: () => () => {},
				abort: async () => {},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	};
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["supervisor", "reporter"])
		await registry.save({
			id,
			name: id,
			description: id,
			persona: id,
			tools: ["read"],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, resources);
	let restored: AgentRoomService | undefined;
	try {
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		await rooms.initialize();
		await rooms.save({
			id: "travel",
			name: "Travel",
			purpose: "Travel reports",
			supervisorAgentId: "supervisor",
			members: [
				{ agentId: "supervisor", role: "Coordinate" },
				{ agentId: "reporter", role: "Report", ...(mode === "allowed" ? { toolIds: [] } : {}) },
			],
			...(mode === "allowed" ? { toolIds: ["write"] } : mode === "inherited" ? { toolIds: ["read"] } : {}),
		});
		const started = await rooms.message(
			"travel",
			["configuration-only", "queued-approval"].includes(mode)
				? "Add write to our reporter. Configuration only; do not start a search yet."
				: "Update our reporter to save reports",
		);
		if (mode === "queued-approval") await rooms.message("travel", "approve");
		const first = await rooms.waitForCompletion(started.id);
		if (mode === "queued-approval") {
			expect(first.status, first.error).toBe("completed");
			expect(first.result).toContain("No research was started");
			expect(rooms.getDefinition("travel")?.members[1]?.toolIds).toEqual(["read", "write"]);
			expect(contexts).toHaveLength(1);
			return;
		}
		if (mode === "allowed") {
			expect(first.status, first.error).toBe("completed");
			expect(contexts.find((context) => context.definition.id === "reporter")?.definition.tools).toEqual(["write"]);
			return;
		}
		expect(first.status, first.error).toBe("needs-user");
		expect(first.userQuestion).toContain("Approve tools");
		expect(first.pendingToolUpdate?.update.memberTools).toHaveLength(1);
		if (mode === "display-name") expect(first.pendingToolUpdate?.update.memberTools?.[0]?.toolIds).toEqual(["write"]);
		expect(rooms.getDefinition("travel")?.members[1].toolIds).toBeUndefined();
		if (mode === "independent-work") {
			expect(contexts.map((context) => context.definition.id)).toEqual(["supervisor", "reporter", "supervisor"]);
			expect(contexts[1].definition.tools).toEqual(["read"]);
			expect(contexts[1].prompt).toContain("Perform independent parts");
			expect(first.rounds[1].turns[0].message).toBe("Report contribution completed");
			return;
		}
		expect(contexts).toHaveLength(mode === "unwired-guidance" ? 2 : 1);
		if (mode === "unwired-guidance") expect(contexts[1].prompt).toContain("Host action check");
		if (mode === "bounded-approval" || mode === "exhausted-approval") {
			first.totalTokens = first.definitionSnapshot!.limits.maxTotalTokens;
			if (mode === "bounded-approval") first.status = "bounded";
			await writeFile(join(root, "rooms", "runs", first.id, "run.json"), JSON.stringify(first));
		}
		restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, resources);
		await restored.initialize();
		expect(restored.getRun(first.id)?.pendingToolUpdate).toEqual(first.pendingToolUpdate);
		if (mode === "revoked") available = false;
		if (mode === "decline") stage = "finish";
		const result = await restored.waitForCompletion(
			(
				await restored.message(
					"travel",
					mode === "decline"
						? "No, keep the tools as they are"
						: mode === "bare-approve"
							? "approve"
							: "Approve tools",
				)
			).id,
		);
		if (mode === "unavailable" || mode === "revoked") {
			expect(result.status).toBe("needs-user");
			expect(result.userQuestion).toContain("Tools have not been added");
			expect(contexts).toHaveLength(1);
			if (mode === "unavailable") return;
			available = true;
			const resumed = await restored.waitForCompletion((await restored.message("travel", "Approve tools")).id);
			expect(resumed.status, resumed.error).toBe("completed");
		} else expect(result.status, result.error).toBe("completed");
		const saved = restored.getDefinition("travel")!;
		if (mode === "decline") {
			expect(saved.members[1].toolIds).toBeUndefined();
			return;
		}
		expect(saved.members[1].toolIds).toEqual(["read", "write"]);
		if (["configuration-only", "bounded-approval", "exhausted-approval"].includes(mode)) {
			expect(contexts).toHaveLength(1);
			expect(result.result).toContain("No research was started");
			expect(result.toolGrantReceipt).toContain("added tools write");
			expect(result.pendingToolUpdate).toBeUndefined();
			expect((await registry.get("reporter"))?.tools).toEqual(["read"]);
			await expect(restored.message("travel", "approve tools")).rejects.toThrow("No pending tool proposal");
			expect(contexts).toHaveLength(1);
			return;
		}
		expect(contexts.some((context) => context.prompt.includes("Host-confirmed tool assignment after round"))).toBe(
			true,
		);
		expect(saved.members[1].notes).toBe("Prepare concise Hawaii reports");
		await restored.dispose();
		restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, resources);
		await restored.initialize();
		expect(restored.getDefinition("travel")?.members).toEqual(saved.members);
		expect(restored.getRun(first.id)?.toolGrantReceipt).toContain("Earlier missing-tool reports predate this change");
		expect(saved.chatState?.previous).toBeUndefined();
		expect((await registry.get("reporter"))?.tools).toEqual(["read"]);
		const reporter = contexts.find((context) => context.definition.id === "reporter")!;
		if (mode === "bare-approve")
			expect(await readFile(join(reporter.workspace, "tool-approval-proof.txt"), "utf8")).toBe(
				"Assigned tool executed",
			);
		expect(reporter.definition.tools).toEqual(["read", "write"]);
		expect(reporter.definition.permissionPolicy).toBe("workspace-write");
		expect(
			contexts
				.filter((context) => context.definition.id === "supervisor")
				.every((context) => !context.definition.tools.includes("write")),
		).toBe(true);
		if (mode === "inherited") expect(saved.members[0].toolIds).toEqual(["read"]);
		expect(() =>
			prepareTeamChatUpdate(
				saved,
				{ expectedRevision: 1, memberTools: [{ agentId: "reporter", toolIds: ["powershell"] }] },
				"unapproved",
			),
		).toThrow("approval");
		expect(() =>
			parseTeamChatUpdate({
				expectedRevision: 1,
				memberTools: [{ agentId: "reporter", toolIds: ["write", "write"] }],
			}),
		).toThrow();
	} finally {
		await restored?.dispose();
		await rooms.dispose();
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("missing email connection offers setup guidance without advertising an executable grant", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-tool-catalog-"));
	try {
		const broker = new CapabilityBroker(join(root, "broker"), {
			activeToolNames: () => ["google_workspace_email_draft"],
			environmentValue: () => undefined,
		});
		await broker.initialize();
		const resources = new TeamResources(broker);
		expect(resources.list().some((tool) => tool.id.includes("email.draft"))).toBe(false);
		const draft = resources.catalog().find((tool) => tool.id === "google-workspace:email.draft");
		expect(draft?.setup).toContain("Settings → Connections");
		expect(draft?.setup).toContain("Connect Google account");
		expect(() => resources.resolveTool("google-workspace:email.draft")).toThrow("Approve tools");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
