export interface SessionListGeneration {
	readonly connectionEpoch: number;
	readonly requestGeneration: number;
}

/** Tracks work whose results are valid only for one live connection epoch. */
export class BrowserConnectionGeneration {
	#epoch = 0;
	#sessionListRequestGeneration = 0;

	get epoch(): number {
		return this.#epoch;
	}

	invalidate(): void {
		this.#epoch++;
		this.#sessionListRequestGeneration++;
	}

	beginSessionList(): SessionListGeneration {
		return {
			connectionEpoch: this.#epoch,
			requestGeneration: ++this.#sessionListRequestGeneration,
		};
	}

	isCurrent(epoch: number): boolean {
		return epoch === this.#epoch;
	}

	isSessionListCurrent(generation: SessionListGeneration): boolean {
		return (
			generation.connectionEpoch === this.#epoch &&
			generation.requestGeneration === this.#sessionListRequestGeneration
		);
	}
}

/** Tracks superseding session-selection intents across every connected host. */
export class BrowserSelectionGeneration {
	#generation = 0;

	get current(): number {
		return this.#generation;
	}

	begin(): number {
		return ++this.#generation;
	}

	invalidate(): void {
		this.#generation++;
	}

	isCurrent(generation: number): boolean {
		return generation === this.#generation;
	}

	async retainCurrentSession(
		generation: number,
		session: { dispose(): Promise<void> },
		connectionIsCurrent: () => boolean,
	): Promise<boolean> {
		if (this.isCurrent(generation) && connectionIsCurrent()) return true;
		await session.dispose().catch(() => {});
		return false;
	}
}
