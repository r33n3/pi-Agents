import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { auditModelCapabilities } from "./audit-model-capabilities.mjs";

const model = {
	id: "test", name: "Test", provider: "example", api: "openai-responses", baseUrl: "https://example.test",
	reasoning: true, input: ["text"], contextWindow: 1000, maxTokens: 100,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};

test("distinguishes inherited defaults from explicit model mappings without claiming verification", () => {
	const audit = auditModelCapabilities({ example: { test: model } }, "2026-08-31T00:00:00Z");
	assert.equal(audit.summary.inheritedThinkingModels, 1);
	assert.deepEqual(audit.entries[0].inheritedThinkingLevels, ["off", "minimal", "low", "medium", "high"]);
	assert.equal(audit.entries[0].verification, "catalog-only");
	assert.equal(audit.entries[0].accountAccess, "not-checked");
	assert.equal(audit.entries[0].liveRequest, "not-tested");
});

test("reports remapping and rejects invalid metadata", () => {
	const audit = auditModelCapabilities({ example: {
		test: { ...model, thinkingLevelMap: { high: "max" } },
		invalid: { ...model, id: "invalid", maxTokens: 0 },
	} }, "2026-08-31T00:00:00Z");
	assert.equal(audit.summary.invalidModels, 1);
	assert.deepEqual(audit.entries.find((entry) => entry.id === "test").mappedThinkingLevels, { high: "max" });
});

test("does not include endpoints, headers, or arbitrary sampling payloads", () => {
	const audit = auditModelCapabilities({ example: { test: {
		...model, baseUrl: "https://private-endpoint.test", headers: { Authorization: "private-key" },
		samplingParams: { secret: "private-payload" },
	} } }, "2026-08-31T00:00:00Z");
	assert.doesNotMatch(JSON.stringify(audit), /private-endpoint|private-key|private-payload/);
});

test("preserves legacy router price sentinels but reports prices as unknown", () => {
	const audit = auditModelCapabilities({ example: { test: { ...model, cost: { ...model.cost, input: -1_000_000 } } } }, "2026-08-31T00:00:00Z");
	assert.equal(audit.entries[0].pricing, "unknown");
	assert.equal(audit.summary.unknownPricingModels, 1);
	assert.equal(audit.summary.invalidModels, 0);
});

test("discloses native control coverage without implying whole-model or account verification", () => {
	const google = { ...model, id: "gemini-3.7-flash", provider: "google", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
	const audit = auditModelCapabilities({ google: { [google.id]: google } }, "2026-08-31T00:00:00Z");
	assert.equal(audit.summary.nativeControlModels, 1);
	assert.deepEqual(audit.summary.nativeControlCounts, { reasoningMode: 0, reasoningEffort: 1, reasoningBudget: 0, processingTier: 0 });
	assert.deepEqual(audit.entries[0].nativeControls.reasoningEffort.values, ["low", "medium", "high"]);
	assert.equal(audit.entries[0].nativeControls.reasoningEffort.evidenceKind, "provider-docs");
	assert.equal(audit.entries[0].verification, "catalog-only");
	assert.equal(audit.entries[0].accountAccess, "not-checked");
});

test("does not print arbitrary override evidence references and distinguishes missing prices from explicit zero", () => {
	const entry = { ...model, controls: { reasoningEffort: { values: ["low"], evidence: { kind: "user-override", reference: "private-reference-token", checkedAt: "2026-08-31" } } }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
	const audit = auditModelCapabilities({ example: { test: entry, free: { ...entry, id: "free", cost: { ...entry.cost, status: "estimated" } } } }, "2026-08-31T00:00:00Z");
	assert.doesNotMatch(JSON.stringify(audit), /private-reference-token/);
	assert.equal(audit.summary.unknownPricingModels, 1);
	assert.equal(audit.entries.find((entry) => entry.id === "free").pricing, "estimated");
});

test("CLI inventories the complete bundled catalog as parseable JSON", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./audit-model-capabilities.mjs", import.meta.url)), "--json"], {
		encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
	});
	assert.equal(result.status, 0, result.stderr);
	const audit = JSON.parse(result.stdout);
	assert.ok(audit.summary.models > 0);
	assert.equal(audit.summary.models, audit.entries.length);
	assert.equal(audit.summary.invalidModels, 0);
});
