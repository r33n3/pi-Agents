import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ArtifactStore } from "../src/core/serve/artifact-store.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "pi-artifacts-"));
	roots.push(root);
	const owned = join(root, "owned");
	await mkdir(owned, { recursive: true });
	const source = join(owned, "report.md");
	await writeFile(source, "# Report\n\nVerified result.\n", "utf8");
	const store = new ArtifactStore(join(root, "serve"));
	await store.initialize();
	return { root, owned, source, store };
}

describe("ArtifactStore", () => {
	test("persists immutable content, provenance, restore versions, and archive state", async () => {
		const { root, owned, source, store } = await setup();
		const artifact = await store.register({
			title: "Morning report",
			taskId: "task-1",
			attemptId: "attempt-1",
			conversationId: "conversation-1",
			agentId: "mail-agent",
			workspaceRoot: root,
			sourcePath: source,
			allowedRoot: owned,
			sourceRefs: [{ kind: "provider", label: "Gmail", reference: "message-1" }],
		});
		expect(artifact).toMatchObject({ title: "Morning report", kind: "markdown", versionIds: [expect.any(String)] });
		await writeFile(source, "changed workspace file", "utf8");
		const content = await store.readContent(artifact.id);
		expect(new TextDecoder().decode(content?.data)).toContain("Verified result");

		const restored = await store.restore(artifact.id, artifact.currentVersionId, "task-restore", "attempt-restore");
		expect(restored.versionIds).toHaveLength(2);
		expect((await store.getVersion(artifact.id))?.safeSummary).toContain("Restored version 1");
		await store.archive(artifact.id);
		expect(store.list()).toEqual([]);
		expect(store.list({ includeArchived: true })).toHaveLength(1);

		const reopened = new ArtifactStore(join(root, "serve"));
		await reopened.initialize();
		expect(reopened.get(artifact.id)?.versionIds).toHaveLength(2);
		expect(new TextDecoder().decode((await reopened.readContent(artifact.id))?.data)).toContain("Verified result");
	});

	test("rejects a source outside its owned root", async () => {
		const { root, owned, store } = await setup();
		const outside = join(root, "outside.md");
		await writeFile(outside, "secret", "utf8");
		await expect(
			store.register({
				title: "Escaped",
				taskId: "task-1",
				attemptId: "attempt-1",
				conversationId: "conversation-1",
				workspaceRoot: root,
				sourcePath: outside,
				allowedRoot: owned,
			}),
		).rejects.toThrow("escapes its owned root");
	});

	test("rejects a junction or symlink that resolves outside its owned root", async () => {
		const { root, owned, store } = await setup();
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.md"), "secret", "utf8");
		const link = join(owned, "linked");
		await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
		await expect(
			store.register({
				title: "Linked escape",
				taskId: "task-1",
				attemptId: "attempt-1",
				conversationId: "conversation-1",
				workspaceRoot: root,
				sourcePath: join(link, "secret.md"),
				allowedRoot: owned,
			}),
		).rejects.toThrow("escapes its owned root");
	});
});
