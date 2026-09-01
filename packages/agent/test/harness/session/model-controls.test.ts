import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelControls, ModelControlsError } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { type LaneReductionInput, reduceLaneState } from "../../../src/harness/reducer.ts";
import { buildSessionContext } from "../../../src/harness/session/context.ts";
import { parseMutation } from "../../../src/harness/session/jsonl/codec.ts";
import { JsonlSessionStorage } from "../../../src/harness/session/jsonl/storage.ts";
import { InMemorySessionStorage } from "../../../src/harness/session/memory.ts";
import { readSessionModelControls } from "../../../src/harness/session/model-controls.ts";
import type { Entry, ModelControlsEntry, NewRecord, ProvisionedEntry } from "../../../src/harness/session/types.ts";
import { createTempDir } from "../session-test-utils.ts";

function controlsEntry(modelControls: ModelControls | null, seq = 1): ModelControlsEntry {
	return { type: "model_controls_change", id: `settings-${seq}`, modelControls, seq, timestamp: seq, parentId: null };
}

function recoveryInput(overrides: Partial<LaneReductionInput> = {}): LaneReductionInput {
	return {
		lane: "main",
		leafId: null,
		openOperations: [],
		records: [],
		entries: [],
		ownEntries: [],
		configurationEntries: [],
		defaults: {
			model: { provider: "synthetic", modelId: "test" },
			thinkingLevel: "high",
			activeToolNames: [],
			modelControls: { processingTier: "priority" },
		},
		...overrides,
	};
}

describe("native controls in durable context and recovery", () => {
	it.each([{}, { reasoningEffort: "high" }, null])("restores %j without reviving a default Fast tier", (selection) => {
		const saved = controlsEntry(selection);
		const input = recoveryInput({ configurationEntries: [saved] });
		const result = reduceLaneState(input);
		expect(result.effectiveConfiguration.modelControls).toEqual(selection ?? undefined);
		if (selection === null) expect(result.effectiveConfiguration).not.toHaveProperty("modelControls");
	});

	it("copies defaults and applies the latest own selection without merging old axes", () => {
		const input = recoveryInput();
		const restored = reduceLaneState(input);
		restored.effectiveConfiguration.modelControls!.processingTier = "default";
		expect(input.defaults.modelControls).toEqual({ processingTier: "priority" });
		input.configurationEntries = [controlsEntry({ processingTier: "priority" }, 1)];
		input.ownEntries = [controlsEntry({ reasoningBudget: 1024 }, 3)];
		expect(reduceLaneState(input).effectiveConfiguration.modelControls).toEqual({ reasoningBudget: 1024 });
	});

	it("retains settings before compaction and ignores context transforms for configuration", () => {
		const saved = controlsEntry({ reasoningEffort: "high", processingTier: "priority" });
		const entries: Entry[] = [
			saved,
			{
				type: "compaction",
				id: "compact",
				seq: 2,
				timestamp: 2,
				parentId: saved.id,
				summary: "summary",
				retainedTail: [],
				tokensBefore: 100,
			},
			{
				type: "thinking_level_change",
				id: "legacy",
				seq: 3,
				timestamp: 3,
				parentId: "compact",
				thinkingLevel: "low",
			},
			{
				type: "model_change",
				id: "model",
				seq: 4,
				timestamp: 4,
				parentId: "legacy",
				provider: "other",
				modelId: "other",
			},
		];
		const context = buildSessionContext(entries, { entryTransforms: [() => []] });
		expect(context.modelControls).toEqual(saved.modelControls);
		expect(context.messages).toEqual([]);
		context.modelControls!.processingTier = "default";
		expect(saved.modelControls?.processingTier).toBe("priority");
	});

	it("keeps provisioned selections pending until their entry is committed", () => {
		const target: ProvisionedEntry<ModelControlsEntry> = {
			type: "model_controls_change",
			id: "next",
			modelControls: {},
		};
		const start = {
			type: "operation_started",
			id: "run",
			lane: "main",
			seq: 1,
			timestamp: 1,
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [target] },
		} as const;
		// The record's arrays are mutable in the public contract.
		const operation = { ...start, intent: { ...start.intent, originalPrompt: [], initialMessages: [target] } };
		const input = recoveryInput({ openOperations: [operation], records: [operation] });
		expect(reduceLaneState(input).laneState.operation?.missingInitialMessages).toEqual([target]);
		expect(reduceLaneState(input).effectiveConfiguration.modelControls).toEqual({ processingTier: "priority" });
		const committed: ModelControlsEntry = { ...target, seq: 2, timestamp: 2, parentId: null };
		input.entries = [committed];
		input.ownEntries = [committed];
		expect(reduceLaneState(input).laneState.operation?.missingInitialMessages).toEqual([]);
		expect(reduceLaneState(input).effectiveConfiguration.modelControls).toEqual({});
	});

	it.each(["entries", "ownEntries", "configurationEntries"] as const)("rejects malformed controls in %s", (field) => {
		const malformed = controlsEntry({ reasoningBudget: "1024" } as unknown as ModelControls);
		expect(() => reduceLaneState(recoveryInput({ [field]: [malformed] }))).toThrow("Invalid session model controls");
	});

	it("does not treat a missing selection as an explicit clear", () => {
		const missing = controlsEntry(undefined as unknown as ModelControls);
		expect(() => readSessionModelControls([missing])).toThrow(ModelControlsError);
		expect(readSessionModelControls([])).toBeUndefined();
	});
});

