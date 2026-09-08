/** Coalesce overlapping event/poll refreshes, retaining a trailing refresh for new events. */
export class ActivityRefresh {
	#pending: Promise<void> | undefined;
	#again = false;
	readonly #load: () => Promise<void>;
	readonly #values = new Map<string, string>();

	constructor(load: () => Promise<void>) {
		this.#load = load;
	}

	refresh(): Promise<void> {
		this.#again = true;
		if (!this.#pending) {
			this.#pending = Promise.resolve().then(async () => {
				try {
					do {
						this.#again = false;
						await this.#load();
					} while (this.#again);
				} finally {
					this.#pending = undefined;
				}
			});
		}
		return this.#pending;
	}

	changed(section: string, value: unknown): boolean {
		const signature = JSON.stringify(value);
		if (this.#values.get(section) === signature) return false;
		this.#values.set(section, signature);
		return true;
	}
}
