import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import type { ModelControls } from "@earendil-works/pi-ai";
import { buildSessionContext } from "../context.ts";
import type { ModelControlsEntry, NewRecord, ProvisionedEntry, SessionTree } from "../types.ts";
import type { SessionBackendConformanceCase, SessionBackendFixtureFactory } from "./types.ts";

async function readControls(tree: SessionTree): Promise<ModelControls | undefined> {
	return buildSessionContext(await tree.findEntriesOnBranch({ order: "oldestFirst" })).modelControls;
}

/** Native settings obey the same persistence contract on every backend. No provider is contacted. */
export function createModelControlsConformance(
	factory: SessionBackendFixtureFactory,
): readonly SessionBackendConformanceCase[] {
	const selections: (ModelControls | null)[] = [
		{},
		{ reasoningMode: "pro", reasoningEffort: "high", processingTier: "priority" },
		{ reasoningBudget: 0 },
		{ reasoningBudget: -1 },
		null,
	];
	return [
		...selections.map(
			(modelControls): SessionBackendConformanceCase => ({
				group: "native model controls",
				name: `round trips ${JSON.stringify(modelControls)} through reopen and forks`,
				async run() {
					await using fixture = await factory();
					const repository = fixture.repository;
					const session = await repository.create({ id: "source" });
					const stored = await session.appendEntry<ModelControlsEntry>(
						{ type: "model_controls_change", id: "settings", modelControls },
						"main",
					);
					const tip = await session.appendMessage({ role: "user", content: "continue", timestamp: 1 });
					const metadata = await session.getMetadata();
					const reopened = await repository.open(metadata);
					deepStrictEqual(await reopened.getEntry(stored.id), stored);
					deepStrictEqual(await reopened.findEntries({ type: "model_controls_change" }), [stored]);
					deepStrictEqual((await reopened.getLog())[0], { kind: "entry", seq: stored.seq, entry: stored });
					deepStrictEqual(await readControls(reopened), modelControls ?? undefined);
					for (const scope of ["branch", "tree"] as const) {
						const fork = await repository.fork(metadata, { scope, id: scope });
						deepStrictEqual(await readControls(fork), modelControls ?? undefined);
						strictEqual(await fork.getLeafId(), tip);
					}
				},
			}),
		),
		{
			group: "native model controls",
			name: "keeps lane settings separate across compaction and branch forks",
			async run() {
				await using fixture = await factory();
				const repository = fixture.repository;
				const session = await repository.create({ id: "source" });
				const selected = { processingTier: "priority", reasoningEffort: "high" };
				await session.appendEntry(
					{ type: "model_controls_change", id: "selected", modelControls: selected },
					"main",
				);
				const anchor = await session.appendMessage({ role: "user", content: "anchor", timestamp: 1 });
				await session.createLane("draft", anchor);
				await session.appendEntry({ type: "model_controls_change", id: "legacy", modelControls: null }, "main");
				await session.appendEntry({ type: "thinking_level_change", id: "thinking", thinkingLevel: "high" }, "main");
				await session.appendEntry({ type: "model_controls_change", id: "defaults", modelControls: {} }, "draft");
				await session.appendEntry(
					{ type: "compaction", id: "compact", summary: "summary", retainedTail: [], tokensBefore: 100 },
					"draft",
				);
				strictEqual(await readControls(session), undefined);
				deepStrictEqual(await readControls(session.view("draft")), {});
				const metadata = await session.getMetadata();
				const branch = await repository.fork(metadata, { id: "branch", entryId: anchor, position: "at" });
				deepStrictEqual(await readControls(branch), selected);
				const tree = await repository.fork(metadata, { id: "tree", scope: "tree" });
				strictEqual(await readControls(tree), undefined);
				deepStrictEqual(await readControls(tree.view("draft")), {});
			},
		},
		{
			group: "native model controls",
			name: "preserves selections inside pending run, queue, and deferred-write records",
			async run() {
				await using fixture = await factory();
				const session = await fixture.repository.create({ id: "source" });
				const target: ProvisionedEntry = {
					type: "model_controls_change",
					id: "selected",
					modelControls: { reasoningEffort: "high" },
				};
				const started = await session.appendRecord({
					type: "operation_started",
					id: "run",
					lane: "main",
					sourceLeafId: null,
					intent: { kind: "run", originalPrompt: [], initialMessages: [target] },
				});
				await session.appendRecord({
					type: "queue_enqueued",
					id: "queued",
					lane: "main",
					queue: "nextRun",
					target: { ...target, id: "next", modelControls: {} },
				});
				await session.appendRecord({
					type: "write_deferred",
					id: "write",
					lane: "main",
					runId: "run",
					target: { ...target, id: "clear", modelControls: null },
				});
				const records = await session.findRecords({ order: "oldestFirst" });
				const reopened = await fixture.repository.open(await session.getMetadata());
				deepStrictEqual(await reopened.findRecords({ order: "oldestFirst" }), records);
				deepStrictEqual(await reopened.findOpenOperations("main"), [started]);
				strictEqual(await readControls(reopened), undefined);
				strictEqual(await reopened.getLeafId(), null);
			},
		},
		{
			group: "native model controls",
			name: "rejects malformed selections before mutating entries, records, sequence, or lane state",
			async run() {
				await using fixture = await factory();
				const session = await fixture.repository.create({ id: "source" });
				for (const modelControls of [
					undefined,
					[],
					"high",
					{ reasoningBudget: "1024" },
					{ reasoningBudget: -2 },
					{ thinking: "high" },
				]) {
					const target = {
						type: "model_controls_change",
						id: "bad",
						modelControls,
					} as unknown as ProvisionedEntry;
					await rejects(session.appendEntry(target, "main"), { code: "invalid_payload" });
					const records: NewRecord[] = [
						{
							type: "operation_started",
							id: "run",
							lane: "main",
							sourceLeafId: null,
							intent: { kind: "run", originalPrompt: [], initialMessages: [target] },
						},
						{ type: "queue_enqueued", id: "queued", lane: "main", queue: "nextRun", target },
						{ type: "write_deferred", id: "write", lane: "main", runId: "run", target },
					];
					for (const record of records) await rejects(session.appendRecord(record), { code: "invalid_payload" });
				}
				deepStrictEqual(await session.getLog(), []);
				deepStrictEqual(await session.findOpenOperations("main"), []);
				strictEqual(await session.getLeafId(), null);
				const valid = await session.appendEntry(
					{ type: "model_controls_change", id: "valid", modelControls: {} },
					"main",
				);
				strictEqual(valid.seq, 1);
			},
		},
	];
}
