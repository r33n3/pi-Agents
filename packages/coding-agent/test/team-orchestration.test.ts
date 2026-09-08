import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

async function fixture(
	respond: (context: AgentExecutionContext) => Record<string, unknown> | Promise<Record<string, unknown>>,
) {
	const root = await mkdtemp(join(tmpdir(), "pi-team-hierarchy-"));
	const contexts: AgentExecutionContext[] = [];
	const executor: AgentExecutor = {
		async start(context) {
			contexts.push(context);
			let abort: () => void = () => {};
			const interrupted = new Promise<never>((_, reject) => {
				abort = () => reject(new Error("Cancelled"));
			});
			const result = Promise.race([Promise.resolve(respond(context)), interrupted]).then((output) => {
				const message = fauxAssistantMessage(JSON.stringify(output));
				message.usage = {
					input: 5,
					output: 5,
					totalTokens: 10,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0.005, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				};
				return {
					output: JSON.stringify(output),
					transcript: [message],
					inputEvidence: context.inputBinding?.files,
				};
			});
			return {
				result,
				subscribe: () => () => {},
				abort: async () => abort(),
				dispose: async () => {},
				[Symbol.asyncDispose]: async () => {},
			};
		},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	};
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	for (const id of ["manager", "designer", "reviewer"])
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
	const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
	await runs.initialize();
	await tasks.initialize();
	await workflows.initialize();
	await rooms.initialize();
	for (const [id, supervisor] of [
		["design", "designer"],
		["review", "reviewer"],
		["studio", "manager"],
	])
		await rooms.save({
			id,
			name: id!,
			purpose: `Purpose of ${id}`,
			supervisorAgentId: supervisor!,
			members: [{ agentId: supervisor!, role: supervisor! }],
			teamIds: id === "studio" ? ["design", "review"] : [],
			toolIds: [],
			memoryStrategy: "team",
		});
	return {
		root,
		rooms,
		contexts,
		registry,
		tasks,
		workflows,
		async dispose() {
			for (const run of rooms.listRuns()) {
				if (run.status === "running" || run.status === "needs-user") await rooms.cancel(run.id);
				await rooms.waitForCompletion(run.id);
				for (const workflowId of rooms.getRun(run.id)!.workflowRunIds)
					await workflows.waitForCompletion(workflowId);
			}
			await rooms.dispose();
			await tasks.dispose();
			await runs.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

const reply = (message: string, extra: Record<string, unknown> = {}) => ({
	outcome: "reply",
	message,
	requestAgentIds: [],
	...extra,
});

test("a supervisor with no selected teams cannot submit a placeholder team", async () => {
	const f = await fixture(async (context) => {
		const action = createTeamTurnTool(context.definition.responseSchema!);
		await expect(
			action.tool.execute(
				"invalid",
				reply("Done", { plan: { contribution: "direct", teamIds: ["no-teams-available"], reason: "Solo" } }),
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("schema");
		await action.tool.execute(
			"valid",
			reply("Done", { plan: { contribution: "direct", teamIds: [], reason: "Solo" } }),
			undefined,
			undefined,
			undefined as never,
		);
		return JSON.parse(action.result()!);
	});
	try {
		const result = await f.rooms.waitForCompletion((await f.rooms.start("design", "Complete this yourself")).id);
		expect(result.status, result.error).toBe("completed");
	} finally {
		await f.dispose();
	}
});

test("tool submission uses exact allowance IDs and rejects runtime aliases", async () => {
	const f = await fixture(async (context) => {
		const action = createTeamTurnTool(context.definition.responseSchema!);
		const plan = { contribution: "direct", teamIds: [], reason: "Configure my allowed tools" };
		await expect(
			action.tool.execute(
				"alias",
				reply("Configure", { plan, assignTools: [{ agentId: "manager", toolIds: ["list"] }] }),
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("schema");
		const valid = reply("Configured", { plan, assignTools: [{ agentId: "manager", toolIds: ["ls"] }] });
		await action.tool.execute("valid", valid, undefined, undefined, undefined as never);
		return valid;
	});
	try {
		await f.rooms.save({ ...f.rooms.getDefinition("studio")!, toolIds: ["read", "ls"] });
		const result = await f.rooms.waitForCompletion((await f.rooms.start("studio", "Configure your listing tool")).id);
		expect(result.status, result.error).toBe("completed");
	} finally {
		await f.dispose();
	}
});

test("tool questions expose child allowances without granting them to the coordinator", async () => {
	const f = await fixture((context) => {
		expect(context.definition.tools).toEqual([]);
		expect(context.prompt).toContain('"toolAllowance":["read","ls","write"]');
		expect(context.prompt).toContain('"agentId":"designer","tools":["read"]');
		expect(context.prompt).toContain('"toolAllowance":["read","ls"]');
		expect(context.prompt).toContain("An empty coordinator allowance does not prevent selected teams");
		return reply(
			"Design has read/list/write allowance; its member currently has read. Review has read/list. I coordinate their work.",
		);
	});
	try {
		await f.rooms.save({
			...f.rooms.getDefinition("design")!,
			toolIds: ["read", "ls", "write"],
			members: [{ agentId: "designer", role: "Design", toolIds: ["read"] }],
		});
		await f.rooms.save({ ...f.rooms.getDefinition("review")!, toolIds: ["read", "ls"] });
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.message("studio", "What tools do our teams have?")).id,
		);
		expect(result.status, result.error).toBe("completed");
		expect(f.contexts).toHaveLength(1);
		expect(result.childResults).toBeUndefined();
	} finally {
		await f.dispose();
	}
});

test("explicit team requests reject a supervisor's unsupported completion claim", async () => {
	const f = await fixture(() => reply("The teams completed everything"));
	try {
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.start("studio", "Use the selected teams to propose a scope")).id,
		);
		expect(result.status).toBe("needs-user");
		expect(result.result).toBeUndefined();
		expect(result.rounds).toHaveLength(2);
	} finally {
		await f.dispose();
	}
});

test("requesting both teams cannot complete after only one team contributes", async () => {
	let managerTurns = 0;
	const f = await fixture((context) =>
		context.definition.id === "manager" && ++managerTurns === 1
			? reply("Design, scope it", { requestTeam: { teamId: "design", goal: "Propose a scope" } })
			: reply("Both teams have finished"),
	);
	try {
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.start("studio", "Use both selected teams to scope and check the prototype")).id,
		);
		expect(result.workPlan?.teamIds).toEqual(["design", "review"]);
		expect(result.childResults?.map((child) => child.roomId)).toEqual(["design"]);
		expect(result.status).toBe("needs-user");
		expect(result.result).toBeUndefined();
		expect(f.contexts.at(-1)?.prompt).toContain('Outstanding required teams: ["review"]');
	} finally {
		await f.dispose();
	}
});

test("declared plans retain both teams even when the wording bypasses the staffing heuristic", async () => {
	let managerTurns = 0;
	const f = await fixture((context) =>
		context.definition.id === "manager" && ++managerTurns === 1
			? reply("Both teams will contribute", {
					plan: { contribution: "separate-team", teamIds: ["design", "review"], reason: "User requested both" },
					requestTeam: { teamId: "design", goal: "Propose a scope" },
				})
			: reply("Done"),
	);
	try {
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.start("studio", "How about having both teams work on this?")).id,
		);
		expect(result.workPlan?.teamIds).toEqual(["design", "review"]);
		expect(result.childResults?.map((child) => child.roomId)).toEqual(["design"]);
		expect(result.status).toBe("needs-user");
		expect(result.result).toBeUndefined();
	} finally {
		await f.dispose();
	}
});

