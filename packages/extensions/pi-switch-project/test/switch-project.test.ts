import { describe, expect, test } from "vitest";
import { stripSessionArgs, unquote } from "../extensions/switch-project.ts";

describe("switch-project argument handling", () => {
	test("removes prior session selectors and their values", () => {
		expect(stripSessionArgs(["cli.js", "--model", "luna", "--session", "old", "--continue", "--serve"])).toEqual([
			"cli.js",
			"--model",
			"luna",
			"--serve",
		]);
	});

	test.each([
		['"C:\\Project Files\\app"', "C:\\Project Files\\app"],
		["'../another project'", "../another project"],
		["  ./plain  ", "./plain"],
	])("removes only matching surrounding quotes from %j", (input, expected) => {
		expect(unquote(input)).toBe(expected);
	});
});
