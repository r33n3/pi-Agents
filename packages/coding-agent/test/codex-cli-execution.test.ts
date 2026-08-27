import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	CodexCliExecution,
	isCodexCliAvailable,
	isCodexSubscriptionAvailable,
} from "../src/core/serve/codex-cli-execution.ts";

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(async () => {
	process.env.PATH = originalPath;
	if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
	else process.env.OPENAI_API_KEY = originalApiKey;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CodexCliExecution", () => {
	test.runIf(process.platform === "win32")(
		"uses the Codex CLI login without passing an inherited OpenAI API key",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-codex-cli-"));
			roots.push(root);
			const bin = join(root, "node_modules", "@openai", "codex", "bin");
			await mkdir(bin, { recursive: true });
			await writeFile(
				join(bin, "codex.js"),
				[
					"const payload = { args: process.argv.slice(2), apiKey: process.env.OPENAI_API_KEY ?? null };",
					'process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(payload) } }) + "\\n");',
				].join("\n"),
				"utf8",
			);
			process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
			process.env.OPENAI_API_KEY = "must-not-leak";
			expect(isCodexCliAvailable()).toBe(true);

			const execution = new CodexCliExecution({ cwd: root, prompt: "Inspect", model: "gpt-5.6-luna" });
			const result = await execution.result;
			const payload: unknown = JSON.parse(result.output);
			expect(payload).toMatchObject({ apiKey: null });
			expect(payload).toMatchObject({
				args: expect.arrayContaining(["exec", "--model", "gpt-5.6-luna", "Inspect"]),
			});
			await execution.dispose();
		},
	);

	test.runIf(process.platform === "win32")("detects a ChatGPT subscription login without an API key", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-codex-auth-"));
		roots.push(root);
		const bin = join(root, "node_modules", "@openai", "codex", "bin");
		await mkdir(bin, { recursive: true });
		await writeFile(
			join(bin, "codex.js"),
			[
				'if (process.argv.slice(2).join(" ") === "login status" && !process.env.OPENAI_API_KEY) {',
				'  process.stdout.write("Logged in using ChatGPT\\n");',
				"  process.exit(0);",
				"}",
				"process.exit(1);",
			].join("\n"),
			"utf8",
		);
		process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
		process.env.OPENAI_API_KEY = "must-not-leak";

		expect(isCodexSubscriptionAvailable()).toBe(true);
	});
});
