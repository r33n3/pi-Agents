import { describe, expect, test } from "vitest";
import { validatePluginSource } from "../src/core/serve/plugin-management-service.ts";

describe("plugin management validation", () => {
	test("accepts pinned package and repository sources", () => {
		expect(validatePluginSource("@scope/plugin@1.2.3")).toBe("@scope/plugin@1.2.3");
		expect(validatePluginSource("github:owner/repository#commit")).toBe("github:owner/repository#commit");
	});

	test("rejects empty, multiline, and whitespace-separated sources", () => {
		for (const source of ["", "package latest", "package\nother", `package${"x".repeat(512)}`]) {
			expect(() => validatePluginSource(source)).toThrow("Plugin source");
		}
	});
});