describe("native controls at storage boundaries", () => {
	it.each(["memory", "jsonl"] as const)("rejects direct invalid %s writes before mutation", async (kind) => {
		const root = createTempDir();
		const path = join(root, "session.jsonl");
		const storage =
			kind === "memory"
				? new InMemorySessionStorage({ id: "test", createdAt: 1 })
				: await JsonlSessionStorage.create(new NodeExecutionEnv({ cwd: root }), path, {
						kind: "header",
						version: 4,
						id: "test",
						createdAt: 1,
						cwd: root,
					});
		const before = kind === "jsonl" ? readFileSync(path, "utf8") : undefined;
		const target = {
			type: "model_controls_change",
			id: "bad",
			modelControls: { reasoningBudget: "1024" },
		} as unknown as ProvisionedEntry;
		await expect(storage.appendEntry(target, "main")).rejects.toThrow("Invalid session model controls");
		await expect(
			storage.appendRecord({ type: "queue_enqueued", id: "queue", lane: "main", queue: "nextRun", target }),
		).rejects.toThrow("Invalid session model controls");
		expect(await storage.getLog()).toEqual([]);
		expect(await storage.getLanes()).toEqual([{ lane: "main", leafId: null }]);
		if (kind === "jsonl") expect(readFileSync(path, "utf8")).toBe(before);
		expect(
			(await storage.appendEntry({ type: "model_controls_change", id: "valid", modelControls: {} }, "main")).seq,
		).toBe(1);
	});

	it.each(["entry", "initial", "queue", "deferred"] as const)(
		"rejects a corrupt final %s without truncating acknowledged data",
		async (kind) => {
			const root = createTempDir();
			const path = join(root, "session.jsonl");
			const target = { type: "model_controls_change", id: "bad", modelControls: { reasoningBudget: "1024" } };
			const payload =
				kind === "entry"
					? { kind: "entry", ...target, parentId: null }
					: {
							kind: "record",
							id: "record",
							lane: "main",
							...(kind === "initial"
								? {
										type: "operation_started",
										sourceLeafId: null,
										intent: { kind: "run", originalPrompt: [], initialMessages: [target] },
									}
								: kind === "queue"
									? { type: "queue_enqueued", queue: "nextRun", target }
									: { type: "write_deferred", runId: "run", target }),
						};
			const line = JSON.stringify({ ...payload, seq: 1, timestamp: 1 });
			const decoded = parseMutation(line);
			expect(decoded).toMatchObject({ ok: false, error: { kind: "schema" } });
			const content = `${JSON.stringify({ kind: "header", version: 4, id: "test", createdAt: 1, cwd: root })}\n${line}`;
			writeFileSync(path, content);
			await expect(JsonlSessionStorage.load(new NodeExecutionEnv({ cwd: root }), path)).rejects.toMatchObject({
				code: "invalid_entry",
			});
			expect(readFileSync(path, "utf8")).toBe(content);
		},
	);

	it.each([
		{ type: "operation_started", intent: { kind: "run" } },
		{ type: "queue_enqueued", target: null },
		{ type: "write_deferred" },
	])("reports malformed provisioned containers as schema errors: %j", (record) => {
		expect(
			parseMutation(JSON.stringify({ kind: "record", id: "bad", seq: 1, timestamp: 1, lane: "main", ...record })),
		).toMatchObject({ ok: false, error: { kind: "schema" } });
	});

	it("validates native controls in open operations even when a caller omits them from records", () => {
		const record: NewRecord = {
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: null,
			intent: {
				kind: "run",
				originalPrompt: [],
				initialMessages: [
					{ type: "model_controls_change", id: "bad", modelControls: [] as unknown as ModelControls },
				],
			},
		};
		expect(() => reduceLaneState(recoveryInput({ openOperations: [{ ...record, seq: 1, timestamp: 1 }] }))).toThrow(
			"Invalid session model controls",
		);
	});
});
