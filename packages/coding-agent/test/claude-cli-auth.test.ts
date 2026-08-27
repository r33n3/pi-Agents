import { describe, expect, test } from "vitest";
import { parseClaudeSubscriptionStatus } from "../src/core/serve/claude-cli-auth.ts";

describe("Claude CLI subscription authentication", () => {
	test("accepts a non-API-key login", () => {
		expect(parseClaudeSubscriptionStatus('{"loggedIn":true,"authMethod":"claude.ai"}')).toBe(true);
	});

	test("rejects API-key authentication and missing logins", () => {
		expect(parseClaudeSubscriptionStatus('{"loggedIn":true,"authMethod":"api_key"}')).toBe(false);
		expect(parseClaudeSubscriptionStatus('{"loggedIn":false,"authMethod":"none"}')).toBe(false);
	});
});
