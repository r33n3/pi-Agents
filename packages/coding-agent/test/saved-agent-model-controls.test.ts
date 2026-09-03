import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Model, type ModelControls, validateModelControls } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type { AgentExecutionContext, AgentExecutor } from "../src/core/serve/agent-executor.ts";
import { type AgentDefinitionInput, AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { createAgentRegistryTools } from "../src/core/serve/agent-registry-tools.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";

const evidence = { kind: "user-override", reference: "synthetic test", checkedAt: "2026-08-31" } as const;
const model: Model<"openai-responses"> = {
	provider: "fixture",
	id: "native",
	name: "Synthetic native model",
	api: "openai-responses",
	baseUrl: "https://unused.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 4096,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	controls: {
		reasoningEffort: { values: ["low", "high"], evidence },
		processingTier: { values: ["default", "fast"], evidence },
	},
};

describe("saved agent native model settings", () => {
	let root: string;
	let registry: AgentRegistry;
	let runs: AgentRunManager;
	let lifecycle: AgentBuildLifecycleService;
	let input: AgentDefinitionInput;
	let currentModel: Model<"openai-responses">;
	const contexts: AgentExecutionContext[] = [];
	const start = vi.fn(async (context: AgentExecutionContext) => {
		contexts.push(structuredClone(context));
		return {
			result: Promise.resolve({ output: "Synthetic proof", transcript: [] }),
			subscribe: () => () => {},
			abort: async () => {},
			dispose: async () => {},
			[Symbol.asyncDispose]: async () => {},
		};
	});
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-saved-native-controls-"));
		currentModel = structuredClone(model);
		contexts.length = 0;
		start.mockClear();
		registry = new AgentRegistry(join(root, "registry"), {
			defaultWorkspace: join(root, "workspace"),
			modelCatalog: () => [currentModel, { ...currentModel, id: "other" }],
			modelControlsValidator: (reference, controls) =>
				validateModelControls(
					reference.id === "other" ? { ...currentModel, id: "other", controls: {} } : currentModel,
					controls,
				),
		});
		const executor: AgentExecutor = { start, dispose: async () => {}, [Symbol.asyncDispose]: async () => {} };
		runs = new AgentRunManager(registry, executor, join(root, "runs"));
		await runs.initialize();
		lifecycle = new AgentBuildLifecycleService(root, registry, runs);
		input = {
			name: "Synthetic reviewer",
			description: "Review fixture only",
			persona: "Careful",
			projectRoot: join(root, "workspace"),
			tools: [],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			schedules: [],
			model: { provider: model.provider, id: model.id },
			modelControls: { reasoningEffort: "low", processingTier: "default" },
		};
	});
	afterEach(async () => {
		await runs.dispose();
		await rm(root, { recursive: true, force: true });
	});

	test("round-trips exact settings without aliasing, including explicit provider defaults and legacy mode", async () => {
		const saved = await registry.save(input);
		const path = join(root, "registry", "definitions", `${saved.id}.json`);
		expect(JSON.parse(await readFile(path, "utf8")).modelControls).toEqual(input.modelControls);
		(saved.modelControls as ModelControls).processingTier = "fast";
		expect((await registry.get(saved.id))!.modelControls).toEqual(input.modelControls);
		await registry.save({ ...input, modelControls: {} });
		expect((await registry.get(saved.id))!.modelControls).toEqual({});
		await registry.save({ ...input, modelControls: undefined, thinking: "high" });
		expect((await registry.get(saved.id))!.modelControls).toBeUndefined();
		expect((await registry.get(saved.id))!.thinking).toBe("high");
	});

	test.each([
		{ thinking: "low" },
		{ model: undefined },
		{ modelControls: null },
		{ modelControls: { reasoningEffort: "invented" } },
		{ modelControls: { processingTier: "flex" } },
		{ modelControls: { extra: true } },
		{ modelControls: { reasoningBudget: 2.5 } },
	])("rejects invalid saved settings atomically: %j", async (invalid) => {
		const saved = await registry.save(input);
		const path = join(root, "registry", "definitions", `${saved.id}.json`);
		const before = await readFile(path, "utf8");
		const event = vi.fn();
		registry.subscribe(event);
		await expect(registry.save({ ...input, ...invalid } as AgentDefinitionInput)).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe(before);
		expect(event).not.toHaveBeenCalled();
	});

	test("retains unavailable saved choices for review, but revalidates runs and temporary model overrides before execution", async () => {
		const saved = await registry.save(input);
		await expect(
			runs.start(saved.id, "fixture", "manual", { provider: model.provider, id: "other" }),
		).rejects.toThrow("not verified");
		currentModel.controls = {};
		expect((await registry.get(saved.id))!.modelControls).toEqual(input.modelControls);
		await expect(runs.start(saved.id, "fixture")).rejects.toThrow("not verified");
		expect(start).not.toHaveBeenCalled();
		expect(runs.list()).toEqual([]);
	});

	test("revalidates a proof before changing previous evidence", async () => {
		const saved = await registry.save(input);
		const build = await lifecycle.ensureForAgent(saved.id);
		const proof = await lifecycle.startProof(build.id, "Synthetic proof");
		await runs.waitForCompletion(proof.proof!.runId);
		const before = await lifecycle.get(build.id);
		const stored = await readFile(join(root, "agent-builds.json"), "utf8");
		currentModel.controls = {};
		await expect(lifecycle.startProof(build.id, "Retry")).rejects.toThrow("not verified");
		expect(await lifecycle.get(build.id)).toEqual(before);
		expect(await readFile(join(root, "agent-builds.json"), "utf8")).toBe(stored);
		expect(start).toHaveBeenCalledTimes(1);
	});

	test("preserves settings through chat draft, reload, publish, candidate proof and promotion", async () => {
		const [configure] = createAgentRegistryTools(registry, lifecycle);
		const context = {} as ExtensionContext;
		const configured = await configure.execute(
			"fixture",
			{
				name: input.name,
				description: input.description,
				projectRoot: input.projectRoot,
				model: `${model.provider}/${model.id}`,
				modelControls: input.modelControls,
			},
			undefined,
			undefined,
			context,
		);
		const buildId = configured.details!.buildId;
		lifecycle = new AgentBuildLifecycleService(root, registry, runs);
		expect((await lifecycle.get(buildId)).configuration!.modelControls).toEqual(input.modelControls);
		await expect(lifecycle.publishDraft(buildId)).rejects.toThrow("accept its current proof");
		const initialProof = await lifecycle.startProof(buildId, "Prove the unpublished synthetic agent");
		await runs.waitForCompletion(initialProof.proof!.runId);
		expect(contexts[0].definition).toMatchObject({ revision: 1, modelControls: input.modelControls });
		await lifecycle.reviewProof(buildId, true);
		const published = await lifecycle.publishDraft(buildId);
		const agentId = published.agentId!;
		expect((await registry.get(agentId))!.modelControls).toEqual(input.modelControls);
		const [edit] = createAgentRegistryTools(registry, lifecycle);
		await edit.execute(
			"refine",
			{ id: agentId, name: input.name, modelControls: { reasoningEffort: "high" } },
			undefined,
			undefined,
			context,
		);
		const candidate = await lifecycle.get(buildId);
		expect(candidate.activeConfiguration!.modelControls).toEqual(input.modelControls);
		expect(candidate.configuration!.modelControls).toEqual({ reasoningEffort: "high" });
		expect((await registry.get(agentId))!.modelControls).toEqual(input.modelControls);
		const proof = await lifecycle.startProof(buildId, "Run synthetic proof");
		await runs.waitForCompletion(proof.proof!.runId);
		expect(contexts[1].definition).toMatchObject({ revision: 2, modelControls: { reasoningEffort: "high" } });
		expect(contexts[1].definition.thinking).toBeUndefined();
		await lifecycle.reviewProof(buildId, true);
		await lifecycle.assertPromotionAllowed(proof.proof!.runId);
		await lifecycle.markPromoted(proof.proof!.runId, "synthetic-review", join(root, "synthetic-skill"));
		expect((await registry.get(agentId))!).toMatchObject({ revision: 2, modelControls: { reasoningEffort: "high" } });
		const restored = new AgentBuildLifecycleService(root, registry, runs);
		expect((await restored.get(buildId)).activeConfiguration!.modelControls).toEqual({ reasoningEffort: "high" });
	});

	test("chat preserves omitted settings and requires explicit replacement when changing to an incompatible model", async () => {
		const saved = await registry.save(input);
		const [configure] = createAgentRegistryTools(registry, lifecycle);
		const context = {} as ExtensionContext;
		const parameters = { id: saved.id, name: saved.name };
		const result = await configure.execute(
			"edit",
			{ ...parameters, description: "Refined" },
			undefined,
			undefined,
			context,
		);
		const id = result.details!.buildId;
		expect((await lifecycle.get(id)).configuration!.modelControls).toEqual(input.modelControls);
		const before = await readFile(join(root, "agent-builds.json"), "utf8");
		await expect(
			configure.execute("bad", { ...parameters, model: "fixture/other" }, undefined, undefined, context),
		).rejects.toThrow("not verified");
		expect(await readFile(join(root, "agent-builds.json"), "utf8")).toBe(before);
		await configure.execute(
			"replace",
			{ ...parameters, model: "fixture/other", modelControls: {} },
			undefined,
			undefined,
			context,
		);
		expect((await lifecycle.get(id)).configuration!.modelControls).toEqual({});
		await configure.execute("legacy", { ...parameters, thinking: "low" }, undefined, undefined, context);
		expect((await lifecycle.get(id)).configuration).toMatchObject({ thinking: "low" });
		expect((await lifecycle.get(id)).configuration!.modelControls).toBeUndefined();
		await configure.execute("native", { ...parameters, modelControls: {} }, undefined, undefined, context);
		expect((await lifecycle.get(id)).configuration!.thinking).toBeUndefined();
		await configure.execute("clear", { ...parameters, modelControls: null }, undefined, undefined, context);
		expect((await lifecycle.get(id)).configuration!.modelControls).toBeUndefined();
		await expect(
			configure.execute(
				"mixed",
				{ ...parameters, thinking: "low", modelControls: {} },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("not both");
	});

	test.each(["createDraft", "stageDraft", "updateDraft"] as const)(
		"%s rejects unsupported controls before mutating the draft store",
		async (method) => {
			const saved = await registry.save(input);
			const build = await lifecycle.ensureForAgent(saved.id);
			const before = await readFile(join(root, "agent-builds.json"), "utf8");
			const draft = {
				name: build.name,
				objective: build.objective,
				projectRoot: build.projectRoot,
				configuration: { ...build.configuration, modelControls: { reasoningEffort: "invalid" } },
			};
			await expect(
				method === "updateDraft" ? lifecycle[method](build.id, draft) : lifecycle[method](draft),
			).rejects.toThrow("Unsupported");
			expect(await readFile(join(root, "agent-builds.json"), "utf8")).toBe(before);
			expect((await lifecycle.get(build.id)).configuration!.modelControls).toEqual(input.modelControls);
		},
	);
});
