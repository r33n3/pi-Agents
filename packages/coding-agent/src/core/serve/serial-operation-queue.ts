/**
 * Serializes mutations for one serve-owned resource, such as a live session or
 * an isolated agent workspace. Callers receive their own result while the
 * queue owns ordering and shutdown of pending work.
 */
export class SerialOperationQueue {
	private tail: Promise<void> = Promise.resolve();
	private closed = false;

	run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Operation queue is closed"));

		const result = this.tail.then(async () => {
			if (this.closed) throw new Error("Operation queue is closed");
			return operation();
		});
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.tail;
	}
}
