import {
	type ModelCatalogRefreshStatus,
	ModelCatalogRefreshStatusSchema,
	type ModelCatalogSnapshot,
	ModelCatalogSnapshotSchema,
} from "@earendil-works/pi-protocol";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { describeCatalogRefresh, describeModelCatalog } from "../src/core/serve/browser/model-catalog-status.ts";

const status: ModelCatalogRefreshStatus = {
	mode: "cache-only",
	completedAt: Date.parse("2026-08-31T12:00:00Z"),
	failed: false,
	warning: false,
};

describe("catalog status presentation", () => {
	it("separates cache source, refresh age, overrides, and capability/account verification", () => {
		const catalog: ModelCatalogSnapshot = {
			source: "remote-catalog",
			loadedFrom: "cache",
			checkedAt: status.completedAt,
			freshness: "refresh-due",
			overrides: ["extension", "user-config"],
		};
		expect(Compile(ModelCatalogSnapshotSchema).Check(catalog)).toBe(true);
		const text = describeModelCatalog(catalog);
		expect(text).toContain("remote catalog (loaded from cache)");
		expect(text).toContain("Source refresh is due");
		expect(text).toContain("extension → private configuration");
		expect(text).toContain("Source dates do not verify these overrides");
		expect(text).toContain("Catalog dates do not establish capability review dates or account access");
		expect(describeModelCatalog({ ...catalog, freshness: "within-refresh-window" })).toContain(
			"this is not capability verification",
		);
		expect(describeModelCatalog(undefined)).toBe("Model catalog source and age are unknown.");
		expect(describeModelCatalog({ ...catalog, freshness: "unknown", timestampWarning: "future" })).toContain(
			"source reports a future timestamp",
		);
	});
	it("rejects private or invented verified catalog fields at the protocol boundary", () => {
		const check = Compile(ModelCatalogSnapshotSchema);
		expect(check.Check({ source: "bundled", freshness: "unknown", generatedAt: 1000 })).toBe(true);
		expect(check.Check({ source: "bundled", freshness: "verified" })).toBe(false);
		expect(check.Check({ source: "bundled", freshness: "unknown", path: "private" })).toBe(false);
	});
	it("does not turn unknown status or cache restoration into current metadata or verified access", () => {
		expect(describeCatalogRefresh(undefined)).toBe(
			"Catalog refresh status unavailable. Model freshness and account access not verified.",
		);
		expect(describeCatalogRefresh(status)).toBe(
			"Cache-only catalog pass completed at 2026-08-31T12:00:00.000Z. Model freshness and account access not verified.",
		);
	});
	it("describes network permission without claiming a request was made", () => {
		expect(describeCatalogRefresh({ ...status, mode: "network-allowed" })).toContain(
			"Catalog pass (network allowed) completed",
		);
	});
	it.each([
		{ failed: true, warning: false },
		{ failed: false, warning: true },
		{ failed: true, warning: true },
	])("offers recovery guidance for %j", (problem) => {
		const text = describeCatalogRefresh({ ...status, ...problem });
		expect(text).toContain("Retry the catalog refresh");
		expect(text).toContain(
			problem.failed ? "failed; last available models retained" : "completed with a recoverable warning",
		);
		if (problem.failed && problem.warning) expect(text).toContain("A recoverable warning was also reported.");
	});
	it("does not crash on an out-of-range timestamp", () => {
		expect(describeCatalogRefresh({ ...status, completedAt: Number.MAX_VALUE })).toContain("time unavailable");
	});
	it("validates the public contract and rejects raw diagnostics and misleading verified status", () => {
		const check = Compile(ModelCatalogRefreshStatusSchema);
		expect(check.Check(status)).toBe(true);
		for (const invalid of [
			{ ...status, error: "https://private.test/?token=secret" },
			{ ...status, cause: { path: "private.json" } },
			{ ...status, mode: "verified" },
			{ ...status, completedAt: -1 },
			{ ...status, failed: "false" },
		])
			expect(check.Check(invalid)).toBe(false);
	});
});
