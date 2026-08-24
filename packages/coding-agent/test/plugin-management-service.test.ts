import { describe, expect, test } from "vitest";
import { validatePinnedPluginSource, validatePluginSource } from "../src/core/serve/plugin-management-service.ts";

describe("plugin management validation", () => {
	test("accepts pinned package and repository sources", () => {
		expect(validatePinnedPluginSource("@scope/plugin@1.2.3")).toBe("@scope/plugin@1.2.3");
		expect(validatePinnedPluginSource("github:owner/repository#0123456789abcdef")).toBe(
			"github:owner/repository#0123456789abcdef",
		);
	});

	test("requires immutable package versions and Git revisions for installation", () => {
		for (const source of ["plugin", "plugin@latest", "@scope/plugin", "github:owner/repository#main"]) {
			expect(() => validatePinnedPluginSource(source)).toThrow("Plugin source");
		}
		expect(validatePinnedPluginSource("./local-plugin")).toBe("./local-plugin");
	});

	test("rejects empty, multiline, and whitespace-separated sources", () => {
		for (const source of ["", "package latest", "package\nother", `package${"x".repeat(512)}`]) {
			expect(() => validatePluginSource(source)).toThrow("Plugin source");
		}
	});
});
