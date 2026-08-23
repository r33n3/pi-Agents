import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserWorkflowReferenceStore } from "../src/core/serve/browser-workflow-reference-store.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BrowserWorkflowReferenceStore", () => {
	test("persists project references and generates a skill without copying workflow steps", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-references-"));
		roots.push(root);
		const registry = new BrowserWorkflowRegistry(join(root, "workflows"));
		await registry.initialize();
		const draft = await registry.saveDraft({
			name: "Review page",
			description: "Review the project page",
			entry: {
				urlTemplate: "http://127.0.0.1:3000/",
				allowedOrigins: ["http://127.0.0.1:3000"],
				ready: [{ kind: "page-ready" }],
			},
			parameters: [],
			steps: [],
			completion: [{ kind: "title", pattern: "Project" }],
			requirements: {
				profile: "none",
				access: "loopback",
				viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
			},
			policy: { deadlineMs: 60_000, approval: "inherit" },
			source: { kind: "manual" },
		});
		const compiled = await registry.setStatus(draft.id, draft.version, "compiled");
		const validated = await registry.markValidated(compiled.id, compiled.version, {
			id: "validation-1",
			digest: compiled.digest,
			completedAt: Date.now(),
		});
		const active = await registry.activate(validated.id, validated.version);
		const store = new BrowserWorkflowReferenceStore(join(root, "references"), join(root, "skills"), registry);
		await store.initialize();

		const projectRoot = join(root, "project");
		await store.attachFrontendTest(projectRoot, {
			workflowId: active.id,
			workflowVersion: active.version,
		});
		const skill = await store.createSkill({ workflowId: active.id, workflowVersion: active.version });
		const content = await readFile(skill.path, "utf8");
		expect(content).toContain(`"id": "${active.id}", "version": ${active.version}`);
		expect(content).not.toContain("workflow.steps");

		const restored = new BrowserWorkflowReferenceStore(join(root, "references"), join(root, "skills"), registry);
		await restored.initialize();
		expect(restored.listFrontendTests(projectRoot)).toEqual([
			expect.objectContaining({ workflowId: active.id, workflowVersion: active.version, projectRoot }),
		]);
	});
});
