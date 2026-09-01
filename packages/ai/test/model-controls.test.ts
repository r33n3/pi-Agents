import { describe, expect, it } from "vitest";
import {
	getModelControlCapabilities,
	getModelControlCapabilityErrors,
	validateModelControls,
} from "../src/model-controls.ts";
import { ANTHROPIC_MODELS } from "../src/providers/anthropic.models.ts";
import { OPENAI_MODELS } from "../src/providers/openai.models.ts";

const model = OPENAI_MODELS["gpt-5.6-sol"];

describe("native model controls", () => {
	it("carries provider-specific premium and access guidance without choosing a premium", () => {
		const openai = getModelControlCapabilities(model).processingTier;
		expect(openai?.guidance).toContain("Unset inherits");
		expect(openai?.guidance).toContain("twice Standard");
		expect(openai?.default).toBeUndefined();
		const anthropic = getModelControlCapabilities(ANTHROPIC_MODELS["claude-opus-5"]).processingTier;
		expect(anthropic?.guidance).toContain("restricted research preview");
		expect(anthropic?.guidance).toContain("does not establish eligibility");
		expect(anthropic?.default).toBe("standard");
		const selection = {};
		validateModelControls(model, selection);
		expect(selection).toEqual({});
	});
	it("preserves private guidance without adding first-party pricing or access claims", () => {
		const controls = {
			processingTier: {
				values: ["default"],
				guidance: "Private service: confirm your contracted price.",
				evidence: { kind: "user-override" as const, reference: "synthetic", checkedAt: "2026-08-31" },
			},
		};
		expect(getModelControlCapabilities({ ...model, controls }).processingTier).toEqual(controls.processingTier);
		expect(getModelControlCapabilities({ ...model, provider: "private" }).processingTier).toBeUndefined();
	});
	it.each(["", "x".repeat(2001), 1, {}])("rejects malformed or oversized capability guidance: %j", (guidance) => {
		expect(
			getModelControlCapabilityErrors({
				processingTier: {
					values: ["fast"],
					guidance,
					evidence: { kind: "user-override", reference: "synthetic", checkedAt: "2026-08-31" },
				},
			}),
		).not.toEqual([]);
	});
	it("separates mode, effort, and processing speed with dated evidence", () => {
		const controls = getModelControlCapabilities(model);
		expect(controls.reasoningMode?.values).toEqual(["standard", "pro"]);
		expect(controls.reasoningEffort?.values).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
		expect(controls.processingTier?.values).toEqual(["default", "fast", "priority"]);
		expect(controls.processingTier?.default).toBeUndefined();
		expect(controls.reasoningBudget).toBeUndefined();
		expect(controls.reasoningEffort?.evidence).toMatchObject({ kind: "provider-docs", checkedAt: "2026-08-31" });
	});
	it.each([
		{ provider: "openai-codex", api: "openai-codex-responses" },
		{ provider: "gateway" },
		{ baseUrl: "https://api.openai.com.example.test/v1" },
		{ baseUrl: "https://example.test/v1" },
		{ id: "gpt-5.6-sol-future" },
	])("does not transfer public API claims to other connections: %j", (override) => {
		expect(getModelControlCapabilities({ ...model, ...override })).toEqual({});
	});
	it("keeps explicit private overrides authoritative and returns independent copies", () => {
		const controls = {
			reasoningEffort: {
				values: ["high"],
				evidence: { kind: "user-override" as const, reference: "local test", checkedAt: "2026-08-31" },
			},
		};
		const custom = { ...model, controls };
		expect(getModelControlCapabilities(custom)).toEqual(controls);
		getModelControlCapabilities(custom).reasoningEffort?.values.push("max");
		expect(controls.reasoningEffort.values).toEqual(["high"]);
		expect(() => validateModelControls(custom, { reasoningEffort: "max" })).toThrow("Unsupported reasoningEffort");
	});
	it.each([
		{ reasoningEffort: "ultra" },
		{ reasoningBudget: 1024 },
		{ processingTier: "flex" },
		{ processingTier: true },
		{ unknown: "fast" },
	])("rejects unsupported or invalid options: %j", (controls) => {
		expect(() => validateModelControls(model, controls)).toThrow();
	});
	it("does not insert defaults or remap user selections", () => {
		const controls = { reasoningMode: "pro" };
		validateModelControls(model, controls);
		expect(controls).toEqual({ reasoningMode: "pro" });
	});
	it("intersects declared choices with implemented adapter values without changing private metadata", () => {
		const controls = {
			reasoningEffort: {
				values: ["high", "ultra"],
				default: "ultra",
				evidence: { kind: "user-override" as const, reference: "fixture", checkedAt: "2026-08-31" },
			},
		};
		const custom = { ...model, controls };
		expect(getModelControlCapabilities(custom).reasoningEffort).toEqual({
			values: ["high"],
			evidence: controls.reasoningEffort.evidence,
		});
		expect(controls.reasoningEffort.values).toEqual(["high", "ultra"]);
		expect(controls.reasoningEffort.default).toBe("ultra");
		expect(() => validateModelControls(custom, { reasoningEffort: "ultra" })).toThrow("Unsupported reasoningEffort");
	});
	it("validates capability defaults, ranges, and evidence", () => {
		const evidence = { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" };
		expect(
			getModelControlCapabilityErrors({ reasoningEffort: { values: ["low"], default: "high", evidence } }),
		).not.toEqual([]);
		expect(getModelControlCapabilityErrors({ reasoningBudget: { minimum: 100, maximum: 50, evidence } })).not.toEqual(
			[],
		);
		expect(
			getModelControlCapabilityErrors({
				processingTier: { values: ["fast"], evidence: { ...evidence, checkedAt: "invalid" } },
			}),
		).not.toEqual([]);
	});
	it.each([-1, 0])("requires explicit support for a budget sentinel default %i outside the numeric range", (value) => {
		const budget = {
			minimum: 512,
			maximum: 24576,
			default: value,
			evidence: { kind: "user-override", reference: "fixture", checkedAt: "2026-08-31" },
		};
		expect(getModelControlCapabilityErrors({ reasoningBudget: budget })).not.toEqual([]);
		expect(
			getModelControlCapabilityErrors({
				reasoningBudget: { ...budget, ...(value === -1 ? { automaticValue: -1 } : { disabledValue: 0 }) },
			}),
		).toEqual([]);
	});
});
