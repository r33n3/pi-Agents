import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { RunSkillPromotionService } from "../src/core/serve/run-skill-promotion-service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CompletedExecutor implements AgentExecutor {
	start(_context: AgentExecutionContext): Promise<AgentExecution> {
		const result: AgentExecutionResult = { output: "Verified result", transcript: [] };
		return Promise.resolve({
			result: Promise.resolve(result),
			subscribe: () => () => {},
			abort: () => Promise.resolve(),
			dispose: () => Promise.resolve(),
			[Symbol.asyncDispose]: () => Promise.resolve(),
		});
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

describe("RunSkillPromotionService", () => {
	test("promotes one successful run into a validated non-overwriting user skill", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-run-skill-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"));
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews code",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new CompletedExecutor(), join(root, "runs"));
		const run = await runs.start("reviewer", "Review this boundary");
		await runs.waitForCompletion(run.id);
		const service = new RunSkillPromotionService(runs, join(root, "skills"));

		const promoted = await service.promote({
			runId: run.id,
			name: "review-boundary",
			description: "Review one code boundary using the verified checklist.",
			instructions: "Inspect the named boundary. Report concrete findings with file references.",
		});

		expect(promoted).toMatchObject({ runId: run.id, name: "review-boundary" });
		expect(await readFile(promoted.path, "utf8")).toContain("source-run-id:");
		await expect(
			service.promote({
				runId: run.id,
				name: "review-boundary",
				description: "Duplicate",
				instructions: "Do not overwrite the reviewed skill.",
			}),
		).rejects.toThrow("already exists");
	});

	test("validates run identities and permits only one concurrent promotion for a skill name", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-run-skill-concurrent-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"));
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews code",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new CompletedExecutor(), join(root, "runs"));
		const run = await runs.start("reviewer", "Review this boundary");
		await runs.waitForCompletion(run.id);
		const service = new RunSkillPromotionService(runs, join(root, "skills"));
		const input = {
			runId: run.id,
			name: "concurrent-review",
			description: "Review one boundary without duplicate installation.",
			instructions: "Inspect the named boundary and retain evidence.",
		};

		await expect(service.promote({ ...input, runId: "invalid\nrun" })).rejects.toThrow("Run ID must be");
		const results = await Promise.allSettled([service.promote(input), service.promote(input)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(await readFile(join(root, "skills", "concurrent-review", "SKILL.md"), "utf8")).toContain(
			"name: concurrent-review",
		);
	});

	test("removes the installed skill when lifecycle promotion is rejected", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-run-skill-rejected-"));
		roots.push(root);
		const registry = new AgentRegistry(join(root, "registry"));
		await registry.save({
			id: "reviewer",
			name: "Reviewer",
			description: "Reviews code",
			tools: ["read"],
			memory: "none",
			persona: "Careful",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
		});
		const runs = new AgentRunManager(registry, new CompletedExecutor(), join(root, "runs"));
		const run = await runs.start("reviewer", "Review this boundary");
		await runs.waitForCompletion(run.id);
		const lifecycle = {
			assertPromotionAllowed: () => Promise.resolve({}),
			markPromoted: () => Promise.reject(new Error("The accepted proof is no longer current")),
		} as unknown as AgentBuildLifecycleService;
		const service = new RunSkillPromotionService(runs, join(root, "skills"), lifecycle);

		await expect(
			service.promote({
				runId: run.id,
				name: "rejected-review",
				description: "Review one boundary only after lifecycle acceptance.",
				instructions: "Inspect the boundary and retain evidence.",
			}),
		).rejects.toThrow("no longer current");
		await expect(readFile(join(root, "skills", "rejected-review", "SKILL.md"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
