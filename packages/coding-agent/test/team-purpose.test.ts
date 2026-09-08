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
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

test.each([false, true])(
	"purposeful team tool assignment, durable memory, and authority rejection: rejected=%s",
	async (reject) => {
		const root = await mkdtemp(join(tmpdir(), "pi-team-purpose-"));
		const contexts: AgentExecutionContext[] = [];
		let first = true;
		const executor: AgentExecutor = {
			async start(context) {
				contexts.push(context);
				let output: Record<string, unknown>;
				if (first) {
					first = false;
					output = {
						outcome: "reply",
						message: "Writer, turn the brief into a prototype plan.",
						requestAgentIds: ["writer"],
						assignTools: [{ agentId: "writer", toolIds: reject ? ["bash"] : ["read", "write"] }],
						remember: [{ key: "project_goal", text: "Build a small puzzle prototype", scope: "team" }],
					};
				} else if (context.definition.id === "writer") {
					const tools = createScopedAgentTools(context.definition, context.workspace);
					const reader = tools.find((tool) => tool.name === "read")!;
					const writer = tools.find((tool) => tool.name === "write")!;
					const brief = await reader.execute(
						"read-brief",
						{ path: "brief.md", content: "" },
						undefined,
						undefined,
						{} as ExtensionContext,
					);
					expect(brief.content).toEqual([
						{ type: "text", text: "A puzzle prototype with one room and one mechanic." },
					]);
					await expect(
						writer.execute(
							"escape",
							{ path: "../outside.md", content: "no" },
							undefined,
							undefined,
							{} as ExtensionContext,
						),
					).rejects.toThrow("escapes");
					await writer.execute(
						"write-plan",
						{
							path: "prototype-plan.md",
							content:
								"One room, one puzzle mechanic. Milestone: playable graybox, then test with three players.",
						},
						undefined,
						undefined,
						{} as ExtensionContext,
					);
					output = {
						outcome: "reply",
						message: "Created prototype-plan.md from the brief.",
						requestAgentIds: [],
						remember: [{ key: "writing-style", text: "Use short milestone descriptions", scope: "private" }],
					};
				} else
					output = {
						outcome: "reply",
						message: "Prototype plan is ready in prototype-plan.md",
						requestAgentIds: [],
					};
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
		for (const id of ["supervisor", "writer"])
			await registry.save({
				id,
				name: id,
				description: id,
				persona: id,
				tools: [],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
			});
		const runs = new AgentRunManager(registry, executor, join(root, "runs"));
		const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		let toolsUnavailable = false;
		class TestResources extends TeamResources {
			override validate(ids: readonly string[]) {
				if (toolsUnavailable && ids.includes("read")) throw new Error("Team tool read is unavailable");
				return super.validate(ids);
			}
		}
		const teamResources = new TestResources();
		const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, teamResources);
		let restored: AgentRoomService | undefined;
		try {
			await runs.initialize();
			await tasks.initialize();
			await workflows.initialize();
			await rooms.initialize();
			await writeFile(join(root, "brief.md"), "A puzzle prototype with one room and one mechanic.");
			await rooms.save({
				id: "studio",
				name: "Studio",
				purpose: "Produce a usable prototype plan",
				supervisorAgentId: "supervisor",
				members: [
					{ agentId: "supervisor", role: "Coordinate", toolIds: ["read"] },
					{ agentId: "writer", role: "Write the plan", toolIds: [] },
				],
				toolIds: ["read", "ls", "write"],
				memoryStrategy: "team",
				sharedNotes: "Use free tools.",
			});
			const result = await rooms.waitForCompletion(
				(await rooms.message("studio", "Create a prototype plan from brief.md and save prototype-plan.md")).id,
			);
			if (reject) {
				expect(result.status).toBe("failed");
				expect(result.rounds[0]?.turns[0]?.message).toContain("PI_OUTPUT_SCHEMA_MISMATCH");
				expect(contexts).toHaveLength(1);
				expect(rooms.memory("studio")).toEqual([]);
			} else {
				expect(result.status).toBe("completed");
				expect(await readFile(join(root, "prototype-plan.md"), "utf8")).toContain("three players");
				expect(contexts[1]?.definition.tools).toEqual(["read", "write"]);
				expect(contexts[1]?.prompt).not.toContain("Run programs, tests and installers as the server user");
				expect(contexts[1]?.definition.teamContext).toContain(
					"Run programs, tests and installers as the server user",
				);
				expect((await registry.get("writer"))?.tools).toEqual([]);
				expect(rooms.memory("studio")).toHaveLength(2);
				restored = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows, teamResources);
				await restored.initialize();
				expect(restored.memory("studio")).toEqual(rooms.memory("studio"));
				await restored.waitForCompletion((await restored.message("studio", "What is our project goal?")).id);
				expect(contexts.at(-1)?.prompt).toContain("Build a small puzzle prototype");
				expect(contexts.at(-1)?.prompt).not.toContain("Use short milestone descriptions");
				await restored.waitForCompletion((await restored.message("studio", "@writer create the plan again")).id);
				expect(contexts.at(-2)?.prompt).toContain("Use short milestone descriptions");
				await restored.save({
					...restored.getDefinition("studio")!,
					memoryResetAt: Date.now(),
					memoryStrategy: "none",
				});
				expect(restored.memory("studio")).toEqual([]);
				await restored.waitForCompletion((await restored.message("studio", "Hello")).id);
				expect(contexts.at(-1)?.prompt).not.toContain("Build a small puzzle prototype");
				toolsUnavailable = true;
				const callsBefore = contexts.length;
				const blocked = await restored.waitForCompletion((await restored.message("studio", "Check our setup")).id);
				expect(blocked.status).toBe("needs-user");
				expect(blocked.userQuestion).toContain("Settings → Connections");
				expect(contexts).toHaveLength(callsBefore);
				toolsUnavailable = false;
				expect((await restored.waitForCompletion((await restored.resume(blocked.id, "Continue")).id)).status).toBe(
					"completed",
				);
			}
			const resources = new TeamResources();
			expect(() => resources.validate(["unavailable-tool"])).toThrow("unavailable");
			expect(
				createScopedAgentTools(resources.seed((await registry.get("writer"))!, ["ls"]).definition, root).map(
					(tool) => tool.name,
				),
			).toEqual(["list"]);
		} finally {
			await restored?.dispose();
			await rooms.dispose();
			await tasks.dispose();
			await runs.dispose();
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);

test("discovers only enabled executable capabilities and rejects a revoked tool selection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-tools-"));
	let active = ["page_read"];
	const broker = new CapabilityBroker(root, { activeToolNames: () => active });
	try {
		await broker.initialize();
		const resources = new TeamResources(broker);
		expect(resources.list().some((tool) => tool.id === "pi-public-web:web.fetch")).toBe(false);
		await broker.reviewProvider("pi-public-web", true);
		await broker.enableProvider("pi-public-web", true);
		expect(resources.validate(["pi-public-web:web.fetch"])[0]?.capabilities).toEqual([
			{ capabilityId: "web.fetch", capabilityVersion: 1, providerId: "pi-public-web", connectionId: undefined },
		]);
		active = [];
		expect(() => resources.validate(["pi-public-web:web.fetch"])).toThrow("unavailable");
		active = ["page_read"];
		await broker.disableProvider("pi-public-web", true);
		expect(() => resources.validate(["pi-public-web:web.fetch"])).toThrow("unavailable");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
