import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PersonaCatalog } from "../src/core/serve/persona-catalog.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(image: string): Promise<{ root: string; catalog: PersonaCatalog }> {
	const root = await mkdtemp(join(tmpdir(), "pi-personas-"));
	roots.push(root);
	await mkdir(join(root, "site", "src"), { recursive: true });
	await mkdir(join(root, "site", "public", "images"), { recursive: true });
	await writeFile(
		join(root, "site", "src", "personas.generated.json"),
		JSON.stringify([
			{
				name: "skeptical-engineer",
				displayName: "Skeptical Engineer",
				category: "Engineering",
				description: "Challenges assumptions",
				instructions: "Verify claims with evidence.",
				image,
			},
		]),
	);
	const catalog = new PersonaCatalog(root);
	await catalog.initialize();
	return { root, catalog };
}

describe("PersonaCatalog", () => {
	test("loads persona metadata and confined images", async () => {
		const { root, catalog } = await project("images/skeptic.png");
		await writeFile(join(root, "site", "public", "images", "skeptic.png"), new Uint8Array([1, 2, 3]));
		expect(catalog.list()).toMatchObject([{ id: "skeptical-engineer", name: "Skeptical Engineer" }]);
		await expect(catalog.readImage("skeptical-engineer")).resolves.toMatchObject({
			contentType: "image/png",
			data: new Uint8Array([1, 2, 3]),
		});
	});

	test("rejects image paths that escape the public directory", async () => {
		const { catalog } = await project("../../secret.png");
		await expect(catalog.readImage("skeptical-engineer")).rejects.toThrow("escapes the public directory");
	});
});
