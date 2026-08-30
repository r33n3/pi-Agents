import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { stripSessionArgs, unquote, windowsProjectScript } from "../extensions/switch-project.ts";

describe("switch-project argument handling", () => {
	test("removes prior session selectors and their values", () => {
		expect(stripSessionArgs(["cli.js", "--model", "luna", "--session", "old", "--continue", "--serve"])).toEqual([
			"cli.js",
			"--model",
			"luna",
			"--serve",
		]);
	});
	test("removes equals-style session selectors", () => {
		expect(stripSessionArgs(["cli.js", "--session=old", "--session-dir=C:/old", "--model", "luna"])).toEqual([
			"cli.js", "--model", "luna",
		]);
	});

	test.runIf(process.platform === "win32")("preserves Windows arguments and metacharacter paths", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-launch & %PATH% [test] "));
		try {
			const values = [
				"", "two words", 'quote"inside', "C:\\trailing space\\", "a&echo injected", "%PATH%",
				"$(Get-Date)", "(test)", "Unicode 雪", "line\nbreak",
			];
			const script = windowsProjectScript(
				process.execPath,
				["-e", "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}))", "--", ...values],
				root,
			);
			const result = spawnSync(
				"powershell.exe",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
				{ encoding: "utf8", timeout: 15_000, windowsHide: true },
			);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout.trim())).toEqual({ args: values, cwd: root });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects NUL arguments before launching", () => {
		expect(() => windowsProjectScript("node", ["bad\0value"], "C:/project")).toThrow("NUL");
	});

	test.each([
		['"C:\\Project Files\\app"', "C:\\Project Files\\app"],
		["'../another project'", "../another project"],
		["  ./plain  ", "./plain"],
	])("removes only matching surrounding quotes from %j", (input, expected) => {
		expect(unquote(input)).toBe(expected);
	});
});
