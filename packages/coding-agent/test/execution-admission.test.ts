import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { ExecutionAdmission } from "../src/core/serve/execution-admission.ts";

describe("ExecutionAdmission", () => {
	test("blocks overlapping writers across backends, permits concurrent readers, and releases capacity", () => {
		const admission = new ExecutionAdmission(2);
		const root = resolve("test-workspace");
		const releasePi = admission.acquire("pi", root, false);
		expect(() => admission.acquire("external", resolve(root, "nested"), true)).toThrow("workspace-busy");
		const releaseReader = admission.acquire("reader", root, false);
		expect(admission.availability(resolve("different-workspace"), true)).toBe("capacity");
		releaseReader();
		releasePi();
		const releaseExternal = admission.acquire("external", resolve(root, "nested"), true);
		expect(admission.availability(root, false)).toBe("workspace-busy");
		expect(admission.availability(`${root}-other`, true)).toBe("available");
		releaseExternal();
		expect(admission.availability(root, true)).toBe("available");
	});
});
