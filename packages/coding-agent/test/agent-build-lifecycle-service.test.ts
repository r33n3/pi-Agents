import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeferredExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	resolve: (result: AgentExecutionResult) => void = () => {};

	constructor() {
		this.result = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	subscribe(): () => void {
		return () => {};
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class DeferredExecutor implements AgentExecutor {
	readonly executions: DeferredExecution[] = [];
	readonly contexts: AgentExecutionContext[] = [];

	start(context: AgentExecutionContext): Promise<AgentExecution> {
		const execution = new DeferredExecution();
		this.contexts.push(context);
		this.executions.push(execution);
		return Promise.resolve(execution);
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(): Promise<{
	root: string;
	registry: AgentRegistry;
	runs: AgentRunManager;
	executor: DeferredExecutor;
	lifecycle: AgentBuildLifecycleService;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-build-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
	const executor = new DeferredExecutor();
	const runs = new AgentRunManager(registry, executor, join(root, "runs"));
	await runs.initialize();
	const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
	await lifecycle.initialize();
	return { root, registry, runs, executor, lifecycle };
}

async function saveReviewer(registry: AgentRegistry): Promise<void> {
	await registry.save({
		id: "reviewer",
		name: "Reviewer",
		description: "Review one boundary",
		tools: ["read"],
		memory: "none",
		persona: "Careful",
		executor: "harness",
		permissionPolicy: "read-only",
		schedules: [],
	});
}

describe("AgentBuildLifecycleService", () => {
	test("persists a named draft and rejects a collision with a deployed agent", async () => {
		const { root, registry, lifecycle } = await setup();
		const draft = await lifecycle.createDraft({
			name: "Daily mail",
			objective: "Summarize the previous day",
			projectRoot: join(root, "workspace"),
		});
		expect(draft).toMatchObject({ stage: "draft", name: "Daily mail" });

		const restored = new AgentBuildLifecycleService(
			join(root, "lifecycle"),
			registry,
			new AgentRunManager(registry, new DeferredExecutor(), join(root, "runs")),
		);
		await restored.initialize();
		await expect(restored.get(draft.id)).resolves.toMatchObject({ name: "Daily mail", stage: "draft" });

		await saveReviewer(registry);
		await expect(
			lifecycle.createDraft({
				name: "Reviewer",
				objective: "Duplicate",
				projectRoot: join(root, "workspace"),
			}),
		).rejects.toThrow("already exists");
	});

	test("requires explicit proof review and invalidates evidence when the agent revision changes", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		const draft = await lifecycle.createDraft({
			name: "Reviewer",
			objective: "Review one boundary",
			projectRoot: join(root, "workspace"),
		});
		await saveReviewer(registry);
		const linked = await lifecycle.linkAgent(draft.id, "reviewer");
		expect(linked.stage).toBe("ready-to-test");

		const testing = await lifecycle.startProof(linked.id, "Review this boundary once");
		await expect(lifecycle.startProof(linked.id, "Start twice")).rejects.toThrow("active proof");
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(testing.proof!.runId);
		await expect(lifecycle.get(linked.id)).resolves.toMatchObject({ stage: "proof-ready" });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).rejects.toThrow("Review and accept");

		await expect(lifecycle.reviewProof(linked.id, true)).resolves.toMatchObject({ stage: "proven" });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).resolves.toMatchObject({ id: linked.id });

		await saveReviewer(registry);
		await expect(lifecycle.get(linked.id)).resolves.toMatchObject({ stage: "ready-to-test", agentRevision: 2 });
		await expect(lifecycle.assertPromotionAllowed(testing.proof!.runId)).rejects.toThrow("not the reviewed proof");
	});

	test("unlocks automation only after the accepted proof is promoted", async () => {
		const { registry, runs, executor, lifecycle } = await setup();
		await saveReviewer(registry);
		const build = await lifecycle.ensureForAgent("reviewer");
		const testing = await lifecycle.startProof(build.id, "Review once");
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(testing.proof!.runId);
		await lifecycle.get(build.id);
		await lifecycle.reviewProof(build.id, true);
		await expect(lifecycle.assertAutomationAllowed("reviewer")).rejects.toThrow("promote it to a skill");

		await lifecycle.markPromoted(testing.proof!.runId, "review-boundary", "C:/skills/review-boundary/SKILL.md");
		await expect(lifecycle.assertAutomationAllowed("reviewer")).resolves.toMatchObject({ stage: "promoted" });
		await expect(lifecycle.markAutomated("reviewer", "review-daily")).resolves.toMatchObject({
			stage: "automated",
			routineIds: ["review-daily"],
		});
	});

	test("runs an existing-agent candidate without replacing the active revision until promotion", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		await saveReviewer(registry);
		const build = await lifecycle.ensureForAgent("reviewer");
		const candidate = await lifecycle.updateDraft(build.id, {
			name: "Reviewer",
			objective: "Review two boundaries",
			projectRoot: join(root, "workspace"),
			configuration: {
				name: "Reviewer",
				description: "Review two boundaries",
				persona: "More careful",
				projectRoot: join(root, "workspace"),
				tools: ["read"],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				browserAccess: "disabled",
				delegateAgentIds: [],
				exposeA2a: false,
			},
		});
		expect(candidate).toMatchObject({ stage: "draft", agentRevision: 1, candidateRevision: 2 });
		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, persona: "Careful" });

		const proof = await lifecycle.startProof(build.id, "Review the candidate once");
		expect(executor.contexts[0]?.definition).toMatchObject({ revision: 2, persona: "More careful" });
		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, persona: "Careful" });
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(proof.proof!.runId);
		await lifecycle.get(build.id);
		await lifecycle.reviewProof(build.id, true);
		await lifecycle.markPromoted(proof.proof!.runId, "review-boundary", "C:/skills/review-boundary/SKILL.md");
		expect(await registry.get("reviewer")).toMatchObject({ revision: 2, persona: "More careful" });
	});

	test("rejects promotion when the proof decision changes after the eligibility check", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		await saveReviewer(registry);
		const build = await lifecycle.ensureForAgent("reviewer");
		await lifecycle.updateDraft(build.id, {
			name: "Reviewer",
			objective: "Review two boundaries",
			projectRoot: join(root, "workspace"),
			configuration: {
				name: "Reviewer",
				description: "Review two boundaries",
				persona: "Accepted candidate",
				projectRoot: join(root, "workspace"),
				tools: ["read"],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				browserAccess: "disabled",
				delegateAgentIds: [],
				exposeA2a: false,
			},
		});
		const proof = await lifecycle.startProof(build.id, "Review the candidate once");
		executor.executions[0]!.resolve({ output: "Reviewed", transcript: [] });
		await runs.waitForCompletion(proof.proof!.runId);
		await lifecycle.get(build.id);
		await lifecycle.reviewProof(build.id, true);
		await expect(lifecycle.assertPromotionAllowed(proof.proof!.runId)).resolves.toMatchObject({ stage: "proven" });

		await lifecycle.recordFeedback(build.id, {
			rating: 2,
			summary: "The accepted proof needs another refinement pass.",
			answers: [],
		});
		await expect(
			lifecycle.markPromoted(proof.proof!.runId, "review-boundary", "C:/skills/review-boundary/SKILL.md"),
		).rejects.toThrow("no longer current");
		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, persona: "Careful" });
	});

	test("recovers a durable candidate and turns an interrupted proof into actionable refinement", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		await saveReviewer(registry);
		const build = await lifecycle.ensureForAgent("reviewer");
		const candidate = await lifecycle.updateDraft(build.id, {
			name: "Reviewer",
			objective: "Review two boundaries",
			projectRoot: join(root, "workspace"),
			configuration: {
				name: "Reviewer",
				description: "Review two boundaries",
				persona: "Retained candidate",
				projectRoot: join(root, "workspace"),
				tools: ["read"],
				memory: "none",
				executor: "harness",
				permissionPolicy: "read-only",
				browserAccess: "disabled",
				delegateAgentIds: [],
				exposeA2a: false,
			},
		});
		await lifecycle.startProof(candidate.id, "Run the retained recovery proof");

		const restoredRuns = new AgentRunManager(registry, new DeferredExecutor(), join(root, "runs"));
		await restoredRuns.initialize();
		const restoredLifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, restoredRuns);
		await restoredLifecycle.initialize();
		await expect(restoredLifecycle.get(candidate.id)).resolves.toMatchObject({
			stage: "needs-refinement",
			candidateRevision: 2,
			proofPrompt: "Run the retained recovery proof",
			configuration: { persona: "Retained candidate" },
			proof: {
				status: "failed",
			},
		});
		expect(await registry.get("reviewer")).toMatchObject({ revision: 1, persona: "Careful" });

		executor.executions[0]!.resolve({ output: "Original process ended", transcript: [] });
		await runs.waitForCompletion(candidate.proof?.runId ?? (await lifecycle.get(candidate.id)).proof!.runId);
	});

	// Synthetic identities reproduce failure categories without publishing a user's package.
	test("rejects source, geography, and stale-artifact failures and accepts the corrected same-task rerun", async () => {
		const { root, registry, runs, executor, lifecycle } = await setup();
		const workspace = join(root, "exampletown");
		await mkdir(workspace, { recursive: true });
		await writeFile(join(workspace, "report.html"), "Distant Lake — 40 miles north\nHeat Advisory Notice\n");
		await writeFile(join(workspace, "state.json"), '{"messageCount": null, "actionCount": null}\n');
		await registry.save({
			id: "exampletown-brief",
			name: "Exampletown brief",
			description: "Create a grounded local outdoor brief",
			projectRoot: workspace,
			tools: ["read", "write", "feed_read", "weather_alerts"],
			memory: "none",
			persona: "Use exact sources and preserve truthful state.",
			executor: "harness",
			permissionPolicy: "workspace-write",
			schedules: [],
		});
		const criteria = exampletownCriteria();
		const build = await lifecycle.stageDraft({
			name: "Exampletown brief",
			objective: "Create a grounded local outdoor brief",
			projectRoot: workspace,
			agentId: "exampletown-brief",
			criteria,
		});
		await lifecycle.linkAgent(build.id, "exampletown-brief");

		const failedProof = await lifecycle.startProof(build.id, "Create today's Exampletown brief");
		executor.executions[0]!.resolve({
			output: "All events verified. Heat advisory inferred. Distant Lake is 40 miles north.",
			transcript: [
				toolResult("feed_read", '{"entries":[]}'),
				toolResult("weather_alerts", "XML parse failure", true),
			],
		});
		await runs.waitForCompletion(failedProof.proof!.runId);
		const rejected = await lifecycle.get(build.id);
		expect(rejected.stage).toBe("needs-refinement");
		expect(rejected.evaluation?.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ criterionId: "exact-source", status: "fail" }),
				expect.objectContaining({ criterionId: "official-alert", status: "fail" }),
				expect.objectContaining({ criterionId: "report-written", status: "fail" }),
				expect.objectContaining({ criterionId: "report-current", status: "fail" }),
				expect.objectContaining({ criterionId: "local-geography", status: "fail" }),
				expect.objectContaining({ criterionId: "alert-honesty", status: "fail" }),
				expect.objectContaining({ criterionId: "state-counts", status: "fail" }),
			]),
		);

		await lifecycle.recordFeedback(build.id, {
			rating: 2,
			summary: "The result reused stale files and overstated its evidence.",
			answers: [
				{
					aspect: "goal-obligation",
					question: "What failed?",
					answer: "Geography, alerts, sources, and state.",
				},
			],
		});

		const correctedProof = await lifecycle.startProof(build.id, "Create today's Exampletown brief");
		await writeFile(
			join(workspace, "report.html"),
			"Exampletown, Example State local brief\nForecast-based heat caution\n",
		);
		await writeFile(join(workspace, "state.json"), '{"messageCount": 0, "actionCount": 0}\n');
		executor.executions[1]!.resolve({
			output: "Created a smaller local brief from an exact source.",
			transcript: [
				toolResult("feed_read", '{"entries":[{"title":"Local event"}]}'),
				toolResult("weather_alerts", '{"alerts":[]}'),
				toolResult("write", "Wrote report.html"),
				toolResult("write", "Wrote state.json"),
			],
		});
		await runs.waitForCompletion(correctedProof.proof!.runId);
		const reviewable = await lifecycle.get(build.id);
		expect(reviewable.stage).toBe("proof-ready");
		expect(reviewable.evaluation?.checks.every((check) => check.status === "pass")).toBe(true);
		expect(reviewable.proofHistory).toEqual([
			expect.objectContaining({
				proof: expect.objectContaining({ runId: failedProof.proof!.runId, status: "succeeded" }),
				evaluation: expect.objectContaining({
					checks: expect.arrayContaining([
						expect.objectContaining({ criterionId: "exact-source", status: "fail" }),
					]),
				}),
			}),
		]);
		await expect(lifecycle.reviewProof(build.id, true)).resolves.toMatchObject({ stage: "proven" });
	});
});

