import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import type { AgentRoutineState } from "../src/core/serve/agent-routine-scheduler.ts";

test("touch stop preserves the draft; team schedules default to drafts and need confirmation", async () => {
	const bundles = await Promise.all(
		["conversation-controls", "team-schedules"].map((name) =>
			build({
				entryPoints: [resolve(`src/core/serve/browser/${name}.ts`)],
				bundle: true,
				platform: "browser",
				format: "iife",
				globalName: name === "team-schedules" ? "schedules" : "controls",
				write: false,
			}),
		),
	);
	const browser = await chromium.launch({ headless: true });
	let saved: AgentRoutineState | undefined;
	let fingerprint = "a".repeat(64);
	try {
		const page = await browser.newPage({ viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true });
		page.setDefaultTimeout(5000);
		await page.route("http://pi.test/**", async (route) => {
			const url = new URL(route.request().url());
			let json: unknown;
			if (url.pathname === "/") {
				await route.fulfill({
					contentType: "text/html",
					body: '<meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--danger:#ff6666;--line:#444;--surface2:#222;--panel:#222}body{background:#111;color:#ddd;font-family:system-ui}input,textarea,select,button{font:inherit;max-width:100%;box-sizing:border-box}#composer{display:flex;position:fixed;bottom:0;left:0;right:0;background:#222;padding:12px;gap:8px}#prompt{flex:1;min-width:0}#transcript{padding-bottom:100px}</style><main id="transcript"></main><form id="composer"><textarea id="prompt" aria-label="Message team"></textarea></form>',
				});
				return;
			}
			if (url.pathname === "/team-schedules/review")
				json = {
					name: "Flight Finder",
					prompt: "Prepare a report and Gmail draft for review",
					configurationDigest: fingerprint,
				};
			else if (url.pathname === "/routines/preview") json = { next: [1_800_000_000_000] };
			else if (url.pathname === "/routines.json") json = { routines: saved ? [saved] : [] };
			else if (url.pathname === "/routines" || url.pathname === "/routines/test-schedule") {
				saved = {
					...route.request().postDataJSON(),
					id: "test-schedule",
					revision: (saved?.revision ?? 0) + 1,
				} as AgentRoutineState;
				json = saved;
			} else throw new Error(`Unexpected request ${url.pathname}`);
			await route.fulfill({ json });
		});
		await page.goto("http://pi.test/");
		for (const bundle of bundles) await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
		await page.evaluate("controls.installConversationControls()");
		for (const viewport of [
			{ width: 393, height: 851 },
			{ width: 841, height: 701 },
			{ width: 1104, height: 884 },
		]) {
			await page.setViewportSize(viewport);
			await page.evaluate(`(() => {
				const activity = document.createElement("article");
				activity.className = "agent-running";
				const button = document.createElement("button");
				button.textContent = "Stop team";
				button.addEventListener("click", () => {
					document.body.dataset.stopped = "yes";
					activity.remove();
				});
				activity.append(button);
				document.getElementById("transcript").append(activity);
			})()`);
			await page.getByRole("textbox", { name: "Message team" }).fill("Keep my steering draft");
			await page.getByRole("button", { name: "Stop execution", exact: true }).tap();
			expect(await page.getByRole("textbox", { name: "Message team" }).inputValue()).toBe("Keep my steering draft");
			await expect.poll(() => page.locator("#conversation-stop").isVisible()).toBe(false);
			expect(await page.locator("body").getAttribute("data-stopped")).toBe("yes");
		}
		await page.evaluate(
			'document.getElementById("transcript").append(schedules.teamScheduleControls("flight-team", "test-token"))',
		);
		await page.getByText("Schedule team", { exact: true }).click();
		await expect
			.poll(() => page.getByLabel("Schedule name", { exact: true }).inputValue())
			.toBe("Flight Finder schedule");
		expect(await page.getByLabel("Delivery", { exact: true }).inputValue()).toBe("draft");
		expect(await page.getByLabel("Cron", { exact: true }).isVisible()).toBe(false);
		expect(await page.getByLabel("Day", { exact: true }).isVisible()).toBe(true);
		await page.getByRole("button", { name: "Enable schedule", exact: true }).click();
		expect(saved).toBeUndefined();
		await page.getByRole("checkbox").check();
		await page.getByRole("button", { name: "Save paused", exact: true }).click();
		await expect.poll(() => saved?.target).toMatchObject({ kind: "team", delivery: "draft", confirmed: true });
		expect(saved?.enabled).toBe(false);
		fingerprint = "b".repeat(64);
		await page.getByRole("button", { name: "Enable schedule", exact: true }).click();
		await expect.poll(() => page.getByRole("status").textContent()).toContain("Team setup changed");
		expect(saved?.enabled).toBe(false);
		await page.getByRole("button", { name: "Review current setup", exact: true }).click();
		await expect.poll(() => page.getByRole("status").textContent()).toContain("Current tools");
		await page.getByRole("checkbox").check();
		await page.getByRole("button", { name: "Enable schedule", exact: true }).click();
		await expect.poll(() => saved?.enabled).toBe(true);
		await page.getByRole("button", { name: "Pause", exact: true }).click();
		await expect.poll(() => saved?.enabled).toBe(false);
		for (const choice of [
			{ repeat: "monthly", date: "31", month: "1", cron: "0 9 31 * *" },
			{ repeat: "yearly", date: "15", month: "12", cron: "0 9 15 12 *" },
		]) {
			await page.getByLabel("Repeat", { exact: true }).selectOption(choice.repeat);
			if (choice.repeat === "yearly") await page.getByLabel("Month", { exact: true }).selectOption(choice.month);
			await page.getByLabel("Day of month", { exact: true }).selectOption(choice.date);
			await page.getByLabel("Time zone", { exact: true }).fill("America/Chicago");
			await page.getByRole("button", { name: "Save paused", exact: true }).click();
			await expect.poll(() => saved?.cron).toBe(choice.cron);
			expect(saved?.timezone).toBe("America/Chicago");
			await page.getByRole("button", { name: "Edit", exact: true }).click();
			expect(await page.getByLabel("Repeat", { exact: true }).inputValue()).toBe(choice.repeat);
			expect(await page.getByLabel("Day of month", { exact: true }).inputValue()).toBe(choice.date);
			expect(await page.getByLabel("Day", { exact: true }).isVisible()).toBe(false);
		}
		await page.getByLabel("Month", { exact: true }).selectOption("2");
		await page.getByLabel("Day of month", { exact: true }).selectOption("28");
		await page.getByRole("button", { name: "Save paused", exact: true }).click();
		await expect.poll(() => saved?.cron).toBe("0 9 28 2 *");
	} finally {
		await browser.close();
	}
}, 30_000);
