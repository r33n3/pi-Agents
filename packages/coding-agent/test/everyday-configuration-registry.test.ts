import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EverydayConfigurationRegistry } from "../src/core/serve/everyday-configuration-registry.ts";

describe("EverydayConfigurationRegistry", () => {
	let root: string;
	let registry: EverydayConfigurationRegistry;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-everyday-config-"));
		registry = new EverydayConfigurationRegistry(root);
		await registry.initialize();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("persists monitors and normalized watchlists across restart", async () => {
		await registry.saveMonitor({
			id: "release-notes",
			name: "Release notes",
			url: "https://example.com/news",
			enabled: true,
		});
		await registry.saveWatchlist({
			id: "daily-markets",
			name: "Daily markets",
			symbols: ["msft", "AAPL", "MSFT"],
			enabled: true,
		});

		const restored = new EverydayConfigurationRegistry(root);
		await restored.initialize();
		expect(restored.snapshot()).toMatchObject({
			monitors: [{ id: "release-notes", url: "https://example.com/news", enabled: true }],
			watchlists: [{ id: "daily-markets", symbols: ["AAPL", "MSFT"], enabled: true }],
		});
	});

	test("rejects unsafe configuration shapes and deletes idempotently", async () => {
		await expect(
			registry.saveMonitor({ id: "local", name: "Local", url: "file:///etc/passwd", enabled: true }),
		).rejects.toThrow("HTTP or HTTPS");
		await expect(
			registry.saveWatchlist({ id: "bad", name: "Bad", symbols: ["AAPL;DROP"], enabled: true }),
		).rejects.toThrow("invalid symbol");
		expect(await registry.deleteMonitor("missing")).toBe(false);
	});
});
