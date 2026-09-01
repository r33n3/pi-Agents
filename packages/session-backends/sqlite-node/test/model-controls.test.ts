import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSessionContext, type ModelControlsEntry } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

function createRepository(root: string): SqliteSessionRepository {
	return new SqliteSessionRepository({
		env: new NodeExecutionEnv({ cwd: root }),
		sqlite: createNodeSqliteFactory(),
		databasePath: join(root, "sessions.sqlite"),
	});
}

describe("SQLite native model settings", () => {
	it("survives closing the database and reopening a separate repository", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		const saved = await source.appendEntry<ModelControlsEntry>(
			{
				type: "model_controls_change",
				id: "settings",
				modelControls: { reasoningEffort: "high", processingTier: "priority" },
			},
			"main",
		);
		await source.appendMessage({ role: "user", content: "continue", timestamp: 1 });
		await source.appendRecord({
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: await source.getLeafId(),
			intent: {
				kind: "run",
				originalPrompt: [],
				initialMessages: [{ type: "model_controls_change", id: "pending", modelControls: {} }],
			},
		});
		const records = await source.findRecords();
		const metadata = await source.getMetadata();
		await repository.close();

		await using reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		expect(await reopened.getEntry(saved.id)).toEqual(saved);
		expect(buildSessionContext(await reopened.findEntriesOnBranch({ order: "oldestFirst" })).modelControls).toEqual(
			saved.modelControls,
		);
		expect(await reopened.findOpenOperations("main")).toEqual(records);
		expect(await reopened.findRecords()).toEqual(records);
	});

	it.each([{}, { modelControls: { reasoningBudget: "1024" } }, { modelControls: { thinking: "high" } }])(
		"rejects corrupt entry payload %j on reads and forks",
		async (payload) => {
			const root = createTempDir();
			const repository = createRepository(root);
			const source = await repository.create({ id: "source", cwd: root });
			await source.appendEntry({ type: "model_controls_change", id: "settings", modelControls: {} }, "main");
			await source.appendMessage({ role: "user", content: "continue", timestamp: 1 });
			const metadata = await source.getMetadata();
			await repository.close();
			const database = new DatabaseSync(metadata.path);
			try {
				database
					.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
					.run(JSON.stringify(payload), metadata.id, "settings");
			} finally {
				database.close();
			}

			await using reopenedRepository = createRepository(root);
			const reopened = await reopenedRepository.open(metadata);
			await expect(reopened.getEntry("settings")).rejects.toMatchObject({ code: "invalid_entry" });
			await expect(reopened.findEntriesOnBranch()).rejects.toMatchObject({ code: "invalid_entry" });
			await expect(reopened.getLog()).rejects.toMatchObject({ code: "invalid_entry" });
			for (const scope of ["branch", "tree"] as const) {
				await expect(
					reopenedRepository.fork(metadata, { scope, id: `bad-${scope}`, cwd: root }),
				).rejects.toMatchObject({ code: "invalid_entry" });
			}
			expect((await reopenedRepository.list()).map((entry) => entry.id)).toEqual(["source"]);
		},
	);

	it("rejects corrupt native settings inside a pending operation on every recovery read", async () => {
		const root = createTempDir();
		const repository = createRepository(root);
		const source = await repository.create({ id: "source", cwd: root });
		const operation = {
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: null,
			intent: { kind: "run", originalPrompt: [], initialMessages: [] },
		} as const;
		await source.appendRecord({
			...operation,
			intent: { ...operation.intent, originalPrompt: [], initialMessages: [] },
		});
		const metadata = await source.getMetadata();
		await repository.close();
		const database = new DatabaseSync(metadata.path);
		try {
			const payload = {
				...operation,
				intent: {
					...operation.intent,
					initialMessages: [{ type: "model_controls_change", id: "bad", modelControls: [] }],
				},
			};
			database
				.prepare("UPDATE records SET payload = ? WHERE session_id = ? AND id = ?")
				.run(JSON.stringify(payload), metadata.id, operation.id);
		} finally {
			database.close();
		}
		await using reopenedRepository = createRepository(root);
		const reopened = await reopenedRepository.open(metadata);
		await expect(reopened.findRecords()).rejects.toMatchObject({ code: "storage" });
		await expect(reopened.findOpenOperations("main")).rejects.toMatchObject({ code: "storage" });
		await expect(reopened.getLog()).rejects.toMatchObject({ code: "storage" });
	});
});
