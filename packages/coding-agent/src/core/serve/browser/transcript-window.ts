export interface TranscriptWindow<T> {
	items: readonly T[];
	hiddenCount: number;
	visibleCount: number;
}

/** Keeps initial and streaming renders bounded while retaining the full snapshot in client state. */
export function selectTranscriptWindow<T>(
	items: readonly T[],
	requestedVisibleCount: number,
	defaultVisibleCount: number,
): TranscriptWindow<T> {
	const normalizedDefault = positiveInteger(defaultVisibleCount, "defaultVisibleCount");
	const normalizedRequested = Number.isSafeInteger(requestedVisibleCount)
		? Math.max(normalizedDefault, requestedVisibleCount)
		: normalizedDefault;
	const visibleCount = Math.min(items.length, normalizedRequested);
	const hiddenCount = items.length - visibleCount;
	return {
		items: items.slice(hiddenCount),
		hiddenCount,
		visibleCount,
	};
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
	return value;
}
