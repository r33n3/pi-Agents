import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("repository ignore policy keeps user data private without hiding reviewed source", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-ignore-policy-"));
	try {
		const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
		await writeFile(join(root, ".gitignore"), ignore);
		await writeFile(join(root, "empty-excludes"), "");
		await mkdir(join(root, "empty-template"));
		const env = { ...process.env };
		delete env.GIT_DIR;
		delete env.GIT_WORK_TREE;
		delete env.GIT_INDEX_FILE;
		const git = (args, input) => {
			const result = spawnSync(
				"git",
				["-c", `core.excludesFile=${join(root, "empty-excludes")}`, ...args],
				{ cwd: root, env, encoding: "utf8", input },
			);
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		git(["init", "--quiet", `--template=${join(root, "empty-template")}`]);

		const privatePiPaths = [
			"agents/personal-agent.md",
			"agents-runs/run/transcript.json",
			"agents-schedules/personal.json",
			"agent/credentials/v1/vault.json",
			"agent/skills/generated/SKILL.md",
			"serve/builds/candidate.json",
			"serve/agents/agent.json",
			"serve/connections.json",
			"serve/browser-profile/Cookies",
			"sessions/session.jsonl",
			"memory/private.md",
			"personas/private.md",
			"vault/credentials.v1.json",
			"credentials/v1/vault.json",
			"auth.json",
			"models.json",
			"models-store.json",
			"settings.json",
			"trust.json",
			"auth.json.backup",
			"hf-sessions/export.jsonl",
			"hf-sessions-backup/export.jsonl",
			"future-store/private.json",
			"private-new-file.json",
			"extensions/personal.ts",
			"extensions/package/.pi/credentials/vault.json",
			"prompts/personal.md",
			"skills/generated/SKILL.md",
			"themes/personal.json",
			"git/installed-package/index.ts",
			"npm/node_modules/package/index.js",
		];
		const ignored = [
			...privatePiPaths.flatMap((path) => [`.pi/${path}`, `nested/project/.pi/${path}`]),
			"nested/project/.pi/extensions/api-tools.ts",
			".local/workspaces/personal-agent/index.ts",
			"nested/.local/private.json",
			".pi_config/auth.json",
			"output/proof/report.html",
			"output/playwright/private.png",
			"playwright-report/index.html",
			"test-results/trace.zip",
			".playwright/auth.json",
			".playwright-cli/snapshot.yml",
			".codex-remote-attachments/upload.jpg",
			"nested/.env",
			".env.local",
			".env.production",
			"nested/.env.development.local",
			".env.backup",
		];
		const sharedPiPaths = [
			"extensions/api-tools.ts",
			"extensions/import-repro.ts",
			"extensions/prompt-url-widget.ts",
			"extensions/redraws.ts",
			"extensions/tps.ts",
			"prompts/cl.md",
			"prompts/is.md",
			"prompts/pr.md",
			"prompts/sa.md",
			"prompts/wr.md",
			"skills/add-llm-provider.md",
			"git/.gitignore",
			"npm/.gitignore",
		];
		const shared = [
			...sharedPiPaths.map((path) => `.pi/${path}`),
			".env.example",
			"nested/.env.sample",
			"nested/.env.template",
			"examples/agents/demo.md",
			"examples/skills/demo/SKILL.md",
			"packages/coding-agent/test/fixtures/state.json",
			"packages/coding-agent/test/fixtures/report.html",
			"packages/ai/src/providers/example.ts",
			"docs/images/synthetic-demo.png",
			"docs/pi-user-data-privacy.md",
			"package-lock.json",
		];
		const result = git(["check-ignore", "--no-index", "--stdin", "-z"], [...ignored, ...shared].join("\0"));
		assert.deepEqual(new Set(result.split("\0").filter(Boolean)), new Set(ignored));

		// Verify the installed-package sentinels also remain shareable with their own rules present.
		for (const directory of ["git", "npm"]) {
			await mkdir(join(root, ".pi", directory), { recursive: true });
			await writeFile(
				join(root, ".pi", directory, ".gitignore"),
				await readFile(new URL(`../.pi/${directory}/.gitignore`, import.meta.url)),
			);
		}
		const withSentinels = git(["check-ignore", "--no-index", "--stdin", "-z"], [...ignored, ...shared].join("\0"));
		assert.deepEqual(new Set(withSentinels.split("\0").filter(Boolean)), new Set(ignored));

		// Ignore rules cannot remove previously committed files: retain this safety distinction.
		await writeFile(join(root, ".pi", "settings.json"), '{"example":true}\n');
		git(["add", "--force", "--", ".pi/settings.json"]);
		assert.equal(git(["ls-files", "--cached", "--ignored", "--exclude-standard"]).trim(), ".pi/settings.json");

		// Commit only synthetic data in the isolated repository, with no workstation hooks or signing.
		git([
			"-c",
			`core.hooksPath=${join(root, "empty-template")}`,
			"-c",
			"user.name=Privacy Test",
			"-c",
			"user.email=privacy-test@example.invalid",
			"commit",
			"--quiet",
			"--no-gpg-sign",
			"-m",
			"Synthetic tracked-data fixture",
		]);
		git(["rm", "--cached", "--", ".pi/settings.json"]);
		git(["add", "--", ".gitignore"]);
		assert.equal(await readFile(join(root, ".pi", "settings.json"), "utf8"), '{"example":true}\n');
		assert.equal(git(["diff", "--cached", "--name-only", "--diff-filter=D"]).trim(), ".pi/settings.json");

		// Exercise the actual hook's selection command: a later formatter restage must not undo removal.
		const hook = await readFile(new URL("../.husky/pre-commit", import.meta.url), "utf8");
		const selection = hook.match(/^STAGED_FILES=\$\(git ([^)]+)\)\r?$/m);
		assert.ok(selection, "Expected the hook's staged-file selection command");
		assert.equal(git(selection[1].split(" ")).trim(), ".gitignore");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
