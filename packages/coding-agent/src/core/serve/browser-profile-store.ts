import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type BrowserProfile = { kind: "ephemeral" } | { kind: "named"; id: string };

/** Owns named Playwright profile paths and keeps them separate from user browsers. */
export class BrowserProfileStore {
	readonly #profilesRoot: string;

	constructor(root: string) {
		this.#profilesRoot = resolve(root, "profiles");
	}

	async pathFor(profile: BrowserProfile): Promise<string | undefined> {
		if (profile.kind === "ephemeral") return undefined;
		if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(profile.id)) {
			throw new Error("Browser profile id contains unsupported characters");
		}
		const path = resolve(this.#profilesRoot, profile.id);
		const relativePath = relative(this.#profilesRoot, path);
		if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
			throw new Error("Browser profile escapes the profile store");
		}
		await mkdir(path, { recursive: true });
		return path;
	}
}
