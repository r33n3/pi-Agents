/** Catalog lineage, not proof of capability support or account access. No private references belong here. */
export interface ModelCatalogProvenance {
	source: "bundled" | "remote-catalog" | "provider" | "user-config" | "extension";
	loadedFrom?: "cache" | "refresh";
	/** Bundle generation / remote Last-Modified time, not a capability review date. Unix milliseconds. */
	generatedAt?: number;
	/** Last successful catalog-body retrieval or revalidation. Unix milliseconds. */
	checkedAt?: number;
	/** Source-owned reuse policy. Being inside this window does not verify model capabilities. */
	refreshIntervalMs?: number;
	/** Partial overlays, in application order. A replacement model has its own source instead. */
	overrides?: ("user-config" | "extension")[];
}

export interface ModelCatalogSnapshot extends ModelCatalogProvenance {
	freshness: "unknown" | "within-refresh-window" | "refresh-due";
	timestampWarning?: "future";
}

/** Allowlist provider metadata for clients; malformed provenance stays unknown without blocking models. */
export function getModelCatalogSnapshot(value: unknown, now = Date.now()): ModelCatalogSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (
		typeof input.source !== "string" ||
		!["bundled", "remote-catalog", "provider", "user-config", "extension"].includes(input.source)
	)
		return undefined;
	const result: ModelCatalogSnapshot = {
		source: input.source as ModelCatalogProvenance["source"],
		freshness: "unknown",
	};
	if (input.loadedFrom !== undefined) {
		if (input.loadedFrom !== "cache" && input.loadedFrom !== "refresh") return undefined;
		result.loadedFrom = input.loadedFrom;
	}
	for (const key of ["generatedAt", "checkedAt", "refreshIntervalMs"] as const) {
		const number = input[key];
		if (number === undefined) continue;
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > 8_640_000_000_000_000)
			return undefined;
		if (key === "refreshIntervalMs" && number === 0) return undefined;
		result[key] = number;
	}
	if (input.overrides !== undefined) {
		if (!Array.isArray(input.overrides)) return undefined;
		result.overrides = [];
		for (const source of input.overrides) {
			if (source !== "user-config" && source !== "extension") return undefined;
			result.overrides.push(source);
		}
	}
	if (Number.isSafeInteger(now) && ((result.checkedAt ?? 0) > now || (result.generatedAt ?? 0) > now)) {
		result.timestampWarning = "future";
	}
	if (
		Number.isSafeInteger(now) &&
		!result.timestampWarning &&
		result.checkedAt !== undefined &&
		result.refreshIntervalMs !== undefined &&
		result.checkedAt <= now
	) {
		result.freshness = now - result.checkedAt < result.refreshIntervalMs ? "within-refresh-window" : "refresh-due";
	}
	return result;
}
