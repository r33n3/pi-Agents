import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BrowserOwner } from "./browser-session-manager.ts";

export interface BrowserArtifact {
	id: string;
	owner: BrowserOwner;
	kind: "screenshot";
	path: string;
	createdAt: number;
	size: number;
}

/** Persists explicit browser evidence under the serving Pi's private data root. */
export class BrowserArtifactStore {
	readonly #root: string;

	constructor(root: string) {
		this.#root = resolve(root, "artifacts");
	}

	async saveScreenshot(owner: BrowserOwner, png: Uint8Array): Promise<BrowserArtifact> {
		const directory = this.#ownerDirectory(owner);
		await mkdir(directory, { recursive: true });
		const id = randomUUID();
		const path = resolve(directory, `${id}.png`);
		await writeFile(path, png, { flag: "wx" });
		return { id, owner: { ...owner }, kind: "screenshot", path, createdAt: Date.now(), size: png.byteLength };
	}

	async list(owner: BrowserOwner): Promise<BrowserArtifact[]> {
		const directory = this.#ownerDirectory(owner);
		let files: string[];
		try {
			files = (await readdir(directory)).filter((file) => file.endsWith(".png"));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
			throw error;
		}
		return await Promise.all(
			files.map(async (file) => {
				const path = resolve(directory, file);
				const metadata = await stat(path);
				return {
					id: file.slice(0, -".png".length),
					owner: { ...owner },
					kind: "screenshot" as const,
					path,
					createdAt: metadata.mtimeMs,
					size: metadata.size,
				};
			}),
		);
	}

	async read(owner: BrowserOwner, id: string): Promise<Uint8Array | undefined> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Browser artifact id is invalid");
		try {
			return new Uint8Array(await readFile(resolve(this.#ownerDirectory(owner), `${id}.png`)));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	#ownerDirectory(owner: BrowserOwner): string {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner.id)) throw new Error("Browser owner id is invalid");
		const directory = resolve(this.#root, owner.kind, owner.id);
		const pathFromRoot = relative(this.#root, directory);
		if (isAbsolute(pathFromRoot) || pathFromRoot.startsWith(".."))
			throw new Error("Browser artifact path escapes the store");
		return directory;
	}
}
