import { describe, expect, it } from "vitest";
import { splitInlineThinking } from "../src/core/serve/browser/inline-thinking.ts";

describe("splitInlineThinking", () => {
	it("separates literal thinking tags from the visible answer", () => {
		expect(splitInlineThinking("<thinking>Check the tools.</thinking>\nThe agent is ready.")).toEqual([
			{ type: "thinking", text: "Check the tools." },
			{ type: "text", text: "\nThe agent is ready." },
		]);
	});

	it("supports think tags and an unfinished streaming block", () => {
		expect(splitInlineThinking("Before<think>Private reasoning</think>After")).toEqual([
			{ type: "text", text: "Before" },
			{ type: "thinking", text: "Private reasoning" },
			{ type: "text", text: "After" },
		]);
		expect(splitInlineThinking("<thinking>Still working")).toEqual([{ type: "thinking", text: "Still working" }]);
	});

	it("leaves ordinary text unchanged", () => {
		expect(splitInlineThinking("Final answer")).toEqual([{ type: "text", text: "Final answer" }]);
	});
});
