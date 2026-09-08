import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("touch navigation survives workspace chat, configuration, and fold resizing", async () => {
	const harness = await createHarness();
	const registry = new AgentRegistry(join(harness.tempDir, "serve"), { defaultWorkspace: harness.tempDir });
	for (const name of ["Alpha", "Beta"]) {
		await registry.save({
			id: name.toLowerCase(),
			name,
			description: "Navigation fixture",
			persona: "Review data",
			tools: ["read"],
			executor: "harness",
			permissionPolicy: "read-only",
			memory: "none",
			schedules: [],
		});
	}
	const host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
	const browser = await chromium.launch({ headless: true });
	try {
		const started = await host.start();
		const page = await browser.newPage({
			viewport: { width: 393, height: 851 },
			isMobile: true,
			hasTouch: true,
			userAgent:
				"Mozilla/5.0 (Linux; Android 14; Pixel Fold) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
		});
		page.setDefaultTimeout(10_000);
		await page.goto(started.url);
		for (const viewport of [
			{ width: 393, height: 851 },
			{ width: 841, height: 701 },
			{ width: 1104, height: 884 },
		]) {
			await page.setViewportSize(viewport);
			await page.reload();
			await page.getByRole("textbox", { name: "Message Pi", exact: true }).waitFor();
			// First interaction after loading: no composer focus, keyboard, or locator auto-scroll.
			const opener = page.getByRole("button", { name: "Open workspaces", exact: true });
			const bounds = await opener.boundingBox();
			if (!bounds) throw new Error("Workspace navigation button is missing");
			await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			await expect.poll(() => page.getByRole("searchbox", { name: "Find agents and teams" }).isVisible()).toBe(true);
			await page.getByRole("button", { name: "Close sessions", exact: true }).tap();
			await page.getByRole("textbox", { name: "Message Pi", exact: true }).fill("Keep this workspace draft");
			await page.getByRole("button", { name: "Open workspaces", exact: true }).tap();
			await page.getByRole("searchbox", { name: "Find agents and teams" }).waitFor();
			for (const name of ["Alpha", "Beta"]) {
				const row = page
					.locator(".session-row")
					.filter({ has: page.getByRole("button", { name: new RegExp(`^${name} `) }) });
				await row.locator("summary").tap();
				await row.getByRole("button", { name: "Configure", exact: true }).tap();
				await page.getByRole("textbox", { name: `Message Edit ${name}`, exact: true }).waitFor();
				await page.locator("#session-tabs .session-tab").first().tap();
				expect(await page.getByRole("textbox", { name: "Message Pi", exact: true }).inputValue()).toBe(
					"Keep this workspace draft",
				);
				await page.getByRole("button", { name: "Open workspaces", exact: true }).tap();
			}
			await page.getByRole("button", { name: "Close sessions", exact: true }).tap();
			await page.getByRole("button", { name: "Open history and browser workspace", exact: true }).tap();
			await page.locator('.details [data-tab="agents-workspace"]').waitFor();
			await page.getByRole("button", { name: "Close workspace", exact: true }).tap();
		}
		await page.reload();
		await page.getByRole("textbox", { name: "Message Pi", exact: true }).waitFor();
		await page.getByRole("button", { name: "Open workspaces", exact: true }).tap();
		await page.getByRole("searchbox", { name: "Find agents and teams" }).waitFor();
	} finally {
		await browser.close();
		await host.close();
		harness.cleanup();
	}
}, 90_000);
