import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ClaudeSubscriptionLogin } from "../src/core/serve/claude-subscription-login.ts";

const roots: string[] = [];
const originalApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(async () => {
	if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = originalApiKey;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ClaudeSubscriptionLogin", () => {
	test("runs subscription login without an inherited API key and captures the authorization URL", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-claude-login-"));
		roots.push(root);
		const script = join(root, "login.mjs");
		const authenticated = join(root, "authenticated");
		await writeFile(
			script,
			[
				'import { writeFileSync } from "node:fs";',
				"if (process.env.ANTHROPIC_API_KEY) process.exit(2);",
				'process.stdout.write("Open https://example.test/authorize?id=one\\n");',
				`writeFileSync(${JSON.stringify(authenticated)}, "ready");`,
			].join("\n"),
			"utf8",
		);
		process.env.ANTHROPIC_API_KEY = "must-not-leak";
		const login = new ClaudeSubscriptionLogin({
			command: { executable: process.execPath, prefix: [script] },
			isAuthenticated: () => existsSync(authenticated),
			timeoutMs: 2_000,
		});

		expect(login.start().status).toBe("running");
		const status = await waitForCompletion(login);
		expect(status).toMatchObject({
			status: "succeeded",
			authenticated: true,
			authorizationUrl: "https://example.test/authorize?id=one",
		});
		await login.dispose();
	});
});

async function waitForCompletion(login: ClaudeSubscriptionLogin) {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const status = login.getStatus();
		if (status.status !== "running") return status;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Claude login did not complete");
}