function toolResult(toolName: string, text: string, isError = false): AgentExecutionResult["transcript"][number] {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-${Math.random()}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: Date.now(),
	};
}

function exampletownCriteria(): unknown[] {
	const criterion = (
		id: string,
		label: string,
		category: string,
		evaluator: Record<string, unknown>,
	): Record<string, unknown> => ({
		id,
		label,
		description: label,
		category,
		expectation: "non-regression",
		evaluator,
	});
	return [
		criterion("exact-source", "Exact source returned evidence", "grounding-integrity", {
			type: "tool-receipt",
			toolNames: ["feed_read"],
			minimumSuccesses: 1,
			requireNonEmpty: true,
		}),
		criterion("official-alert", "Official alert lookup did not fail", "refusal-honesty", {
			type: "tool-errors",
			toolNames: ["weather_alerts"],
			maximumErrors: 0,
		}),
		criterion("report-written", "Report was written", "goal-obligation", {
			type: "workspace-mutation",
			toolNames: ["write", "edit"],
			minimumSuccesses: 1,
		}),
		criterion("report-current", "Report changed during this proof", "goal-obligation", {
			type: "artifact-change",
			path: "report.html",
		}),
		criterion("local-geography", "Known out-of-radius claim is absent", "goal-obligation", {
			type: "artifact-text",
			path: "report.html",
			mode: "omits",
			text: "Distant Lake",
		}),
		criterion("alert-honesty", "Unconfirmed official alert label is absent", "refusal-honesty", {
			type: "artifact-text",
			path: "report.html",
			mode: "omits",
			text: "Heat Advisory Notice",
		}),
		criterion("state-counts", "State counters are not null", "output-contract", {
			type: "artifact-text",
			path: "state.json",
			mode: "omits",
			text: '"messageCount": null',
		}),
	];
}
