import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type BrowserProfile = { kind: "ephemeral" } | { kind: "named"; id: string };

export interface BrowserProfileStatus {
	id: string;
	createdAt: number;
	updatedAt: number;
}

/** Owns named Playwright profile paths and keeps them separate from user browsers. */
export class BrowserProfileStore {
	readonly #profilesRoot: string;

	constructor(root: string) {
		this.#profilesRoot = resolve(root, "profiles");
	}

	async list(): Promise<BrowserProfileStatus[]> {
		await mkdir(this.#profilesRoot, { recursive: true });
		const entries = await readdir(this.#profilesRoot, { withFileTypes: true });
		const profiles = await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && isProfileId(entry.name))
				.map(async (entry) => {
					const details = await stat(this.#resolveProfile(entry.name));
					return { id: entry.name, createdAt: details.birthtimeMs, updatedAt: details.mtimeMs };
				}),
		);
		return profiles.sort((left, right) => left.id.localeCompare(right.id));
	}

	async clear(id: string): Promise<boolean> {
		const path = this.#resolveProfile(id);
		try {
			await rm(path, { recursive: true });
			return true;
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return false;
			throw error;
		}
	}

	async pathFor(profile: BrowserProfile): Promise<string | undefined> {
		if (profile.kind === "ephemeral") return undefined;
		const path = this.#resolveProfile(profile.id);
		await mkdir(path, { recursive: true });
		return path;
	}

	#resolveProfile(id: string): string {
		if (!isProfileId(id)) throw new Error("Browser profile id contains unsupported characters");
		const path = resolve(this.#profilesRoot, id);
		const relativePath = relative(this.#profilesRoot, path);
		if (isAbsolute(relativePath) || relativePath.startsWith("..")) {
			throw new Error("Browser profile escapes the profile store");
		}
		return path;
	}
}

function isProfileId(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
