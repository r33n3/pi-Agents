/** Owns unsent text across conversation switches and delayed send failures. */
export class ConversationComposer {
	readonly #input: HTMLTextAreaElement;
	readonly #drafts = new Map<string, string>();
	#key: string | undefined;

	constructor(input: HTMLTextAreaElement) {
		this.#input = input;
		input.addEventListener("input", () => this.save());
		window.addEventListener("pagehide", () => this.save());
	}

	select(key: string | undefined): void {
		if (key === this.#key) return;
		this.save();
		this.#key = key;
		let draft = key ? this.#drafts.get(key) : "";
		if (draft === undefined && key) {
			try {
				draft = sessionStorage.getItem(`pi-composer:${key}`) ?? "";
			} catch {
				// Drafts remain available in memory if browser storage is disabled.
			}
		}
		this.#input.value = draft ?? "";
	}

	save(): void {
		if (this.#key) this.#store(this.#key, this.#input.value);
	}

	clear(key: string): void {
		this.#store(key, "");
		if (key === this.#key) this.#input.value = "";
	}

	restore(key: string, text: string): void {
		if (key === this.#key) {
			if (this.#input.value) return;
			this.#input.value = text;
		} else if (this.#drafts.get(key)) return;
		this.#store(key, text);
	}

	#store(key: string, text: string): void {
		this.#drafts.set(key, text);
		try {
			if (text) sessionStorage.setItem(`pi-composer:${key}`, text);
			else sessionStorage.removeItem(`pi-composer:${key}`);
		} catch {
			// Persistence is optional; navigation must keep working.
		}
	}
}
