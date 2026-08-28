import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type BrowserWorkflowDefinitionInput,
	BrowserWorkflowRegistry,
} from "../src/core/serve/browser-workflow-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function workflow(name = "Create project"): BrowserWorkflowDefinitionInput {
	return {
		name,
		description: "Create one project through the browser",
		entry: {
			urlTemplate: "http://127.0.0.1:3000/projects",
			allowedOrigins: ["http://127.0.0.1:3000"],
			ready: [{ kind: "title", pattern: "Projects" }],
		},
		parameters: [
			{
				name: "projectName",
				description: "Project display name",
				type: "string",
				required: true,
				sensitive: false,
			},
		],
		steps: [
			{
				id: "fill-name",
				action: "fill",
				target: {
					frame: [],
					candidates: [{ kind: "label", text: "Project name", exact: true }],
					expected: { tag: "input" },
				},
				value: { kind: "parameter", name: "projectName" },
				preconditions: [],
				postconditions: [],
				timeoutMs: 10_000,
				evidence: "failure",
			},
		],
		completion: [{ kind: "text", text: "Project created", visible: true }],
		requirements: {
			profile: "none",
			access: "loopback",
			viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
		},
		policy: { deadlineMs: 60_000, approval: "inherit" },
		source: { kind: "manual" },
	};
}

async function registryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-browser-workflow-"));
	roots.push(root);
	return root;
}