test("a tool-free coordinator routes file work to the child's own workspace", async () => {
	let managerTurns = 0;
	const f = await fixture(async (context) => {
		if (context.definition.id === "manager") {
			expect(context.inputBinding).toBeUndefined();
			return ++managerTurns === 1
				? reply("Read the brief", {
						requestTeam: { teamId: "design", goal: "Read private-brief.md. Do not edit files." },
					})
				: reply("Child brief checked");
		}
		expect(context.inputBinding?.files[0]?.path).toBe("private-brief.md");
		return reply(await readFile(join(context.workspace, "private-brief.md"), "utf8"));
	});
	try {
		const childRoot = join(f.root, "child-workspace");
		await mkdir(childRoot);
		await writeFile(join(childRoot, "private-brief.md"), "A one-room prototype");
		await f.registry.save({ ...(await f.registry.get("designer"))!, projectRoot: childRoot });
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.start("studio", "Use the selected team to read private-brief.md. Do not edit files.")).id,
		);
		expect(result.status, result.error).toBe("completed");
		expect(result.childResults?.[0]?.result).toBe("A one-room prototype");
	} finally {
		await f.dispose();
	}
});

test("child usage consumes the coordinator budget without changing saved team limits", async () => {
	let managerTurns = 0;
	const f = await fixture((context) =>
		context.definition.id === "manager" && ++managerTurns === 1
			? reply("Design, scope it", { requestTeam: { teamId: "design", goal: "Propose a scope" } })
			: reply("Done"),
	);
	try {
		const saved = f.rooms.getDefinition("design")!;
		await f.rooms.save({ ...f.rooms.getDefinition("studio")!, limits: { maxTotalTokens: 25 } });
		const result = await f.rooms.waitForCompletion((await f.rooms.start("studio", "Propose a scope")).id);
		expect(result.status).toBe("bounded");
		expect(result.totalTokens).toBe(30);
		const child = f.rooms.listRuns("design")[0]!;
		expect(child.definitionSnapshot?.limits.maxTotalTokens).toBe(15);
		expect(f.rooms.getDefinition("design")!.limits).toEqual(saved.limits);
	} finally {
		await f.dispose();
	}
});

