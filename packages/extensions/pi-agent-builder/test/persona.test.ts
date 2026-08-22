import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { applyPersonaToAgent } from "../extensions/persona.ts";
import type { AgentConfig } from "../lib/agents.ts";
import { normalizePersonaName } from "../lib/persona-name.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persona identifiers", () => {
	test("normalizes display casing to the catalog identifier", () => {
		expect(normalizePersonaName("  Greybeard ")).toBe("greybeard");
	});

	test.each(["../greybeard", "grey/beard", "grey beard", ""])("rejects unsafe identifier %j", (name) => {
		expect(() => normalizePersonaName(name)).toThrow("Invalid persona name");
	});
});

test("persona application replaces an existing block without changing frontmatter", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-builder-"));
	temporaryDirectories.push(directory);
	const filePath = join(directory, "reviewer.md");
	await writeFile(
		filePath,
		"---\nname: reviewer\ndescription: Reviews code\n---\nBase prompt\n\n<!-- persona:start name=old -->\nOld\n<!-- persona:end -->\n",
	);
	const agent: AgentConfig = {
		name: "reviewer",
		description: "Reviews code",
		systemPrompt: "Base prompt",
		source: "user",
		filePath,
	};
	applyPersonaToAgent(agent, { name: "greybeard", skillBody: "# Greybeard\n\nPrefer proven systems." });
	const result = await readFile(filePath, "utf-8");
	expect(result).toContain("name: reviewer\ndescription: Reviews code");
	expect(result).toContain("<!-- persona:start name=greybeard -->");
	expect(result).toContain("Prefer proven systems.");
	expect(result).not.toContain("name=old");
});
