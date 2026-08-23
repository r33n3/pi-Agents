import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";

describe("BrowserProfileStore", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	test("lists and clears named profiles without escaping its root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-profiles-"));
		roots.push(root);
		const store = new BrowserProfileStore(root);
		await store.pathFor({ kind: "named", id: "signed-in" });

		expect(await store.list()).toEqual([
			expect.objectContaining({ id: "signed-in", createdAt: expect.any(Number), updatedAt: expect.any(Number) }),
		]);
		expect(await store.clear("signed-in")).toBe(true);
		expect(await store.list()).toEqual([]);
		await expect(store.pathFor({ kind: "named", id: "../escape" })).rejects.toThrow("unsupported characters");
		await expect(store.clear("../escape")).rejects.toThrow("unsupported characters");
	});
});
