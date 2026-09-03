import { describe, expect, test } from "vitest";
import {
	BrowserConnectionGeneration,
	BrowserSelectionGeneration,
} from "../src/core/serve/browser/connection-generations.ts";

describe("browser connection generations", () => {
	test("lets only the latest session-list request publish within a connection epoch", () => {
		const connection = new BrowserConnectionGeneration();
		const older = connection.beginSessionList();
		const newer = connection.beginSessionList();

		expect(connection.isSessionListCurrent(older)).toBe(false);
		expect(connection.isSessionListCurrent(newer)).toBe(true);
	});

	test("invalidates pending connection and session-list work on disconnect or removal", () => {
		const connection = new BrowserConnectionGeneration();
		const epoch = connection.epoch;
		const request = connection.beginSessionList();

		connection.invalidate();

		expect(connection.isCurrent(epoch)).toBe(false);
		expect(connection.isSessionListCurrent(request)).toBe(false);
	});

	test("lets the latest session-selection intent supersede earlier work", () => {
		const selections = new BrowserSelectionGeneration();
		const first = selections.begin();
		const second = selections.begin();

		expect(selections.isCurrent(first)).toBe(false);
		expect(selections.isCurrent(second)).toBe(true);
		selections.invalidate();
		expect(selections.isCurrent(second)).toBe(false);
	});

	test("disposes an attachment that finishes after a newer selection", async () => {
		const selections = new BrowserSelectionGeneration();
		const connection = new BrowserConnectionGeneration();
		const retained: string[] = [];
		const disposed: string[] = [];
		const deferred = () => {
			let resolve: (session: { id: string; dispose(): Promise<void> }) => void = () => {};
			const promise = new Promise<{ id: string; dispose(): Promise<void> }>((done) => {
				resolve = done;
			});
			return { promise, resolve };
		};
		const firstAttachment = deferred();
		const secondAttachment = deferred();
		const attach = async (generation: number, attachment: ReturnType<typeof deferred>["promise"]) => {
			const connectionEpoch = connection.epoch;
			const session = await attachment;
			if (await selections.retainCurrentSession(generation, session, () => connection.isCurrent(connectionEpoch))) {
				retained.push(session.id);
			}
		};

		const first = attach(selections.begin(), firstAttachment.promise);
		const second = attach(selections.begin(), secondAttachment.promise);
		secondAttachment.resolve({
			id: "B",
			dispose: async () => {
				disposed.push("B");
			},
		});
		await second;
		firstAttachment.resolve({
			id: "A",
			dispose: async () => {
				disposed.push("A");
			},
		});
		await first;

		expect(retained).toEqual(["B"]);
		expect(disposed).toEqual(["A"]);
	});
});
