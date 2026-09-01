#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { getModelControlCapabilities } from "../packages/ai/src/model-controls.ts";
import { getModelCostStatus } from "../packages/ai/src/model-pricing.ts";
import { getModelMetadataErrors } from "../packages/ai/src/model-validation.ts";
import { getSupportedThinkingLevels, MODEL_THINKING_LEVELS } from "../packages/ai/src/models.ts";
import { MODELS } from "../packages/ai/src/models.generated.ts";
import manifest from "../packages/ai/src/providers/data/.manifest.json" with { type: "json" };

/** Catalog-only inventory. Never reads account credentials, private overrides, or network discovery. */
export function auditModelCapabilities(catalog, generatedAt) {
	const entries = Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)).flatMap(([provider, models]) =>
		Object.entries(models).sort(([a], [b]) => a.localeCompare(b)).map(([id, model]) => {
			const errors = getModelMetadataErrors(model);
			const levels = errors.length === 0 ? getSupportedThinkingLevels(model) : [];
			const capabilities = errors.length === 0 ? getModelControlCapabilities(model) : {};
			const nativeControls = Object.fromEntries(Object.entries(capabilities).filter(([, control]) => control !== undefined).map(([key, control]) => [key, {
				...("values" in control ? { values: control.values } : {
					minimum: control.minimum, maximum: control.maximum,
					automaticValue: control.automaticValue, disabledValue: control.disabledValue,
				}),
				default: control.default, evidenceKind: control.evidence.kind, checkedAt: control.evidence.checkedAt,
			}]));
			const inheritedLevels = model.reasoning ? MODEL_THINKING_LEVELS.filter((level) =>
				level !== "xhigh" && level !== "max" && model.thinkingLevelMap?.[level] === undefined) : [];
			return {
				provider, id, api: model.api, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				nativeControls,
				runtimeThinkingLevels: levels,
				inheritedThinkingLevels: inheritedLevels,
				mappedThinkingLevels: Object.fromEntries(levels.flatMap((level) => {
					const mapped = model.thinkingLevelMap?.[level];
					return mapped !== undefined && mapped !== level ? [[level, mapped]] : [];
				})),
				pricingTiers: model.cost?.tiers?.length ?? 0,
				pricing: [model.cost, ...(model.cost?.tiers ?? [])].some((rates) => !rates || getModelCostStatus(rates) === "unknown") ? "unknown" : "estimated",
				verification: "catalog-only", accountAccess: "not-checked", liveRequest: "not-tested", errors,
			};
		}),
	);
	const providers = Object.keys(catalog).sort().map((provider) => {
		const models = entries.filter((entry) => entry.provider === provider);
		return {
			provider, models: models.length, reasoningModels: models.filter((entry) => entry.reasoning).length,
			inheritedThinkingModels: models.filter((entry) => entry.inheritedThinkingLevels.length > 0).length,
			mappedThinkingModels: models.filter((entry) => Object.keys(entry.mappedThinkingLevels).length > 0).length,
			nativeControlModels: models.filter((entry) => Object.keys(entry.nativeControls).length > 0).length,
			apis: [...new Set(models.map((entry) => entry.api))].sort(),
		};
	});
	return {
		schemaVersion: 2, generatedAt, scope: "bundled-chat-catalog",
		limitations: [
			"Runtime thinking choices are catalog-derived, not provider-verified.",
			"Native controls list adapter-supported choices and evidence dates; this is not whole-model verification or account access.",
			"Unlisted native controls, tool/structured-output support, and retirement status still need verification.",
			"Private overrides, cached catalogs, dynamic providers, image-generation models, and account availability are excluded.",
		],
		summary: {
			providers: providers.length, models: entries.length,
			reasoningModels: entries.filter((entry) => entry.reasoning).length,
			inheritedThinkingModels: entries.filter((entry) => entry.inheritedThinkingLevels.length > 0).length,
			invalidModels: entries.filter((entry) => entry.errors.length > 0).length,
			unknownPricingModels: entries.filter((entry) => entry.pricing === "unknown").length,
			nativeControlModels: entries.filter((entry) => Object.keys(entry.nativeControls).length > 0).length,
			nativeControlCounts: Object.fromEntries(["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"].map((key) => [key, entries.filter((entry) => entry.nativeControls[key] !== undefined).length])),
		}, providers, entries,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const args = process.argv.slice(2);
	if (args.some((arg) => arg !== "--json")) throw new Error("Usage: node scripts/audit-model-capabilities.mjs [--json]");
	const audit = auditModelCapabilities(MODELS, manifest.generatedAt);
	if (args.includes("--json")) console.log(JSON.stringify(audit, null, 2));
	else {
		console.log(`Bundled chat-model catalog generated ${audit.generatedAt}`);
		console.table(audit.providers);
		console.log(JSON.stringify(audit.summary));
		for (const limitation of audit.limitations) console.log(limitation);
	}
	if (audit.summary.invalidModels > 0) process.exitCode = 1;
}
