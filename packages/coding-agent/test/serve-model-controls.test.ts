import type { AssistantMessage, Model, ModelControls } from "@earendil-works/pi-ai";
import { encodeServerMessage } from "@earendil-works/pi-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ANTHROPIC_MODELS } from "../../ai/src/providers/anthropic.models.ts";
import { AgentSessionServeDelegate } from "../src/core/serve/agent-session-serve-delegate.ts";
import { CurrentSessionService } from "../src/core/serve/current-session-service.ts";
import { LiveSessionRuntime } from "../src/core/serve/live-session-runtime.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

describe("serve native model settings", () => {
	let harness: Harness;
	let model: Model<"openai-responses">;
	let runtime: LiveSessionRuntime;
	const controls: ModelControls = { reasoningEffort: "low", processingTier: "default" };
	beforeEach(async () => {
		harness = await createHarness();
		const evidence = { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" } as const;
		model = {
			...harness.getModel(),
			api: "openai-responses",
			controls: {
				reasoningEffort: { values: ["low", "high"], evidence },
				processingTier: { values: ["default", "fast"], evidence },
			},
		};
		harness.session.agent.state.model = model;
		runtime = new LiveSessionRuntime(new AgentSessionServeDelegate(harness.session));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		harness.cleanup();
	});
	test("persists Anthropic speed independently of effort and rejects unsupported capacity values", async () => {
		await harness.session.modelRuntime.setRuntimeApiKey("anthropic", "synthetic-only");
		harness.session.agent.state.model = ANTHROPIC_MODELS["claude-opus-5"];
		await runtime.setModelControls({ reasoningEffort: "low", processingTier: "fast" });
		expect(harness.sessionManager.buildSessionContext().modelControls).toEqual({
			reasoningEffort: "low",
			processingTier: "fast",
		});
		await expect(runtime.setModelControls({ processingTier: "priority" })).rejects.toMatchObject({
			code: "invalid_request",
		});
		expect(runtime.snapshot().modelControls).toEqual({ reasoningEffort: "low", processingTier: "fast" });
		await runtime.setModelControls({ reasoningEffort: "high", processingTier: "standard" });
		expect(runtime.snapshot().modelControls).toEqual({ reasoningEffort: "high", processingTier: "standard" });
		await runtime.setModelControls({});
		expect(harness.sessionManager.buildSessionContext().modelControls).toEqual({});
	});
	test("validates controls in the shared session and returns snapshots without changing on failure", async () => {
		const notifications: unknown[] = [];
		const unsubscribe = runtime.subscribe((event) => notifications.push(event));
		await runtime.setModelControls(controls);
		expect(runtime.snapshot().modelControls).toEqual(controls);
		expect(harness.sessionManager.buildSessionContext().modelControls).toEqual(controls);
		expect(notifications.length).toBeGreaterThan(0);
		const before = notifications.length;
		await expect(runtime.setModelControls({ reasoningEffort: "invented" })).rejects.toMatchObject({
			code: "invalid_request",
			message: expect.stringContaining("Unsupported reasoningEffort"),
		});
		expect(runtime.snapshot().modelControls).toEqual(controls);
		expect(notifications).toHaveLength(before);
		const returned = runtime.snapshot().modelControls! as ModelControls;
		returned.processingTier = "fast";
		expect(harness.session.modelControls).toEqual(controls);
		await runtime.setModelControls({});
		expect(runtime.snapshot().modelControls).toEqual({});
		await runtime.setModelControls(null);
		expect(runtime.snapshot().modelControls).toBeUndefined();
		unsubscribe();
	});
	test("rejects an incompatible model switch and accepts an explicit atomic replacement", async () => {
		await runtime.setModelControls(controls);
		const replacement = { ...model, id: "replacement", controls: {} };
		vi.spyOn(harness.session.modelRuntime, "getModel").mockReturnValue(replacement);
		const checkAuth = vi
			.spyOn(harness.session.modelRuntime, "checkAuth")
			.mockResolvedValue({ type: "api_key", source: "fixture" });
		await expect(runtime.setModel(replacement)).rejects.toMatchObject({ code: "invalid_request" });
		expect(checkAuth).not.toHaveBeenCalled();
		expect(harness.session.model).toBe(model);
		expect(runtime.snapshot().modelControls).toEqual(controls);
		await runtime.setModel(replacement, {});
		expect(runtime.snapshot()).toMatchObject({ model: { id: "replacement" }, modelControls: {} });
		await runtime.setModel(replacement, null);
		expect(runtime.snapshot().modelControls).toBeUndefined();
	});
	test("maps only typed selection failures, not unexpected errors, into user-visible errors", async () => {
		const failure = new Error("private runtime failure");
		vi.spyOn(harness.session, "setModelControls").mockImplementation(() => {
			throw failure;
		});
		await expect(runtime.setModelControls({})).rejects.toBe(failure);
	});
	test("requires a supported legacy replacement and does not clear native settings on rejection", async () => {
		model.reasoning = true;
		model.thinkingLevelMap = {
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		};
		await runtime.setModelControls(controls);
		await expect(runtime.setThinking("low")).rejects.toMatchObject({ code: "invalid_request" });
		expect(runtime.snapshot().modelControls).toEqual(controls);
		await runtime.setThinking("high");
		expect(runtime.snapshot().modelControls).toBeUndefined();
		expect(runtime.snapshot().thinkingLevel).toBe("high");
	});
	test("preserves execution evidence and mixed pricing status in transcript snapshots", async () => {
		await runtime.setModelControls(controls);
		const assistant: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "fixture" }],
			stopReason: "stop",
			timestamp: 1,
			execution: {
				requested: { processingTier: "fast" },
				sent: { processingTier: "fast" },
				reported: { processingTier: "default" },
			},
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, status: "unknown" },
			},
		};
		harness.session.agent.state.messages.push(assistant);
		harness.session.agent.state.messages.push({
			role: "toolResult",
			toolCallId: "fixture",
			toolName: "fixture",
			content: [],
			timestamp: 2,
			isError: false,
			usage: { ...assistant.usage, cost: { ...assistant.usage.cost, total: 1, status: "reported" } },
		});
		const snapshot = runtime.snapshot();
		expect(snapshot.transcript[0]).toMatchObject({
			execution: assistant.execution,
			usage: { cost: { status: "unknown" } },
		});
		expect(snapshot.transcript[1]).toMatchObject({ usage: { cost: { status: "reported" } } });
		expect(() => encodeServerMessage({ type: "event", event: { type: "session_snapshot", snapshot } })).not.toThrow();
		if (snapshot.transcript[0]?.role !== "assistant") throw new Error("Missing assistant item");
		(snapshot.transcript[0].execution!.sent as ModelControls).processingTier = "changed";
		expect(assistant.execution?.sent.processingTier).toBe("fast");
	});
	test("rejects incompatible helper settings and disposes the unexposed runtime", async () => {
		harness.session.agent.state.modelControls = { reasoningEffort: "invented" };
		const dispose = vi.spyOn(harness.session, "dispose");
		const factory = vi.fn(async () => harness.session);
		const service = new CurrentSessionService(harness.session, 0, factory);
		await expect(
			service.createSession({ id: "unused", thinkingLevel: "high", modelControls: {} }),
		).rejects.toMatchObject({ code: "invalid_request" });
		expect(factory).not.toHaveBeenCalled();
		// A distinct host prevents the duplicate-ID guard from masking control validation.
		const host = await createHarness();
		try {
			const isolated = new CurrentSessionService(host.session, 0, factory);
			await expect(isolated.createSession({ id: harness.session.sessionId })).rejects.toMatchObject({
				code: "invalid_request",
			});
			expect(dispose).toHaveBeenCalledOnce();
			expect(await isolated.listSessions()).toHaveLength(1);
		} finally {
			host.cleanup();
		}
	});
});
