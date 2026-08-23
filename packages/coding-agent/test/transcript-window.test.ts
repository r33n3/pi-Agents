import { describe, expect, test } from "vitest";
import { selectTranscriptWindow } from "../src/core/serve/browser/transcript-window.ts";

describe("selectTranscriptWindow", () => {
	test("renders only the newest default window", () => {
		const result = selectTranscriptWindow([1, 2, 3, 4, 5], 0, 3);

		expect(result).toEqual({ items: [3, 4, 5], hiddenCount: 2, visibleCount: 3 });
	});

	test("expands without exceeding the transcript", () => {
		expect(selectTranscriptWindow([1, 2, 3, 4, 5], 4, 2)).toEqual({
			items: [2, 3, 4, 5],
			hiddenCount: 1,
			visibleCount: 4,
		});
		expect(selectTranscriptWindow([1, 2], 20, 2)).toEqual({
			items: [1, 2],
			hiddenCount: 0,
			visibleCount: 2,
		});
	});

	test("rejects an invalid default", () => {
		expect(() => selectTranscriptWindow([], 0, 0)).toThrow("defaultVisibleCount must be a positive integer");
	});
});
