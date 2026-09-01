import { getModelControlCapabilityErrors } from "./model-controls.ts";
import { MODEL_THINKING_LEVELS } from "./models.ts";
import type { ModelsStoreEntry } from "./models-store.ts";
import type { Api, Model } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRates(value: unknown, path: string, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be an object`);
		return;
	}
	if (value.status !== undefined && value.status !== "estimated" && value.status !== "unknown")
		errors.push(`${path}.status must be estimated or unknown`);
	for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
		const rate = value[field];
		// Existing router catalogs encode unknown prices as negative numbers.
		// Preserve them here; callers must not interpret them as verified rates.
		if (typeof rate !== "number" || !Number.isFinite(rate)) {
			errors.push(`${path}.${field} must be a finite number`);
		}
	}
}

/**
 * Structural checks shared by generated and refreshed chat-model catalogs.
 * Passing does not verify provider support, account access, prices, or arbitrary
 * provider-specific compat/sampling values. Errors contain paths, never values.
 */
export function getModelMetadataErrors(value: unknown): string[] {
	if (!isRecord(value)) return ["model must be an object"];
	const errors: string[] = [];
	if (value.controls !== undefined) errors.push(...getModelControlCapabilityErrors(value.controls));
	for (const field of ["id", "name", "provider", "api"]) {
		if (typeof value[field] !== "string" || value[field].trim().length === 0) {
			errors.push(`${field} must be a non-empty string`);
		}
	}
	// Cloud adapters can resolve an empty base URL from their authenticated environment.
	if (typeof value.baseUrl !== "string") errors.push("baseUrl must be a string");
	if (typeof value.reasoning !== "boolean") errors.push("reasoning must be a boolean");
	if (
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		value.input.some((input) => input !== "text" && input !== "image")
	) {
		errors.push("input must be a non-empty array of supported modalities (text, image)");
	}
	for (const field of ["contextWindow", "maxTokens"]) {
		const limit = value[field];
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
			errors.push(`${field} must be a positive safe integer`);
		}
	}
	validateRates(value.cost, "cost", errors);
	if (isRecord(value.cost) && value.cost.tiers !== undefined) {
		if (!Array.isArray(value.cost.tiers)) errors.push("cost.tiers must be an array");
		else {
			const thresholds = new Set<number>();
			for (const [index, tier] of value.cost.tiers.entries()) {
				validateRates(tier, `cost.tiers[${index}]`, errors);
				const threshold = isRecord(tier) ? tier.inputTokensAbove : undefined;
				if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold < 0) {
					errors.push(`cost.tiers[${index}].inputTokensAbove must be a non-negative safe integer`);
				} else if (thresholds.has(threshold)) errors.push(`cost.tiers[${index}] has a duplicate threshold`);
				else thresholds.add(threshold);
			}
		}
	}
	if (value.thinkingLevelMap !== undefined) {
		const map = value.thinkingLevelMap;
		if (!isRecord(map)) errors.push("thinkingLevelMap must be an object");
		else {
			for (const [level, mapped] of Object.entries(map)) {
				if (!MODEL_THINKING_LEVELS.some((known) => known === level))
					errors.push("thinkingLevelMap contains an unknown Pi level");
				if (mapped !== null && (typeof mapped !== "string" || mapped.trim().length === 0)) {
					errors.push("thinkingLevelMap values must be non-empty strings or null");
				}
			}
			if (
				value.reasoning === true &&
				!MODEL_THINKING_LEVELS.some(
					(level) =>
						map[level] !== null && ((level !== "xhigh" && level !== "max") || typeof map[level] === "string"),
				)
			) {
				errors.push("thinkingLevelMap must allow at least one level");
			}
		}
	}
	for (const field of ["compat", "samplingParams", "headers"]) {
		if (value[field] !== undefined && !isRecord(value[field])) errors.push(`${field} must be an object`);
	}
	if (isRecord(value.headers) && Object.values(value.headers).some((header) => typeof header !== "string")) {
		errors.push("headers values must be strings");
	}
	return errors;
}

/** Reject the complete snapshot on invalid entries; never publish a partial catalog. */
export function validateModelCatalog(providerId: string, value: unknown): asserts value is readonly Model<Api>[] {
	if (!Array.isArray(value)) throw new Error("Model catalog must be an array");
	const ids = new Set<string>();
	for (const [index, entry] of value.entries()) {
		const errors = getModelMetadataErrors(entry);
		if (errors.length) throw new Error(`Invalid model catalog at entry ${index}: ${errors.join("; ")}`);
		const model = entry as Model<Api>;
		if (model.provider !== providerId) throw new Error(`Model catalog provider mismatch at entry ${index}`);
		if (ids.has(model.id)) throw new Error(`Duplicate model ID in catalog at entry ${index}`);
		ids.add(model.id);
	}
}

/** Validate cache bodies and HTTP validator metadata before restoring or revalidating them. */
export function validateModelsStoreEntry(providerId: string, value: unknown): asserts value is ModelsStoreEntry {
	if (!isRecord(value)) throw new Error("Cached model catalog must be an object");
	validateModelCatalog(providerId, value.models);
	for (const key of ["checkedAt", "lastModified", "validatedAt"] as const) {
		const timestamp = value[key];
		if (
			timestamp !== undefined &&
			(typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0)
		)
			throw new Error(`Cached model catalog ${key} must be a non-negative safe integer`);
	}
	if (value.etag !== undefined && (typeof value.etag !== "string" || /[\r\n\0]/.test(value.etag)))
		throw new Error("Cached model catalog etag must be a valid header value");
}
