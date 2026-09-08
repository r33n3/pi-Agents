import { chromium } from "playwright";
import { expect, test } from "vitest";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test.each(["browser-client.js", "agents.json", "capabilities.json"])(
	"startup hides the unfinished workspace while %s loads",
	async (resource) => {
		const harness = await createHarness();
		const host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
		const browser = await chromium.launch({ headless: true });
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const { url } = await host.start();
			const page = await browser.newPage({ viewport: { width: 841, height: 701 }, hasTouch: true, isMobile: true });
			await page.route(`**/${resource}?*`, async (route) => {
				await held;
				await route.continue();
			});
			await page.goto(url, { waitUntil: "commit" });
			await page.getByRole("region", { name: "Opening workspace", exact: true }).waitFor();
			expect(await page.locator("main").isVisible()).toBe(false);
			expect(await page.getByRole("textbox", { name: "Message Pi", exact: true }).isVisible()).toBe(false);
			expect(await page.getByRole("link", { name: "Retry opening workspace" }).isVisible()).toBe(true);
			release();
			await page.getByRole("textbox", { name: "Message Pi", exact: true }).waitFor();
			expect(await page.locator("#workspace-startup").count()).toBe(0);
			await page.getByRole("button", { name: "Open workspaces", exact: true }).tap();
			await page.getByRole("searchbox", { name: "Find agents and teams" }).waitFor();
		} finally {
			release();
			await browser.close();
			await host.close();
			harness.cleanup();
		}
	},
	60_000,
);

test("startup shows a failed request and Retry reloads successfully", async () => {
	const harness = await createHarness();
	const host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
	const browser = await chromium.launch({ headless: true });
	try {
		const { url } = await host.start();
		const page = await browser.newPage();
		let failing = true;
		await page.route("**/agents.json?*", (route) =>
			failing ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue(),
		);
		await page.goto(url);
		await expect.poll(() => page.locator("#workspace-startup-message").innerText()).toContain("HTTP 503");
		expect(await page.locator("main").isVisible()).toBe(false);
		failing = false;
		const reloaded = page.waitForEvent("load");
		await page.getByRole("link", { name: "Retry opening workspace" }).click();
		await reloaded;
		await page.getByRole("textbox", { name: "Message Pi", exact: true }).waitFor();
		expect(await page.locator("#workspace-startup").count()).toBe(0);
	} finally {
		await browser.close();
		await host.close();
		harness.cleanup();
	}
}, 60_000);

test("a stalled startup times out and late data does not dismiss the error", async () => {
	const harness = await createHarness();
	const host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
	const browser = await chromium.launch({ headless: true });
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	try {
		const { url } = await host.start();
		const page = await browser.newPage();
		await page.clock.install();
		await page.route("**/capabilities.json?*", async (route) => {
			await held;
			await route.continue();
		});
		await page.goto(url);
		await expect.poll(() => page.locator("#workspace-startup-message").innerText()).toContain("Loading agents");
		await page.clock.fastForward(31_000);
		await expect.poll(() => page.locator("#workspace-startup-message").innerText()).toContain("took too long");
		const completed = page.waitForResponse("**/capabilities.json?*");
		release();
		await completed;
		expect(await page.locator("main").isVisible()).toBe(false);
		expect(await page.getByRole("link", { name: "Retry opening workspace" }).isVisible()).toBe(true);
	} finally {
		release();
		await browser.close();
		await host.close();
		harness.cleanup();
	}
}, 60_000);
