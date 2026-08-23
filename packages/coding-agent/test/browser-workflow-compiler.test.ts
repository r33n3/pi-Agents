import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserWorkflowCapture } from "../src/core/serve/browser-workflow-capture.ts";
import { BrowserWorkflowCompiler, compileDefinition } from "../src/core/serve/browser-workflow-compiler.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(target = { role: "button", name: "Sign in", testId: "sign-in" }): BrowserWorkflowCapture {
	const initial = { url: "http://127.0.0.1:4173/login", title: "Sign in", elements: [target] };
	return {
		schema: "pi.browser-capture.v1",
		id: "capture-1",
		sessionId: "session-1",
		owner: { kind: "pi-session", id: "pi-1" },
		profile: { kind: "ephemeral" },
		viewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
		status: "stopped",
		startedAt: 1,
		updatedAt: 2,
		initial,
		steps: [
			{
				id: "step-1",
				timestamp: 2,
				action: { kind: "click", x: 20, y: 30, target },
				before: initial,
				after: { ...initial, url: "http://127.0.0.1:4173/account", title: "Account" },
			},
		],
	};
}

describe("BrowserWorkflowCompiler", () => {
	test("compiles stable semantic targets and omits viewport coordinates", () => {
		const definition = compileDefinition(capture(), { name: "Sign in" });
		expect(definition.entry.allowedOrigins).toEqual(["http://127.0.0.1:4173"]);
		expect(definition.steps[0]).toMatchObject({
			action: "click",
			target: {
				candidates: [
					{ kind: "test-id", value: "sign-in" },
					{ kind: "role", role: "button", name: "Sign in", exact: true },
					{ kind: "text", text: "Sign in", exact: true },
				],
			},
		});
		expect(JSON.stringify(definition)).not.toContain('"x"');
		expect(definition.compileIssues).toEqual([]);
	});

	test("persists unresolved captures as needs-input instead of inventing a selector", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-compiler-"));
		roots.push(root);
		const registry = new BrowserWorkflowRegistry(root);
		await registry.initialize();
		const unresolved = capture({ role: "", name: "", testId: "" });
		unresolved.steps[0]!.action = { kind: "click", x: 20, y: 30 };
		const definition = await new BrowserWorkflowCompiler(registry).compile(unresolved, { name: "Needs target" });
		expect(definition.status).toBe("needs-input");
		expect(definition.steps).toEqual([]);
		expect(definition.compileIssues).toMatchObject([{ stepId: "step-1", code: "missing-target" }]);

		const restarted = new BrowserWorkflowRegistry(root);
		await restarted.initialize();
		expect(restarted.get(definition.id)?.compileIssues).toEqual(definition.compileIssues);
	});
});
