import { describe, expect, test } from "vitest";
import { ANTHROPIC_MODELS } from "../../ai/src/providers/anthropic.models.ts";
import { toProtocolModelMetadata } from "../../server/src/protocol.ts";
import {
	describeModelControls,
	type ModelSettingsSelection,
	mergeModelSettingsDraft,
	modelSettingsButtonPresentation,
	modelSettingsError,
	parseModelControls,
} from "../src/core/serve/browser/model-settings.ts";
import { NATIVE_UI_MODELS } from "./fixtures/native-ui-models.ts";

const selection: ModelSettingsSelection = {
	model: { provider: "fixture", id: "native" },
	thinkingLevel: "high",
	modelControls: {},
};
describe("browser model settings projection", () => {
	test("does not infer native options from an authenticated connection without evidence", () => {
		const current = {
			...selection,
			model: { provider: "fixture", id: "connection-unverified" },
			modelControls: { processingTier: "fast" },
		};
		expect(modelSettingsError(current, NATIVE_UI_MODELS)).toContain("not supported");
		expect(current.modelControls).toEqual({ processingTier: "fast" });
		expect(modelSettingsError({ ...current, modelControls: {} }, NATIVE_UI_MODELS)).toBeUndefined();
	});
	test.each(["claude-opus-5", "claude-opus-4-8"] as const)(
		"uses the actual %s Fast capabilities for chat and Builder edits",
		(id) => {
			const models = Object.values(ANTHROPIC_MODELS).map((model) => toProtocolModelMetadata(model, false));
			expect(models.find((model) => model.id === id)?.controls?.processingTier?.guidance).toContain(
				"does not establish eligibility",
			);
			const current: ModelSettingsSelection = {
				model: { provider: "anthropic", id },
				thinkingLevel: "high",
				modelControls: { reasoningEffort: "low" },
			};
			for (const processingTier of ["standard", "fast"]) {
				const next = mergeModelSettingsDraft(
					current,
					{ modelControls: { reasoningEffort: "low", processingTier } },
					models,
				);
				expect(next.modelControls).toEqual({ reasoningEffort: "low", processingTier });
				expect(modelSettingsError(next, models)).toBeUndefined();
				expect(() => mergeModelSettingsDraft(next, { model: "anthropic/claude-opus-4-7" }, models)).toThrow(
					"not supported",
				);
				expect(
					mergeModelSettingsDraft(next, { model: "anthropic/claude-opus-4-7", modelControls: {} }, models)
						.modelControls,
				).toEqual({});
			}
			expect(current.modelControls).toEqual({ reasoningEffort: "low" });
			expect(() =>
				mergeModelSettingsDraft(current, { modelControls: { processingTier: "priority" } }, models),
			).toThrow("not supported");
			expect(models.every((model) => model.authenticated === false)).toBe(true);
		},
	);
	test("preserves settings during partial edits and supports explicit defaults or legacy replacement", () => {
		const current = { ...selection, modelControls: { reasoningEffort: "high", processingTier: "default" } };
		expect(mergeModelSettingsDraft(current, { description: "edited" }, NATIVE_UI_MODELS)).toEqual(current);
		expect(mergeModelSettingsDraft(current, { modelControls: {} }, NATIVE_UI_MODELS).modelControls).toEqual({});
		expect(mergeModelSettingsDraft(current, { modelControls: null }, NATIVE_UI_MODELS).modelControls).toBeUndefined();
		expect(mergeModelSettingsDraft(current, { thinking: "low" }, NATIVE_UI_MODELS)).toMatchObject({
			thinkingLevel: "low",
			modelControls: undefined,
		});
		expect(current.modelControls).toEqual({ reasoningEffort: "high", processingTier: "default" });
	});
	test.each([
		{ thinking: "invented" },
		{ thinking: "low", modelControls: {} },
		{ model: "fixture/legacy" },
		{ model: "removed" },
		{ model: { provider: "fixture", id: "legacy" } },
		{ modelControls: { processingTier: "invented" } },
	])("rejects a bad chat edit atomically: %j", (draft) => {
		const current = { ...selection, modelControls: { reasoningEffort: "high" } };
		expect(() => mergeModelSettingsDraft(current, draft, NATIVE_UI_MODELS)).toThrow();
		expect(current).toEqual({ ...selection, modelControls: { reasoningEffort: "high" } });
	});
	test("keeps legacy, provider defaults, and explicit selections distinct", () => {
		expect(describeModelControls(undefined)).toBe("Legacy thinking mapping");
		expect(describeModelControls({})).toContain("no explicit overrides");
		expect(describeModelControls({ reasoningEffort: "low", processingTier: "fast" })).toBe(
			"Effort: low · Processing: fast",
		);
		expect(modelSettingsError(selection, NATIVE_UI_MODELS)).toBeUndefined();
	});
	test("presents unavailable, available, and active model-settings gear states", () => {
		const legacy = NATIVE_UI_MODELS.find((model) => model.id === "legacy");
		const native = NATIVE_UI_MODELS.find((model) => model.id === "native");
		expect(modelSettingsButtonPresentation(legacy, undefined)).toMatchObject({
			state: "unavailable",
			disabled: true,
		});
		expect(modelSettingsButtonPresentation(native, undefined)).toMatchObject({
			state: "available",
			disabled: false,
		});
		expect(modelSettingsButtonPresentation(native, {})).toMatchObject({
			state: "available",
			disabled: false,
		});
		expect(modelSettingsButtonPresentation(native, { processingTier: "fast" })).toMatchObject({
			state: "active",
			disabled: false,
		});
		expect(modelSettingsButtonPresentation(undefined, { processingTier: "removed" })).toMatchObject({
			state: "active",
			disabled: false,
		});
	});
	test("copies exact values without inferring premiums or normalizing spellings", () => {
		const original = { reasoningEffort: "high" };
		const parsed = parseModelControls(original);
		expect(parsed).toEqual(original);
		expect(parsed).not.toBe(original);
		expect(parseModelControls({})).toEqual({});
		expect(
			modelSettingsError({ ...selection, modelControls: { reasoningEffort: "HIGH" } }, NATIVE_UI_MODELS),
		).toContain("not supported");
	});
	test.each([
		null,
		[],
		"high",
		{ speed: "fast" },
		{ reasoningMode: "" },
		{ processingTier: 2 },
		{ reasoningBudget: -2 },
		{ reasoningBudget: 1.5 },
		{ reasoningBudget: Number.NaN },
		{ reasoningBudget: Number.MAX_SAFE_INTEGER + 1 },
	])("rejects malformed marker controls %j", (value) => {
		expect(() => parseModelControls(value)).toThrow();
	});
	test.each([-1, 0, 512, 4096])("accepts only supported special or bounded budgets: %s", (reasoningBudget) => {
		expect(
			modelSettingsError({ ...selection, modelControls: { reasoningBudget } }, NATIVE_UI_MODELS),
		).toBeUndefined();
	});
	test.each([1, 511, 4097])("rejects out-of-range budgets without clamping: %s", (reasoningBudget) => {
		const controls = { reasoningBudget };
		expect(modelSettingsError({ ...selection, modelControls: controls }, NATIVE_UI_MODELS)).toContain(
			"budget must be",
		);
		expect(controls).toEqual({ reasoningBudget });
	});
	test("requires an explicit native model and retains unsupported saved controls for correction", () => {
		expect(modelSettingsError({ ...selection, model: undefined }, NATIVE_UI_MODELS)).toContain("explicit model");
		expect(
			modelSettingsError({ ...selection, model: { provider: "fixture", id: "removed" } }, NATIVE_UI_MODELS),
		).toContain("not in the current catalog");
		const saved = {
			...selection,
			model: { provider: "fixture", id: "legacy" },
			modelControls: { processingTier: "fast" },
		};
		expect(modelSettingsError(saved, NATIVE_UI_MODELS)).toContain("not supported");
		expect(saved.modelControls).toEqual({ processingTier: "fast" });
		expect(modelSettingsError({ ...saved, modelControls: {} }, NATIVE_UI_MODELS)).toBeUndefined();
	});
	test("validates legacy levels independently of native controls", () => {
		const legacy = { ...selection, model: { provider: "fixture", id: "legacy" }, modelControls: undefined };
		expect(modelSettingsError(legacy, NATIVE_UI_MODELS)).toContain("legacy thinking level high");
		expect(modelSettingsError({ ...legacy, thinkingLevel: "off" }, NATIVE_UI_MODELS)).toBeUndefined();
	});
});
