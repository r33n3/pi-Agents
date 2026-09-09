import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, test } from "vitest";

test("browser setup separates fields and preserves saved selections and site modes", async () => {
	const bundle = await build({
		entryPoints: [resolve("src/core/serve/browser/browser-setup.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		write: false,
	});
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 393, height: 851 } });
		const posts: unknown[] = [];
		const profiles = [{ id: "flight", name: "Flight Finder", access: "public-web", runtime: "managed-chromium" }];
		await page.route("http://fixture/**", async (route) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/")
				return route.fulfill({
					contentType: "text/html",
					body: '<style>*{box-sizing:border-box}body{font:14px system-ui}#browser{padding:16px}</style><section id="browser"></section>',
				});
			if (route.request().method() === "POST") posts.push(route.request().postDataJSON());
			await route.fulfill({
				json:
					url.pathname === "/browser/setup"
						? {
								profiles,
								sites: [{ id: "flights", name: "Flights", url: "https://example.com", mode: "browser" }],
							}
						: { tools: [{ id: "flight-api", name: "Flight API", capabilities: ["search"] }] },
			});
		});
		await page.goto("http://fixture/?token=test");
		await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
		await page.getByText("Browser and site setup", { exact: true }).click();
		await expect
			.poll(() => page.getByLabel("Saved browser profile", { exact: true }).locator("option").count())
			.toBe(2);
		await page.getByLabel("Saved browser profile", { exact: true }).selectOption("flight");
		expect(await page.getByLabel("Profile name", { exact: true }).inputValue()).toBe("Flight Finder");
		expect(await page.getByLabel("Site name", { exact: true }).isVisible()).toBe(false);
		const labels = (await page.evaluate(
			"Array.from(document.querySelectorAll('form:not([hidden]) label')).map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right};})",
		)) as Array<{ top: number; bottom: number; right: number }>;
		for (let i = 1; i < labels.length; i++) {
			expect(labels[i].top).toBeGreaterThan(labels[i - 1].bottom);
			expect(labels[i].right).toBeLessThanOrEqual(393);
		}
		await page.getByRole("button", { name: "Save browser profile", exact: true }).click();
		await expect.poll(() => page.getByRole("status").innerText()).toContain("Saved.");
		expect(await page.getByLabel("Saved browser profile", { exact: true }).inputValue()).toBe("flight");
		await page.getByRole("button", { name: "Site preferences", exact: true }).click();
		await page.getByLabel("Saved site preference", { exact: true }).selectOption("flights");
		expect(await page.getByLabel("Existing configured capability", { exact: true }).isVisible()).toBe(false);
		await page.getByLabel("Preferred site interface", { exact: true }).selectOption("connection");
		await page.getByLabel("Existing configured capability", { exact: true }).selectOption("flight-api");
		await page.getByRole("button", { name: "Save site preference", exact: true }).click();
		await expect.poll(() => posts.length).toBe(2);
		expect(posts[1]).toMatchObject({ sites: [{ connectionToolId: "flight-api", mode: "connection" }] });
		await page.getByLabel("Preferred site interface", { exact: true }).selectOption("browser");
		await page.getByRole("button", { name: "Save site preference", exact: true }).click();
		await expect.poll(() => posts.length).toBe(3);
		expect(posts[2]).toEqual({
			profiles: [],
			sites: [{ id: "flights", name: "Flights", url: "https://example.com", mode: "browser" }],
		});
	} finally {
		await browser.close();
	}
});

test("history reads structured summaries and retains review and retry handlers after filtering and refresh", async () => {
	const bundle = await build({
		entryPoints: [resolve("src/core/serve/browser/history-layout.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		globalName: "historyLayout",
		write: false,
	});
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<div id="agent-activity-list"></div><button aria-label="Delegate to an external agent"></button><details><summary>Delegation connections</summary><div id="external-connection-list"></div></details><details id="settings-connection-advanced"></details>',
		);
		await page.evaluate(
			`window.renderHistory=()=>{const list=document.getElementById('agent-activity-list');list.innerHTML='<button class="agent-activity-entry" data-status="completed"><span><strong>Flight Finder</strong><small></small></span><time datetime="2026-09-08T12:00:00Z">completed</time></button><div class="attention-entry-wrap"><button class="agent-activity-entry" data-status="failure"><span><strong>Run failed</strong><small>Provider unavailable</small></span><time datetime="2026-09-07T12:00:00Z">failure</time></button><button aria-label="Retry run">Retry</button></div>';const entry=list.firstChild;entry.title=JSON.stringify({outcome:'reply',message:'Prepared Gmail draft for review'});entry.querySelector('small').textContent=entry.title;entry.onclick=()=>document.body.dataset.reviewed='true';list.querySelector('[aria-label="Retry run"]').onclick=()=>document.body.dataset.retried='true';};renderHistory();`,
		);
		await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
		await page.evaluate("historyLayout.installHistoryLayout()");
		expect(await page.getByRole("button", { name: "Delegate to an external agent" }).count()).toBe(0);
		expect(await page.getByText("Delegation connections").count()).toBe(0);
		expect(await page.locator(".history-day").count()).toBe(2);
		expect(await page.locator("small").first().innerText()).toBe("Prepared Gmail draft for review");
		await page.getByRole("searchbox").fill("Gmail");
		expect(await page.getByRole("button", { name: "Retry run", exact: true }).isVisible()).toBe(false);
		await page.getByRole("button", { name: /Flight Finder/ }).click();
		expect(await page.locator("body").getAttribute("data-reviewed")).toBe("true");
		await page.evaluate("renderHistory()");
		await expect.poll(() => page.locator(".history-day").count()).toBe(2);
		await page.getByRole("searchbox").fill("");
		await page.getByRole("button", { name: "Retry run", exact: true }).click();
		expect(await page.locator("body").getAttribute("data-retried")).toBe("true");
		await page.evaluate(
			`renderHistory();const entry=document.querySelector('#agent-activity-list>.agent-activity-entry');entry.title=JSON.stringify({outcome:'reply',message:'Prepared another Gmail draft for review'}).slice(0,-10);entry.querySelector('small').textContent=entry.title;`,
		);
		await expect.poll(() => page.locator("small").first().innerText()).toBe("Prepared another Gmail draft fo…");
	} finally {
		await browser.close();
	}
});
