import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRoutineScheduler } from "../src/core/serve/agent-routine-scheduler.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { CapabilityApprovalService } from "../src/core/serve/capability-approval-service.ts";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { CapabilityProviderRegistry } from "../src/core/serve/capability-provider-registry.ts";
import { createGoogleWorkspaceTools } from "../src/core/serve/google-workspace-tools.ts";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { TeamRoutines } from "../src/core/serve/team-routines.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test("reviewed team schedules dispatch specialists, persist, cancel, and require review after edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-routine-"));
	const calls: string[] = [];
	let hold = false;
	let configurationAttempt = false;
	const executor: AgentExecutor = {
		async start(context) {
			calls.push(context.definition.id);
			let release: (() => void) | undefined;
			const result = (async () => {
				if (hold)
					await new Promise<void>((resolve) => {
						release = resolve;
					});
				let output: Record<string, unknown>;
				if (configurationAttempt) {
					output = {
						outcome: "reply",
						message: "Change tools",
						requestAgentIds: [],
						assignTools: [{ agentId: "reporter", toolIds: ["read"] }],
					};
				} else if (context.definition.id === "reporter") {
					await writeFile(join(root, "scheduled-report.txt"), "Specialist completed report");
					output = { outcome: "reply", message: "Specialist report saved", requestAgentIds: [] };
				} else if (calls.at(-2) !== "reporter") {
					output = {
						outcome: "reply",
						message: "Reporter, prepare the report",
						plan: {
							contribution: "separate-member",
							teamIds: [],
							memberIds: ["reporter"],
							toolHandoffs: [],
							reason: "The reporter must produce the report",
						},
						requestAgentIds: ["reporter"],
					};
				} else output = { outcome: "reply", message: "Report complete", requestAgentIds: [] };
				return { output: JSON.stringify(output), transcript: [] };
			})();
			return {
				result,
				subscribe: () => () => {},
				abort: async () => {
					release?.();
				},
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	};
	const agents = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["supervisor", "reporter"])
		await agents.save({
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
	const runs = new AgentRunManager(agents, executor, join(root, "runs"));
	const tasks = new AgentTaskService(agents, runs, join(root, "tasks"));
	const workflows = new WorkflowService(join(root, "workflows"), agents, tasks);
	const broker = new CapabilityBroker(join(root, "broker"), {
		activeToolNames: () => ["google_workspace_email_draft", "google_workspace_email_send"],
		environmentValue: () => undefined,
		registry: new CapabilityProviderRegistry({
			definitions: [
				{
					id: "email.draft",
					version: 1,
					name: "Gmail draft",
					description: "Draft fixture",
					category: "communication",
					effect: "write",
					defaultApproval: "per-run",
				},
				{
					id: "email.send",
					version: 1,
					name: "Gmail send",
					description: "Send fixture",
					category: "communication",
					effect: "external-side-effect",
					defaultApproval: "per-run",
				},
			],
			providers: [
				{
					id: "google-workspace",
					name: "Google fixture",
					source: "fixture",
					version: "1",
					permissions: ["draft", "send"],
					bindings: [
						{
							capabilityId: "email.draft",
							capabilityVersion: 1,
							toolName: "google_workspace_email_draft",
							executors: ["harness"],
						},
						{
							capabilityId: "email.send",
							capabilityVersion: 1,
							toolName: "google_workspace_email_send",
							executors: ["harness"],
						},
					],
				},
			],
		}),
	});
	const resources = new TeamResources(broker);
	const rooms = new AgentRoomService(join(root, "rooms"), agents, tasks, workflows, resources);
	const teams = new TeamRoutines(rooms, agents, resources, broker);
	const registry = new RoutineRegistry(join(root, "routines"), undefined, (definition) => teams.validate(definition));
	const scheduler = new AgentRoutineScheduler(registry, { start: (definition) => teams.start(definition) });
	try {
		await broker.initialize();
		await runs.initialize();
		await tasks.initialize();
		await workflows.initialize();
		await rooms.initialize();
		await rooms.save({
			id: "reports",
			name: "Reports",
			purpose: "Report preparation",
			supervisorAgentId: "supervisor",
			members: [
				{ agentId: "supervisor", role: "Coordinate" },
				{ agentId: "reporter", role: "Report" },
			],
			toolIds: ["read"],
		});
		await expect(teams.review("reports", "report")).rejects.toThrow("successful team run");
		const proof = await rooms.start("reports", "Have the reporter prepare a report");
		const completedProof = await rooms.waitForCompletion(proof.id);
		expect(completedProof.status, JSON.stringify(completedProof)).toBe("completed");
		const review = await teams.review("reports", "report");
		const input = {
			id: "reports-weekly",
			name: "Reports weekly",
			prompt: "Have the reporter prepare a report",
			cron: "0 9 * * 1",
			timezone: "UTC",
			maxDurationMinutes: 10,
			enabled: true,
			target: {
				kind: "team" as const,
				roomId: "reports",
				configurationDigest: review.configurationDigest,
				delivery: "report" as const,
				confirmed: true,
			},
		};
		await expect(registry.save({ ...input, target: { ...input.target, confirmed: false } })).rejects.toThrow(
			"confirm",
		);
		await expect(teams.review("reports", "draft")).rejects.toThrow("Gmail draft tool");
		const saved = await registry.save(input);
		const restored = new RoutineRegistry(join(root, "routines"));
		expect(await restored.get(saved.id)).toEqual(saved);
		await scheduler.refresh(0);
		calls.length = 0;
		await scheduler.runDue(scheduler.list()[0]!.nextRunAt!);
		const scheduledId = scheduler.list()[0]!.lastRunId!;
		expect((await rooms.waitForCompletion(scheduledId)).status).toBe("completed");
		expect(calls).toEqual(["supervisor", "reporter", "supervisor"]);
		expect(await readFile(join(root, "scheduled-report.txt"), "utf8")).toBe("Specialist completed report");
		expect(rooms.getRun(scheduledId)?.routine).toEqual({
			id: saved.id,
			revision: saved.revision,
			delivery: "report",
		});
		expect(await teams.draftEvidence(rooms.getRun(scheduledId)!, registry)).toBeUndefined();
		hold = true;
		const execution = await teams.start(saved);
		await expect(teams.start(saved)).rejects.toThrow();
		await execution.cancel();
		await execution.completion;
		expect(rooms.getRun(execution.runId)?.status).toBe("cancelled");
		hold = false;
		configurationAttempt = true;
		const config = await teams.start(saved);
		expect((await config.completion).error).toContain("cannot change tool assignments");
		expect(rooms.getDefinition("reports")!.members[1]!.toolIds).toBeUndefined();
		configurationAttempt = false;
		await rooms.save({ ...rooms.getDefinition("reports")!, sharedNotes: "Changed purpose preferences" });
		await scheduler.runDue(scheduler.list()[0]!.nextRunAt!);
		expect(scheduler.list()[0]!.availabilityError).toContain("configuration changed");
		expect(scheduler.list()[0]!.nextRunAt).toBeUndefined();
		await expect(teams.start(saved)).rejects.toThrow("configuration changed");
		await registry.save({ ...saved, enabled: false });
		await scheduler.refresh();
		expect(scheduler.list()[0]!.enabled).toBe(false);
		await broker.reviewProvider("google-workspace", true);
		await broker.enableProvider("google-workspace", true);
		const team = rooms.getDefinition("reports")!;
		team.toolIds = undefined;
		team.members[1]!.toolIds = ["read", "google-workspace:email.draft"];
		await rooms.save(team);
		const draftReview = await teams.review("reports", "draft");
		await expect(teams.review("reports", "report")).resolves.toMatchObject({
			configurationDigest: draftReview.configurationDigest,
		});
		const draftRoutine = await registry.save({
			...input,
			enabled: false,
			target: { ...input.target, delivery: "draft", configurationDigest: draftReview.configurationDigest },
		});
		hold = true;
		const draftRun = await teams.start(draftRoutine);
		const current = rooms.getRun(draftRun.runId)!;
		const evidence = await teams.draftEvidence(current, registry);
		expect(evidence?.messageId).toBe(`schedule:${draftRoutine.id}:${draftRoutine.revision}`);
		const approvals = new CapabilityApprovalService(join(root, "approvals"));
		await approvals.initialize();
		const requests: string[] = [];
		const gmail = createGoogleWorkspaceTools({
			approvals,
			approvalOwner: { kind: "agent-run", id: "scheduled-reporter" },
			draftApprovalEvidence: () => teams.draftEvidence(rooms.getRun(draftRun.runId)!, registry),
			environment: {
				GOOGLE_CLIENT_ID: "fixture",
				GOOGLE_CLIENT_SECRET: "fixture",
				GOOGLE_OAUTH_ACCESS_TOKEN: "fixture",
				GOOGLE_OAUTH_EXPIRES_AT: String(Date.now() + 3600000),
			},
			fetch: async (url) => {
				requests.push(String(url));
				return new Response(JSON.stringify({ id: "draft-fixture", message: { id: "message-fixture" } }));
			},
		});
		const message = { to: ["recipient@example.com"], subject: "Scheduled report", text: "Report ready for review" };
		await gmail
			.find((tool) => tool.name === "google_workspace_email_draft")!
			.execute("draft", message, undefined, undefined, {} as ExtensionContext);
		expect(requests).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/drafts"]);
		expect(approvals.list()[0]).toMatchObject({ state: "completed", evidence });
		await expect(
			gmail
				.find((tool) => tool.name === "google_workspace_email_send")!
				.execute("send", message, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("separate approval");
		expect(requests).toHaveLength(1);
		await registry.save({ ...draftRoutine, enabled: false });
		expect(await teams.draftEvidence(current, registry)).toBeUndefined();
		await draftRun.cancel();
		await draftRun.completion;
		expect(await teams.draftEvidence(rooms.getRun(draftRun.runId)!, registry)).toBeUndefined();
		team.members[1]!.toolIds!.push("google-workspace:email.send");
		await rooms.save(team);
		await expect(teams.review("reports", "draft")).rejects.toThrow("interactive approval");
	} finally {
		await scheduler.dispose();
		await rooms.dispose();
		await tasks.dispose();
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
