import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	type Model,
	type ModelControls,
	type SimpleStreamOptions,
	Type,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { buildSessionContext, type ModelControlsChangeEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const selection: ModelControls = { reasoningEffort: "low", processingTier: "default" };
const evidence = { kind: "user-override", reference: "synthetic fixture", checkedAt: "2026-08-31" } as const;
const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	provider: "fixture",
	api: "openai-responses",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	controls: {
		reasoningEffort: { values: ["low", "high"], evidence },
		processingTier: { values: ["default", "fast"], evidence },
	},
};
const message: AssistantMessage = {
	role: "assistant",
	api: model.api,
	provider: model.provider,
	model: model.id,
	content: [],
	stopReason: "stop",
	timestamp: 0,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("session native model settings", () => {
	let directory: string;
	const sessions: AgentSession[] = [];
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-native-session-"));
	});
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});

	it("restores selections from disk without putting settings into LLM messages", () => {
		const store = SessionManager.create(directory, directory);
		store.appendModelChange(model.provider, model.id);
		const input = { ...selection };
		store.appendModelControlsChange(input);
		input.processingTier = "fast";
		store.appendMessage(message);
		const path = store.getSessionFile()!;
		const reopened = SessionManager.open(path);
		expect(reopened.buildSessionContext()).toMatchObject({ modelControls: selection, messages: [message] });
		expect(readFileSync(path, "utf8")).not.toContain("example.invalid");
		expect(readFileSync(path, "utf8")).not.toContain("synthetic fixture");
		const returned = reopened.buildSessionContext().modelControls!;
		returned.processingTier = "fast";
		expect(reopened.buildSessionContext().modelControls).toEqual(selection);
	});
	it("tracks native/default/legacy selections by branch and through compaction", () => {
		const store = SessionManager.inMemory(directory);
		const native = store.appendModelControlsChange(selection);
		const kept = store.appendMessage({ role: "user", content: "Kept fixture", timestamp: 0 });
		store.appendCompaction("Synthetic summary", kept, 10);
		expect(store.buildSessionContext().modelControls).toEqual(selection);
		store.appendThinkingLevelChange("high");
		expect(store.buildSessionContext().modelControls).toEqual(selection);
		store.appendModelChange("different", "different");
		expect(store.buildSessionContext().modelControls).toEqual(selection);
		store.appendModelControlsChange({});
		expect(store.buildSessionContext().modelControls).toEqual({});
		store.appendModelControlsChange(null);
		expect(store.buildSessionContext().modelControls).toBeUndefined();
		store.branch(native);
		expect(store.buildSessionContext().modelControls).toEqual(selection);
		store.createBranchedSession(native);
		expect(store.buildSessionContext().modelControls).toEqual(selection);
		store.resetLeaf();
		expect(store.buildSessionContext().modelControls).toBeUndefined();
	});
	it.each([undefined, [], "high", { processingTier: "" }, { reasoningBudget: 1.5 }, { unsupported: true }])(
		"rejects malformed settings rather than falling back: %j",
		(invalid) => {
			const store = SessionManager.inMemory(directory);
			expect(() => store.appendModelControlsChange(invalid as ModelControls)).toThrow("Invalid model controls");
			expect(store.getEntries()).toHaveLength(0);
			const entry = {
				type: "model_controls_change",
				id: "fixture",
				parentId: null,
				timestamp: "2026-08-31",
				modelControls: invalid,
			} as ModelControlsChangeEntry;
			expect(() => buildSessionContext([entry])).toThrow("Invalid model controls");
		},
	);
	it.each([{}, selection])("round-trips SDK creation and restore without legacy defaults: %j", async (controls) => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const requests: SimpleStreamOptions[] = [];
		vi.spyOn(runtime, "streamSimple").mockImplementation((_model, _context, options) => {
			requests.push({ ...options });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: structuredClone(message) });
			return stream;
		});
		const store = SessionManager.inMemory(directory);
		const common = {
			cwd: directory,
			agentDir: directory,
			model,
			modelRuntime: runtime,
			sessionManager: store,
			noTools: "all" as const,
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "high", thinkingBudgets: { high: 4096 } }),
		};
		const first = (await createAgentSession({ ...common, modelControls: controls })).session;
		sessions.push(first);
		await first.agent.prompt("Synthetic first turn");
		first.dispose();
		const restored = (await createAgentSession({ ...common, thinkingLevel: "high" })).session;
		sessions.push(restored);
		await restored.agent.prompt("Synthetic resumed turn");
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.controls).toEqual(controls);
			expect(request.reasoning).toBeUndefined();
			expect(request.thinkingBudgets).toBeUndefined();
		}
		expect(store.getEntries().filter((entry) => entry.type === "model_controls_change")).toHaveLength(1);
	});
	it.each([{ modelControls: null }, { modelControls: null, thinkingLevel: "low" as const }])(
		"persists explicit legacy selection over saved native controls: %j",
		async (override) => {
			const runtime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
			});
			const store = SessionManager.inMemory(directory);
			store.appendModelControlsChange(selection);
			const { session } = await createAgentSession({
				cwd: directory,
				agentDir: directory,
				model,
				modelRuntime: runtime,
				sessionManager: store,
				settingsManager: SettingsManager.inMemory(),
				...override,
			});
			sessions.push(session);
			expect(session.agent.state.modelControls).toBeUndefined();
			expect(store.buildSessionContext().modelControls).toBeUndefined();
			expect(store.getLeafEntry()).toMatchObject({ type: "model_controls_change", modelControls: null });
		},
	);

	async function createFixtureSession(controls: ModelControls = selection) {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
		const checkAuth = vi.spyOn(runtime, "checkAuth").mockResolvedValue({ type: "api_key", source: "synthetic" });
		vi.spyOn(runtime, "getAuth").mockResolvedValue(undefined);
		const requests: SimpleStreamOptions[] = [];
		const dispatch = vi.spyOn(runtime, "streamSimple").mockImplementation((_model, _context, options) => {
			requests.push({ ...options });
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...structuredClone(message), content: [{ type: "text", text: "Synthetic reply" }] },
			});
			return stream;
		});
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			model,
			modelControls: controls,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(directory),
			noTools: "all",
			settingsManager: SettingsManager.inMemory({
				thinkingBudgets: { low: 2048 },
				compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 1024 },
			}),
		});
		sessions.push(session);
		return { session, runtime, checkAuth, dispatch, requests };
	}

	it("validates setter changes and explicitly exits native mode through the legacy selector", async () => {
		const { session } = await createFixtureSession();
		const count = session.sessionManager.getEntries().length;
		expect(() => session.setModelControls({ reasoningEffort: "invented" })).toThrow("Unsupported");
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		session.setModelControls(selection);
		expect(session.sessionManager.getEntries()).toHaveLength(count);
		session.setModelControls({ reasoningEffort: "high", processingTier: "fast" });
		expect(session.sessionManager.buildSessionContext().modelControls).toEqual({
			reasoningEffort: "high",
			processingTier: "fast",
		});
		session.setThinkingLevel("low");
		expect(session.modelControls).toBeUndefined();
		expect(session.sessionManager.buildSessionContext().modelControls).toBeUndefined();
	});
	it("rejects an incompatible model before auth and accepts an explicit replacement together", async () => {
		const { session, checkAuth } = await createFixtureSession();
		const unsupported = { ...model, id: "unsupported", controls: {} };
		await expect(session.setModel(unsupported)).rejects.toThrow("not verified or implemented");
		expect(checkAuth).not.toHaveBeenCalled();
		expect(session.model).toEqual(model);
		expect(session.modelControls).toEqual(selection);
		await session.setModel(unsupported, { modelControls: {} });
		expect(session.model?.id).toBe("unsupported");
		expect(session.modelControls).toEqual({});
		expect(session.sessionManager.buildSessionContext()).toMatchObject({
			model: { provider: "fixture", modelId: "unsupported" },
			modelControls: {},
		});
	});
	it("rejects restored invalid options before prompt auth or dispatch", async () => {
		const { session, checkAuth, dispatch, runtime } = await createFixtureSession();
		session.agent.state.model = { ...model, controls: {} };
		await expect(session.prompt("Synthetic blocked prompt")).rejects.toThrow("not verified or implemented");
		expect(runtime.hasConfiguredAuth).not.toHaveBeenCalled();
		expect(checkAuth).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("keeps current preferences when navigating instead of reactivating historical Fast settings", async () => {
		const { session } = await createFixtureSession({ processingTier: "fast" });
		await session.prompt("Synthetic first prompt");
		const target = session.sessionManager.getLeafId()!;
		session.setModelControls({ processingTier: "default" });
		await session.navigateTree(target);
		expect(session.modelControls).toEqual({ processingTier: "default" });
		expect(session.sessionManager.buildSessionContext().modelControls).toEqual({ processingTier: "default" });
	});
	it("applies changed selections at tool-turn boundaries and restores legacy budgets explicitly", async () => {
		const { session, dispatch, requests } = await createFixtureSession();
		dispatch.mockImplementation((_model, _context, options) => {
			requests.push({ ...options });
			const stream = createAssistantMessageEventStream();
			const tool = requests.length <= 2;
			stream.push({
				type: "done",
				reason: tool ? "toolUse" : "stop",
				message: {
					...structuredClone(message),
					stopReason: tool ? "toolUse" : "stop",
					content: tool
						? [{ type: "toolCall", id: `call-${requests.length}`, name: "fixture", arguments: {} }]
						: [],
				},
			});
			return stream;
		});
		session.agent.state.tools = [
			{
				name: "fixture",
				label: "Fixture",
				description: "Offline",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			},
		];
		let turns = 0;
		session.subscribe((event) => {
			if (event.type !== "turn_end") return;
			if (++turns === 1) session.setModelControls({ reasoningEffort: "high" });
			else if (turns === 2) session.setThinkingLevel("low");
		});
		await session.prompt("Synthetic tool loop");
		expect(requests.map((request) => request.controls)).toEqual([selection, { reasoningEffort: "high" }, undefined]);
		expect(requests[2]).toMatchObject({ reasoning: "low", thinkingBudgets: { low: 2048 } });
	});
	it("uses native selections for compaction without injecting legacy effort", async () => {
		const { session, requests } = await createFixtureSession();
		await session.prompt("Synthetic content to summarize");
		await session.compact();
		expect(requests.length).toBeGreaterThan(1);
		for (const request of requests) {
			expect(request.controls).toEqual(selection);
			expect(request.reasoning).toBeUndefined();
			expect(request.thinkingBudgets).toBeUndefined();
		}
	});
	it("rejects explicit SDK native/legacy conflicts before creating runtime or session files", async () => {
		await expect(
			createAgentSession({ cwd: directory, agentDir: directory, modelControls: {}, thinkingLevel: "high" }),
		).rejects.toThrow("not both");
	});
});