test("busy selected teams are not interrupted by another coordinator", async () => {
	let started: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const f = await fixture((context) => {
		if (context.definition.id === "manager")
			return reply("Design, act", { requestTeam: { teamId: "design", goal: "Another scope" } });
		started();
		return new Promise<Record<string, unknown>>(() => {});
	});
	try {
		const busy = await f.rooms.start("design", "Existing work");
		await ready;
		const parent = await f.rooms.waitForCompletion((await f.rooms.start("studio", "Propose a scope")).id);
		expect(parent.status).toBe("failed");
		expect(parent.error).toContain("active run");
		expect(f.rooms.getRun(busy.id)?.status).toBe("running");
		expect(f.rooms.listRuns("design")).toHaveLength(1);
	} finally {
		await f.dispose();
	}
});

test("three levels return evidence and count descendant usage once", async () => {
	const turns = new Map<string, number>();
	const f = await fixture((context) => {
		const room = context.prompt.includes("bounded local room company,")
			? "company"
			: context.definition.id === "manager"
				? "studio"
				: "design";
		const turn = (turns.get(room) ?? 0) + 1;
		turns.set(room, turn);
		if (room !== "design" && turn === 1)
			return reply("Please scope the prototype", {
				requestTeam: { teamId: room === "company" ? "studio" : "design", goal: "Propose a scope" },
			});
		return reply("One-room prototype scope");
	});
	try {
		await f.rooms.save({ ...f.rooms.getDefinition("studio")!, id: "company", name: "Company", teamIds: ["studio"] });
		const result = await f.rooms.waitForCompletion((await f.rooms.start("company", "Propose a scope")).id);
		expect(result.status, result.error).toBe("completed");
		expect(result.totalTokens).toBe(50);
		expect(f.rooms.listRuns("studio")[0]?.totalTokens).toBe(30);
		expect(f.rooms.listRuns("design")[0]?.totalTokens).toBe(10);
	} finally {
		await f.dispose();
	}
});

test("coordinator assigns two teams sequentially and retains task-backed results without exposing child memory", async () => {
	let managerTurns = 0;
	const f = await fixture((context) => {
		if (context.definition.id === "designer")
			return reply("One room and one puzzle", {
				remember: [{ key: "private", text: "CHILD_PRIVATE_NOTE", scope: "private" }],
			});
		if (context.definition.id === "reviewer") {
			expect(context.prompt).toContain("One room and one puzzle");
			return reply("Scope is achievable");
		}
		managerTurns++;
		if (managerTurns === 1)
			return reply("Design, scope the prototype.", {
				requestTeam: { teamId: "design", goal: "Propose a small prototype scope" },
			});
		if (managerTurns === 2) {
			expect(context.prompt).toContain("One room and one puzzle");
			return reply("Review, verify the proposed scope.", {
				requestTeam: { teamId: "review", goal: "Verify this proposal: One room and one puzzle" },
			});
		}
		expect(context.prompt).toContain("Scope is achievable");
		expect(context.prompt).not.toContain("CHILD_PRIVATE_NOTE");
		return reply("A one-room puzzle prototype was scoped and checked.");
	});
	try {
		const result = await f.rooms.waitForCompletion(
			(await f.rooms.start("studio", "Scope and check a prototype using the selected teams")).id,
		);
		expect(result.status, result.error).toBe("completed");
		expect(result.childResults?.map((child) => child.roomId)).toEqual(["design", "review"]);
		expect(result.totalTokens).toBe(50);
		expect(result.costUsd).toBeCloseTo(0.05);
		expect(f.contexts.map((context) => context.definition.id)).toEqual([
			"manager",
			"designer",
			"manager",
			"reviewer",
			"manager",
		]);
		for (const reference of result.childResults!) {
			const child = f.rooms.getRun(reference.runId)!;
			expect(child.parentRunId).toBe(result.id);
			expect(child.taskIds).toHaveLength(1);
			expect(child.deadlineAt).toBeLessThanOrEqual(result.deadlineAt);
		}
		const restored = new AgentRoomService(join(f.root, "rooms"), f.registry, f.tasks, f.workflows);
		await restored.initialize();
		expect(restored.getRun(result.id)?.childResults).toEqual(result.childResults);
		expect(restored.getDefinition("studio")?.teamIds).toEqual(["design", "review"]);
		await restored.dispose();
	} finally {
		await f.dispose();
	}
});

