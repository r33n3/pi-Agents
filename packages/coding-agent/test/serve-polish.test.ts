import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("populated team editor preserves members, tools and memory across sections and saves", async () => {
	const harness = await createHarness();
	const registry = new AgentRegistry(join(harness.tempDir, "serve"), { defaultWorkspace: harness.tempDir });
	for (const name of [
		"Supervisor",
		"Researcher",
		"Reporter",
		...Array.from({ length: 15 }, (_, i) => `Specialist ${i}`),
	]) {
		await registry.save({
			id: name.toLowerCase().replaceAll(" ", "-"),
			name,
			description: "Review data",
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
		const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, hasTouch: true });
		page.setDefaultTimeout(10_000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.goto(started.url);
		await page.getByRole("textbox", { name: "Message Pi", exact: true }).waitFor();
		await page.getByTitle("Create a team", { exact: true }).first().click();
		const editor = page.locator(".team-editor");
		await editor.getByLabel("Name", { exact: true }).fill("Flight Finder polish");
		await editor.getByLabel("Purpose", { exact: true }).fill("Compare flights and prepare review drafts");
		await editor.getByLabel("Team supervisor").selectOption("supervisor");
		await editor.getByRole("button", { name: /^Members/ }).click();
		expect(await editor.locator(".editor-roster .editor-member").count()).toBe(1);
		expect(await editor.getByLabel("Include Researcher", { exact: true }).isVisible()).toBe(false);
		await editor.getByText("Add member", { exact: true }).click();
		await editor.getByRole("searchbox", { name: "Search available agents" }).fill("Researcher");
		await editor.getByLabel("Include Researcher", { exact: true }).check();
		const researcher = editor.locator(".editor-roster .editor-member").filter({ hasText: "Researcher" });
		await researcher.getByText("Role and instructions", { exact: true }).click();
		await editor.getByLabel("Role for Researcher", { exact: true }).fill("Compare exact itineraries");
		await editor.getByLabel("Working notes for Researcher", { exact: true }).fill("Preserve fare source URLs");
		await editor.getByRole("button", { name: "Memory", exact: true }).click();
		await editor.getByLabel("Shared team notes", { exact: true }).fill("Home airport SGF; main cabin");
		await editor.getByRole("button", { name: "Tools", exact: true }).click();
		await editor.getByRole("searchbox", { name: "Search team tools" }).fill("Read workspace");
		expect(await editor.getByLabel("Read workspace files", { exact: true }).isChecked()).toBe(true);
		expect(await editor.getByLabel("List workspace files", { exact: true }).isVisible()).toBe(false);
		await editor.getByRole("button", { name: "Create team", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Flight Finder polish", exact: true }).waitFor();
		await page.locator("#conversation-toolbar").getByRole("button", { name: "Configure", exact: true }).click();
		for (const viewport of [
			{ width: 393, height: 851 },
			{ width: 841, height: 701 },
			{ width: 1500, height: 900 },
		]) {
			await page.setViewportSize(viewport);
			for (const section of ["Overview", "Members", "Tools", "Memory", "Advanced"]) {
				await editor
					.getByRole("navigation")
					.getByRole("button", { name: new RegExp(`^${section}`) })
					.click();
				const box = await editor.getByRole("button", { name: "Save team", exact: true }).boundingBox();
				expect(box).not.toBeNull();
				expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
				expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
			}
		}
		await editor.getByRole("button", { name: /^Members/ }).click();
		expect(await editor.locator(".editor-roster .editor-member").count()).toBe(2);
		await editor
			.locator(".editor-roster .editor-member")
			.filter({ hasText: "Researcher" })
			.getByText("Role and instructions", { exact: true })
			.click();
		expect(await editor.getByLabel("Role for Researcher", { exact: true }).inputValue()).toBe(
			"Compare exact itineraries",
		);
		expect(await editor.getByLabel("Working notes for Researcher", { exact: true }).inputValue()).toBe(
			"Preserve fare source URLs",
		);
		await editor.getByRole("button", { name: "Memory", exact: true }).click();
		expect(await editor.getByLabel("Shared team notes", { exact: true }).inputValue()).toBe(
			"Home airport SGF; main cabin",
		);
		await editor.getByRole("button", { name: "Tools", exact: true }).click();
		expect(await editor.getByLabel("List workspace files", { exact: true }).isChecked()).toBe(true);
		await editor.getByRole("button", { name: "Save team", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Flight Finder polish", exact: true }).waitFor();
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
		await host.close();
		harness.cleanup();
	}
}, 90_000);
