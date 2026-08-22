import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RoutineRegistry } from "../src/core/serve/routine-registry.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RoutineRegistry", () => {
	test("persists target-independent routine definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-routine-registry-"));
		roots.push(root);
		const registry = new RoutineRegistry(root);
		const saved = await registry.save({
			name: "Morning review",
			prompt: "Review overnight changes",
			enabled: true,
			cron: "0 9 * * 1-5",
			timezone: "America/Chicago",
			maxDurationMinutes: 60,
			target: { kind: "acp", connectionId: "claude-code" },
			model: { provider: "anthropic", id: "claude-sonnet-5" },
			cwd: "C:\\workspace",
		});

		expect(saved.id).toBe("morning-review");
		expect(await registry.list()).toEqual([saved]);
		expect(JSON.parse(await readFile(join(root, "morning-review.json"), "utf8"))).toEqual(saved);
	});

	test("validates target-specific identifiers", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-routine-registry-"));
		roots.push(root);
		const registry = new RoutineRegistry(root);
		await expect(
			registry.save({
				name: "Invalid",
				prompt: "Run",
				enabled: true,
				cron: "* * * * *",
				timezone: "UTC",
				maxDurationMinutes: 5,
				target: { kind: "skill", skillName: "bad skill name" },
			}),
		).rejects.toThrow("unsupported characters");
	});
});
