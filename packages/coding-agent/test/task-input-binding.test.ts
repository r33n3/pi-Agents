import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRoomService } from "../src/core/serve/agent-room-service.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { AgentTaskService } from "../src/core/serve/agent-task-service.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";
import {
	bindTaskInputs,
	inputEvidenceError,
	parseTaskInputBinding,
	parseTaskInputEvidence,
} from "../src/core/serve/task-input-binding.ts";
import { WorkflowService } from "../src/core/serve/workflow-service.ts";

let root: string;
const content = "item,quantity,unit_price\nnotebooks,7,7\npens,4,2\npens,2,2\n";
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-bound-input-"));
	await writeFile(join(root, "stock-review.csv"), content);
	await writeFile(join(root, "inventory.csv"), "old data");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("binds the current explicit input and detects changed or absent evidence", async () => {
	const binding = await bindTaskInputs("Please review stock-review.csv", root);
	expect(binding?.files.map((file) => file.path)).toEqual(["stock-review.csv"]);
	expect(parseTaskInputBinding(JSON.parse(JSON.stringify(binding)))).toEqual(binding);
	expect(parseTaskInputEvidence([])).toEqual([]);
	expect(inputEvidenceError(binding, [])).toContain("stock-review.csv");
	expect(inputEvidenceError(binding, [{ path: "inventory.csv", sha256: binding!.files[0]!.sha256 }])).toContain(
		"stock-review.csv",
	);
	expect(inputEvidenceError(binding, binding?.files)).toBeUndefined();
	await writeFile(join(root, "stock-review.csv"), "changed");
	const changed = await bindTaskInputs("Review stock-review.csv", root);
	expect(inputEvidenceError(binding, changed?.files)).toContain("stock-review.csv");
});

test("rejects missing, escaping and ambiguous inputs before model execution", async () => {
	await expect(bindTaskInputs("Review missing.csv", root)).rejects.toThrow("Cannot bind input missing.csv");
	await expect(bindTaskInputs("Review ../outside.csv", root)).rejects.toThrow("Cannot bind input");
	await expect(bindTaskInputs("Review stock-review.csv not inventory.csv", root)).rejects.toThrow("ambiguous");
	expect(await bindTaskInputs("What did the last review find?", root)).toBeUndefined();
	await writeFile(join(root, "stock review.csv"), content);
	expect((await bindTaskInputs('Review "stock review.csv"', root))?.files[0]?.path).toBe("stock review.csv");
});

test.each(["valid", "missing-evidence", "repair", "repair-exhausted"])(
	"team preserves inputs and bounds output correction: %s",
	async (mode) => {
		const missingEvidence = mode === "missing-evidence";
		const contexts: AgentExecutionContext[] = [];
		const executor: AgentExecutor = {
			start: async (context) => {
				contexts.push(context);
				return {
					result: Promise.resolve({
						output:
							mode === "repair-exhausted" ||
							(mode === "repair" &&
								contexts.filter((entry) => entry.definition.id === context.definition.id).length === 1)
								? "Plain prose instead of required JSON"
								: JSON.stringify({ outcome: "pass", message: "Reviewed", requestAgentIds: [] }),
						transcript: [],
						inputEvidence: missingEvidence ? [] : context.inputBinding?.files,
					}),
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
		for (const id of ["calculator", "auditor"]) {
			await registry.save({
				id,
				name: id,
				description: "Review inventory.csv",
				persona: "Read inventory.csv",
				tools: ["read"],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
			});
		}
		const runs = new AgentRunManager(registry, executor, join(root, "runs"));
		await runs.initialize();
		const tasks = new AgentTaskService(registry, runs, join(root, "tasks"));
		await tasks.initialize();
		const workflows = new WorkflowService(join(root, "workflows"), registry, tasks);
		await workflows.initialize();
		const rooms = new AgentRoomService(join(root, "rooms"), registry, tasks, workflows);
		await rooms.initialize();
		try {
			await rooms.save({
				id: "review",
				name: "Review",
				purpose: "Check input",
				members: [
					{ agentId: "calculator", role: "Calculate" },
					{ agentId: "auditor", role: "Verify" },
				],
			});
			const completed = await rooms.waitForCompletion((await rooms.start("review", "Review stock-review.csv")).id);
			expect(completed.status).toBe(missingEvidence || mode === "repair-exhausted" ? "failed" : "completed");
			expect(contexts).toHaveLength(mode.startsWith("repair") ? 4 : 2);
			expect(completed.taskIds).toHaveLength(contexts.length);
			for (const context of contexts) expect(context.inputBinding).toEqual(completed.inputBinding);
			for (const run of runs.list()) {
				expect(run.status).toBe(missingEvidence ? "failed" : "succeeded");
				if (missingEvidence) expect(run.error).toContain("no host read evidence");
			}
			const restored = new AgentRunManager(registry, executor, join(root, "runs"));
			await restored.initialize();
			expect(restored.list()).toHaveLength(runs.list().length);
			expect(restored.list()[0]?.inputEvidence).toEqual(runs.list()[0]?.inputEvidence);
			await restored.dispose();
		} finally {
			await rooms.dispose();
			await tasks.dispose();
			await runs.dispose();
		}
	},
);

test.each(["wrong-file", "changed-file", "wrong-total"])(
	"isolated worker enforces input and structured calculation checks: %s",
	async (scenario) => {
		const inputBinding = await bindTaskInputs("Review stock-review.csv", root);
		if (scenario === "changed-file") await writeFile(join(root, "stock-review.csv"), "changed after admission");
		const reads: string[] = [];
		const executor = new ChildProcessAgentExecutor({
			agentDir: root,
			serveRoot: join(root, "serve"),
			capabilityTools: () => [],
			workerPath: fileURLToPath(new URL("./fixtures/agent-worker-fixture.mjs", import.meta.url)),
			governedActions: new GovernedActionService(new ServeAuditStore(join(root, "audit"))),
			hostFileSystem: {
				read: async (path) => {
					reads.push(path);
					return readFile(path, "utf8");
				},
				list: async () => {
					throw new Error("Unexpected list");
				},
				write: async () => {
					throw new Error("Unexpected write");
				},
			},
		});
		const context: AgentExecutionContext = {
			runId: "bound-test",
			workspace: root,
			prompt: scenario === "wrong-total" ? '{"rowCount":3,"totalValue":65}' : "bound-review",
			inputBinding,
			definition: {
				id: "calculator",
				revision: 1,
				source: "managed",
				name: "Calculator",
				description: "Calculate inventory",
				tools: ["read"],
				capabilities: [],
				memory: "none",
				persona: "Always read inventory.csv",
				model: { provider: "openai", id: "test" },
				projectRoot: root,
				workspace: root,
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
				browserWorkflows: [],
				delegateAgentIds: [],
				a2a: { enabled: false },
			},
		};
		try {
			const execution = await executor.start(context);
			if (scenario === "changed-file") {
				await expect(execution.result).rejects.toThrow("changed");
			} else if (scenario === "wrong-total") {
				await expect(execution.result).rejects.toThrow("Inventory output verification failed");
			} else {
				const result = await execution.result;
				expect(JSON.parse(result.output)).toMatchObject({
					inputs: [{ path: "stock-review.csv", content }],
					denied: expect.stringContaining("bound"),
				});
				expect(result.inputEvidence).toEqual(inputBinding?.files);
			}
			expect(reads).toEqual([join(root, "stock-review.csv")]);
		} finally {
			await executor.dispose();
		}
	},
);
