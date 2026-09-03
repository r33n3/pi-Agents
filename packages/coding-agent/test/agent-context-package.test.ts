import { describe, expect, test } from "vitest";
import {
	assertAgentContextPackageIntegrity,
	createAgentContextPackage,
	renderAgentContextPrompt,
} from "../src/core/serve/agent-context-package.ts";

describe("agent context package", () => {
	test("keeps the newest bounded messages and produces a stable digest", () => {
		const input = {
			conversationId: "inbox-1",
			contextEpoch: 2,
			messages: [
				{ sequence: 1, author: { kind: "user" as const, id: "local-user" as const }, text: "old" },
				{ sequence: 2, author: { kind: "user" as const, id: "local-user" as const }, text: "new" },
			],
			goal: "Continue",
			maxMessages: 1,
		};
		const first = createAgentContextPackage(input);
		const second = createAgentContextPackage(input);
		expect(first.messages).toEqual([expect.objectContaining({ sequence: 2, text: "new" })]);
		expect(first.digest).toBe(second.digest);
		expect(renderAgentContextPrompt(first)).toContain("Current goal:\nContinue");
	});

	test("detects context mutation", () => {
		const context = createAgentContextPackage({
			conversationId: "inbox-1",
			contextEpoch: 1,
			messages: [],
			goal: "Original",
		});
		const changed = structuredClone(context);
		changed.goal = "Changed";
		expect(() => assertAgentContextPackageIntegrity(changed)).toThrow("digest does not match");
	});
});
