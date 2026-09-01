import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSessionOptions } from "../src/main.ts";

const evidence = { kind: "user-override", reference: "synthetic CLI fixture", checkedAt: "2026-08-31" } as const;
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
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	controls: {
		reasoningMode: { values: ["standard", "pro"], evidence },
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

describe("CLI native control parsing", () => {
	it("keeps mode, effort, budget and processing speed separate without provider aliases", () => {
		const parsed = parseArgs([
			"--reasoning-mode",
			"adaptive",
			"--reasoning-effort=high",
			"--reasoning-budget",
			"1024",
			"--processing-tier",
			"fast",
		]);
		expect(parsed.diagnostics).toEqual([]);
		expect(parsed.unknownFlags.size).toBe(0);
		expect(parsed.thinking).toBeUndefined();
		expect(parsed.modelControls).toEqual({
			reasoningMode: "adaptive",
			reasoningEffort: "high",
			reasoningBudget: 1024,
			processingTier: "fast",
		});
	});
	it.each(["-1", "0", "1024"])("parses integer %s without assuming the model supports it", (value) => {
		expect(parseArgs(["--reasoning-budget", value]).modelControls).toEqual({ reasoningBudget: Number(value) });
	});
	it.each(["", " ", "1.5", "-2", "Infinity", "NaN", "1e3", "0x100", "9007199254740992"])(
		"rejects malformed budget %j",
		(value) => {
			expect(parseArgs([`--reasoning-budget=${value}`]).diagnostics).toEqual([
				expect.objectContaining({ type: "error" }),
			]);
		},
	);
	it.each(["--reasoning-mode", "--reasoning-effort", "--reasoning-budget", "--processing-tier", "--thinking"])(
		"does not consume another flag as %s's missing value",
		(flag) => {
			const parsed = parseArgs([flag, "--print"]);
			expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
			expect(parsed.print).toBe(true);
			expect(parseArgs([flag]).diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		},
	);
	it.each(["", " high", "high "])("rejects empty or padded native strings %j", (value) => {
		expect(parseArgs(["--reasoning-effort", value]).diagnostics).toEqual([
			expect.objectContaining({ type: "error" }),
		]);
	});
	it("distinguishes no override from provider defaults", () => {
		expect(parseArgs([]).modelControls).toBeUndefined();
		expect(parseArgs(["--model-defaults"]).modelControls).toEqual({});
		for (const flags of [
			["--model-defaults", "--reasoning-effort", "high"],
			["--reasoning-effort", "high", "--model-defaults"],
		]) {
			expect(parseArgs(flags).modelControls).toEqual({ reasoningEffort: "high" });
		}
	});
	it.each([
		["--thinking", "high", "--model-defaults"],
		["--processing-tier", "fast", "--thinking", "low"],
	])("rejects legacy/native conflicts: %j", (...flags) => {
		expect(parseArgs(flags).diagnostics).toEqual([
			expect.objectContaining({ type: "error", message: expect.stringContaining("not both") }),
		]);
	});
	it("honors the end-of-options delimiter for native flags", () => {
		const parsed = parseArgs(["--", "--processing-tier", "fast"]);
		expect(parsed.modelControls).toBeUndefined();
		expect(parsed.messages).toEqual(["--processing-tier", "fast"]);
	});
});

describe("CLI native selections through SDK services", () => {
	let directory: string;
	let runtime: ModelRuntime;
	const sessions: AgentSession[] = [];
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "pi-cli-model-controls-"));
		runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		vi.spyOn(runtime, "getModels").mockReturnValue([model]);
		vi.spyOn(runtime, "getModel").mockReturnValue(model);
	});
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		vi.restoreAllMocks();
		rmSync(directory, { recursive: true, force: true });
	});
	it("resolves native controls without injecting scoped legacy defaults", () => {
		const parsed = parseArgs(["--reasoning-effort", "low"]);
		const result = buildSessionOptions(
			parsed,
			[{ model, thinkingLevel: "high" }],
			false,
			runtime,
			SettingsManager.inMemory(),
		);
		expect(result.options.modelControls).toEqual({ reasoningEffort: "low" });
		expect(result.options.thinkingLevel).toBeUndefined();
		parsed.modelControls!.reasoningEffort = "high";
		expect(result.options.modelControls).toEqual({ reasoningEffort: "low" });
	});
	it("does not mistake a literal model ID ending in :high for thinking shorthand", () => {
		vi.mocked(runtime.getModels).mockReturnValue([{ ...model, id: "literal:high" }]);
		const result = buildSessionOptions(
			parseArgs(["--model", "fixture/literal:high", "--model-defaults"]),
			[],
			false,
			runtime,
			SettingsManager.inMemory(),
		);
		expect(result.options.model?.id).toBe("literal:high");
		expect(result.options.modelControls).toEqual({});
	});
	it("rejects native controls with a parsed model thinking shorthand", () => {
		expect(() =>
			buildSessionOptions(
				parseArgs(["--model", "fixture/fixture:high", "--model-defaults"]),
				[],
				false,
				runtime,
				SettingsManager.inMemory(),
			),
		).toThrow("not both");
	});
	it("keeps custom IDs usable without borrowing the fallback model's native capabilities", () => {
		const custom = buildSessionOptions(
			parseArgs(["--model", "fixture/not-in-catalog", "--model-defaults"]),
			[],
			false,
			runtime,
			SettingsManager.inMemory(),
		);
		expect(custom.options.model?.id).toBe("not-in-catalog");
		expect(custom.options.model?.controls).toEqual({});
		expect(custom.options.modelControls).toEqual({});
		expect(() =>
			buildSessionOptions(
				parseArgs(["--model", "fixture/not-in-catalog", "--reasoning-effort", "low"]),
				[],
				false,
				runtime,
				SettingsManager.inMemory(),
			),
		).toThrow("not verified or implemented");
	});
	it("rejects unverified native options before auth or session construction", () => {
		const auth = vi.spyOn(runtime, "checkAuth");
		const dispatch = vi.spyOn(runtime, "streamSimple");
		expect(() =>
			buildSessionOptions(
				parseArgs(["--model", "fixture/fixture", "--reasoning-effort", "max"]),
				[],
				false,
				runtime,
				SettingsManager.inMemory(),
			),
		).toThrow("Unsupported");
		expect(auth).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
	});
	it.each([
		{ flags: [], expected: { reasoningEffort: "low", processingTier: "fast" } },
		{ flags: ["--reasoning-effort", "high"], expected: { reasoningEffort: "high" } },
		{ flags: ["--processing-tier", "default"], expected: { processingTier: "default" } },
		{ flags: ["--model-defaults"], expected: {} },
		{ flags: ["--thinking", "low"], expected: undefined },
		{ flags: ["--model", "fixture/fixture:low"], expected: undefined },
	])("resumes without silently merging prior Fast into explicit selections: $flags", async ({ flags, expected }) => {
		const store = SessionManager.inMemory(directory);
		store.appendModelChange(model.provider, model.id);
		store.appendThinkingLevelChange("high");
		store.appendModelControlsChange({ reasoningEffort: "low", processingTier: "fast" });
		store.appendMessage(message);
		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "high" }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const parsed = parseArgs(["--model", "fixture/fixture", ...flags]);
		const { options } = buildSessionOptions(parsed, [], true, runtime, services.settingsManager);
		const { session } = await createAgentSessionFromServices({ services, sessionManager: store, ...options });
		sessions.push(session);
		expect(session.modelControls).toEqual(expected);
		expect(store.buildSessionContext().modelControls).toEqual(expected);
		const requests: SimpleStreamOptions[] = [];
		vi.spyOn(runtime, "streamSimple").mockImplementation((_model, _context, options) => {
			requests.push({ ...options });
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: structuredClone(message) });
			return stream;
		});
		await session.agent.prompt("Offline CLI fixture");
		expect(requests).toHaveLength(1);
		expect(requests[0].controls).toEqual(expected);
		expect(requests[0].reasoning).toBe(expected === undefined ? "low" : undefined);
	});
	it("validates controls for an SDK-selected default model before persisting them", async () => {
		vi.spyOn(runtime, "hasConfiguredAuth").mockReturnValue(true);
		const store = SessionManager.inMemory(directory);
		const services = await createAgentSessionServices({
			cwd: directory,
			agentDir: directory,
			modelRuntime: runtime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.id }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const { options } = buildSessionOptions(
			parseArgs(["--reasoning-effort", "max"]),
			[],
			false,
			runtime,
			services.settingsManager,
		);
		expect(options.model).toBeUndefined();
		await expect(createAgentSessionFromServices({ services, sessionManager: store, ...options })).rejects.toThrow(
			"Unsupported",
		);
		expect(store.getEntries()).toEqual([]);
	});
});

describe("source CLI startup", () => {
	it.each([
		{ flags: ["--help"], status: 0, output: "--reasoning-effort" },
		{ flags: ["--thinking", "high", "--model-defaults"], status: 1, output: "not both" },
		{ flags: ["--reasoning-budget", "1.5"], status: 1, output: "requires an integer" },
	])(
		"handles native options using the source launcher: $flags",
		({ flags, status, output }) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-cli-native-startup-"));
			try {
				const result = spawnSync(
					process.execPath,
					[
						"--import",
						new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
						fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
						"--offline",
						"--no-extensions",
						"--no-skills",
						"--no-prompt-templates",
						"--no-themes",
						"--no-context-files",
						...flags,
					],
					{
						cwd: directory,
						env: {
							PATH: process.env.PATH,
							SystemRoot: process.env.SystemRoot,
							TEMP: tmpdir(),
							TMP: tmpdir(),
							[ENV_AGENT_DIR]: directory,
							PI_OFFLINE: "1",
							PI_SKIP_VERSION_CHECK: "1",
							PI_DISABLE_LOCAL_TOOL_ENV: "1",
							TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
						},
						encoding: "utf8",
						timeout: 20_000,
					},
				);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(status);
				expect(result.stdout + result.stderr).toContain(output);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