describe("BrowserWorkflowRegistry", () => {
	test("persists versioned drafts and restores them after restart", async () => {
		const root = await registryRoot();
		const registry = new BrowserWorkflowRegistry(root);
		await registry.initialize();
		const first = await registry.saveDraft(workflow());
		const second = await registry.saveDraft({ ...workflow(), description: "Updated description" });

		expect(first.version).toBe(1);
		expect(second.version).toBe(2);
		expect(second.digest).toBe(first.digest);
		expect(JSON.parse(await readFile(join(root, first.id, "metadata.json"), "utf8"))).toMatchObject({
			latestVersion: 2,
		});

		const restored = new BrowserWorkflowRegistry(root);
		await restored.initialize();
		expect(restored.get(first.id, 1)).toEqual(first);
		expect(restored.get(first.id)?.description).toBe("Updated description");
	});

	test("requires matching validation evidence before activation", async () => {
		const registry = new BrowserWorkflowRegistry(await registryRoot());
		await registry.initialize();
		const draft = await registry.saveDraft(workflow());
		const compiled = await registry.setStatus(draft.id, draft.version, "compiled");

		await expect(registry.activate(compiled.id, compiled.version)).rejects.toThrow("cannot transition");
		await expect(
			registry.markValidated(compiled.id, compiled.version, {
				id: "validation-1",
				digest: "0".repeat(64),
				completedAt: Date.now(),
			}),
		).rejects.toThrow("does not match");

		const validated = await registry.markValidated(compiled.id, compiled.version, {
			id: "validation-1",
			digest: compiled.digest,
			completedAt: Date.now(),
		});
		const active = await registry.activate(validated.id, validated.version);
		expect(active.status).toBe("active");
		expect(registry.getActive(active.id)).toEqual(active);
	});

	test("supersedes the prior active version without changing its executable content", async () => {
		const registry = new BrowserWorkflowRegistry(await registryRoot());
		await registry.initialize();
		const firstDraft = await registry.saveDraft(workflow());
		await registry.setStatus(firstDraft.id, firstDraft.version, "compiled");
		await registry.markValidated(firstDraft.id, firstDraft.version, {
			id: "validation-1",
			digest: firstDraft.digest,
			completedAt: 1,
		});
		await registry.activate(firstDraft.id, firstDraft.version);

		const changed = workflow();
		changed.steps[0] = { ...changed.steps[0], timeoutMs: 20_000 };
		const secondDraft = await registry.saveDraft(changed);
		await registry.setStatus(secondDraft.id, secondDraft.version, "compiled");
		await registry.markValidated(secondDraft.id, secondDraft.version, {
			id: "validation-2",
			digest: secondDraft.digest,
			completedAt: 2,
		});
		await registry.activate(secondDraft.id, secondDraft.version);

		expect(registry.get(firstDraft.id, 1)?.status).toBe("superseded");
		expect(registry.getActive(firstDraft.id)?.version).toBe(2);
		expect(secondDraft.digest).not.toBe(firstDraft.digest);
	});

	test("rejects undeclared parameters, unsafe origins, and invalid lifecycle transitions", async () => {
		const registry = new BrowserWorkflowRegistry(await registryRoot());
		await registry.initialize();
		const undeclared = workflow();
		const step = undeclared.steps[0];
		if (step.action !== "fill") throw new Error("Unexpected test fixture step");
		undeclared.steps[0] = { ...step, value: { kind: "parameter", name: "missing" } };
		await expect(registry.saveDraft(undeclared)).rejects.toThrow("undeclared parameter");

		const unsafe = workflow();
		unsafe.entry.allowedOrigins = ["file:///tmp"];
		await expect(registry.saveDraft(unsafe)).rejects.toThrow("HTTP(S) origins");

		const draft = await registry.saveDraft(workflow("Another workflow"));
		await expect(registry.setStatus(draft.id, draft.version, "invalid")).rejects.toThrow("cannot transition");
	});

	test("rejects invalid assertion and frame URL patterns before persistence", async () => {
		const registry = new BrowserWorkflowRegistry(await registryRoot());
		await registry.initialize();
		const invalidAssertion = workflow();
		invalidAssertion.entry.ready = [{ kind: "title", pattern: "[" }];
		await expect(registry.saveDraft(invalidAssertion)).rejects.toThrow("valid regular expression");

		const invalidFrame = workflow();
		const step = invalidFrame.steps[0];
		if (step.action !== "fill") throw new Error("Unexpected test fixture step");
		invalidFrame.steps[0] = {
			...step,
			target: { ...step.target, frame: [{ urlPattern: "(" }] },
		};
		await expect(registry.saveDraft(invalidFrame)).rejects.toThrow("valid regular expression");
	});

	test("rejects undeclared or sensitive URL template parameters", async () => {
		const registry = new BrowserWorkflowRegistry(await registryRoot());
		await registry.initialize();
		const undeclared = workflow();
		undeclared.entry.urlTemplate = `http://127.0.0.1:3000/projects/\${missing}`;
		await expect(registry.saveDraft(undeclared)).rejects.toThrow("undeclared parameter");

		const sensitive = workflow();
		sensitive.parameters[0] = {
			...sensitive.parameters[0],
			type: "secret-ref",
			sensitive: true,
		};
		sensitive.entry.urlTemplate = `http://127.0.0.1:3000/projects/\${projectName}`;
		await expect(registry.saveDraft(sensitive)).rejects.toThrow("cannot reference a sensitive parameter");
	});

	test("ignores a tampered persisted version during restart", async () => {
		const root = await registryRoot();
		const registry = new BrowserWorkflowRegistry(root);
		await registry.initialize();
		const saved = await registry.saveDraft(workflow());
		const path = join(root, saved.id, "versions", "1.json");
		const tampered = JSON.parse(await readFile(path, "utf8"));
		tampered.steps[0].timeoutMs = 99_000;
		await writeFile(path, JSON.stringify(tampered), "utf8");

		const restored = new BrowserWorkflowRegistry(root);
		await restored.initialize();
		expect(restored.get(saved.id)).toBeUndefined();
	});

	test("deletes every persisted version and remains deleted after restart", async () => {
		const root = await registryRoot();
		const registry = new BrowserWorkflowRegistry(root);
		await registry.initialize();
		const first = await registry.saveDraft(workflow());
		await registry.saveDraft({ ...workflow(), description: "Second version" });

		await expect(registry.delete(first.id)).resolves.toBe(true);
		expect(registry.get(first.id)).toBeUndefined();
		await expect(registry.delete(first.id)).resolves.toBe(false);

		const restored = new BrowserWorkflowRegistry(root);
		await restored.initialize();
		expect(restored.get(first.id)).toBeUndefined();
	});
});
