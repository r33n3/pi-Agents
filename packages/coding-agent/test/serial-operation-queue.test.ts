import { describe, expect, test } from "vitest";
import { SerialOperationQueue } from "../src/core/serve/serial-operation-queue.ts";

describe("SerialOperationQueue", () => {
	test("runs operations in submission order", async () => {
		const queue = new SerialOperationQueue();
		const calls: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const first = queue.run(
			() =>
				new Promise<string>((resolve) => {
					calls.push("first");
					releaseFirst = () => resolve("one");
				}),
		);
		const second = queue.run(async () => {
			calls.push("second");
			return "two";
		});

		expect(calls).toEqual([]);
		await Promise.resolve();
		expect(calls).toEqual(["first"]);
		releaseFirst?.();
		await expect(first).resolves.toBe("one");
		await expect(second).resolves.toBe("two");
		expect(calls).toEqual(["first", "second"]);
	});

	test("continues after a failed operation", async () => {
		const queue = new SerialOperationQueue();
		const first = queue.run(async () => {
			throw new Error("failed");
		});
		const second = queue.run(async () => "still runs");

		await expect(first).rejects.toThrow("failed");
		await expect(second).resolves.toBe("still runs");
	});

	test("rejects work submitted after close", async () => {
		const queue = new SerialOperationQueue();
		await queue.close();
		await expect(queue.run(async () => "nope")).rejects.toThrow("Operation queue is closed");
	});
});