test.each(["failed", "needs-user", "unselected"])("child %s cannot produce a false parent completion", async (mode) => {
	let managerTurns = 0;
	let childTurns = 0;
	const f = await fixture((context) => {
		if (context.definition.id === "manager")
			return ++managerTurns === 1 || mode === "unselected"
				? reply("Design, act.", {
						requestTeam: { teamId: mode === "unselected" ? "unknown" : "design", goal: "Propose a scope" },
					})
				: reply("Scope accepted");
		if (mode === "failed") return { invalid: true };
		if (++childTurns === 1)
			return { outcome: "needs-user", message: "Should the prototype be two dimensional?", requestAgentIds: [] };
		expect(context.prompt).toContain("Yes, two dimensional");
		return reply("Two dimensional scope complete");
	});
	try {
		const result = await f.rooms.waitForCompletion((await f.rooms.start("studio", "Propose a scope")).id);
		if (mode === "needs-user") {
			expect(result.status).toBe("needs-user");
			expect(result.userQuestion).toContain("two dimensional");
			const completed = await f.rooms.waitForCompletion(
				(await f.rooms.message("studio", "Yes, two dimensional")).id,
			);
			expect(completed.status, completed.error).toBe("completed");
			expect(completed.childResults).toHaveLength(1);
		} else {
			expect(result.status).toBe("failed");
			expect(result.result).toBeUndefined();
			expect(managerTurns).toBe(mode === "unselected" ? 2 : 1);
		}
	} finally {
		await f.dispose();
	}
});

test.each([true, false])(
	"format repair is bounded and does not replay file-capable turns: toolFree=%s",
	async (toolFree) => {
		let attempts = 0;
		const f = await fixture(() =>
			++attempts === 1
				? { requestTeam: { outcome: "reply", message: "Malformed nesting", requestAgentIds: [] } }
				: reply("Correctly formatted answer"),
		);
		try {
			if (!toolFree) await f.rooms.save({ ...f.rooms.getDefinition("studio")!, toolIds: ["write"] });
			const result = await f.rooms.waitForCompletion((await f.rooms.start("studio", "Hello")).id);
			expect(result.status).toBe(toolFree ? "completed" : "failed");
			expect(attempts).toBe(toolFree ? 2 : 1);
			expect(result.totalTokens).toBe(toolFree ? 20 : 10);
		} finally {
			await f.dispose();
		}
	},
);

test("selected team graph rejects cycles, missing supervisors and excessive depth", async () => {
	const f = await fixture(() => reply("Done"));
	try {
		await expect(f.rooms.save({ ...f.rooms.getDefinition("design")!, teamIds: ["studio"] })).rejects.toThrow("cycle");
		await expect(f.rooms.save({ ...f.rooms.getDefinition("design")!, teamIds: ["missing"] })).rejects.toThrow(
			"available supervisor",
		);
		await expect(f.rooms.delete("design")).rejects.toThrow("coordinators");
		await f.rooms.save({ ...f.rooms.getDefinition("studio")!, id: "company", teamIds: ["studio"] });
		await f.rooms.save({ ...f.rooms.getDefinition("studio")!, id: "group", teamIds: ["company"] });
		await expect(
			f.rooms.save({ ...f.rooms.getDefinition("studio")!, id: "corporation", teamIds: ["group"] }),
		).rejects.toThrow("four levels");
	} finally {
		await f.dispose();
	}
});

test("cancelling a coordinator stops its active child without queue deadlock", async () => {
	let started: () => void = () => {};
	const childStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const f = await fixture((context) => {
		if (context.definition.id === "manager")
			return reply("Design, act.", { requestTeam: { teamId: "design", goal: "Propose a scope" } });
		started();
		return new Promise<Record<string, unknown>>(() => {});
	});
	try {
		const parent = await f.rooms.start("studio", "Propose a scope");
		await childStarted;
		await f.rooms.cancel(parent.id);
		expect((await f.rooms.waitForCompletion(parent.id)).status).toBe("cancelled");
		expect(f.rooms.listRuns("design")[0]?.status).toBe("cancelled");
	} finally {
		await f.dispose();
	}
});
