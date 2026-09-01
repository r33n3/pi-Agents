import type { ModelCatalogRefreshStatus, ModelCatalogSnapshot } from "@earendil-works/pi-protocol";

export const catalogSourceLabels = {
	bundled: "bundled catalog",
	"remote-catalog": "remote catalog",
	provider: "provider-supplied catalog",
	"user-config": "private configuration",
	extension: "extension",
} as const;

export function describeModelCatalog(catalog: ModelCatalogSnapshot | undefined): string {
	if (!catalog) return "Model catalog source and age are unknown.";
	const parts = [
		`Source: ${catalogSourceLabels[catalog.source]}${catalog.loadedFrom === "cache" ? " (loaded from cache)" : catalog.loadedFrom === "refresh" ? " (refreshed)" : ""}.`,
	];
	for (const [label, value] of [
		["Generated/modified", catalog.generatedAt],
		["Last successful catalog check", catalog.checkedAt],
	] as const) {
		if (value !== undefined && Number.isFinite(new Date(value).getTime()))
			parts.push(`${label}: ${new Date(value).toISOString()}.`);
	}
	parts.push(
		catalog.freshness === "refresh-due"
			? "Source refresh is due; retained catalog data is in use."
			: catalog.freshness === "within-refresh-window"
				? "Source is inside its catalog refresh window; this is not capability verification."
				: "Source freshness is unknown.",
	);
	if (catalog.timestampWarning)
		parts.push("The source reports a future timestamp; check the host clock and catalog source.");
	if (catalog.overrides?.length)
		parts.push(
			`Overrides, in application order: ${catalog.overrides.map((source) => catalogSourceLabels[source]).join(" → ")}. Source dates do not verify these overrides.`,
		);
	parts.push("Catalog dates do not establish capability review dates or account access.");
	return parts.join(" ");
}

/** Catalog pass results cannot establish per-model freshness, access, or a live network check. */
export function describeCatalogRefresh(status: ModelCatalogRefreshStatus | undefined): string {
	if (!status) return "Catalog refresh status unavailable. Model freshness and account access not verified.";
	const scope = status.mode === "cache-only" ? "Cache-only catalog pass" : "Catalog pass (network allowed)";
	const outcome = status.failed
		? "failed; last available models retained"
		: status.warning
			? "completed with a recoverable warning"
			: "completed";
	const warning = status.failed && status.warning ? " A recoverable warning was also reported." : "";
	const guidance =
		status.failed || status.warning
			? " Retry the catalog refresh; if it persists, review the host model provider and cache configuration."
			: "";
	const date = new Date(status.completedAt);
	const time = Number.isFinite(date.getTime()) ? ` at ${date.toISOString()}` : " (time unavailable)";
	return `${scope} ${outcome}${time}.${warning}${guidance} Model freshness and account access not verified.`;
}
