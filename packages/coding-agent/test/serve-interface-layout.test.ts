import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { expect, test } from "vitest";

test("conversation actions stay visible and settings preserve handlers, disclosure, drafts, and return position", async () => {
	const bundles = await Promise.all(
		["conversation-layout", "settings-presentation"].map((name) =>
			build({
				entryPoints: [resolve(`src/core/serve/browser/${name}.ts`)],
				bundle: true,
				platform: "browser",
				format: "iife",
				globalName: name === "conversation-layout" ? "conversation" : "settings",
				write: false,
			}),
		),
	);
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 841, height: 701 }, isMobile: true, hasTouch: true });
		page.setDefaultTimeout(5000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1">
		<style>:root{--bg:#09090a;--panel:#101012;--surface:#1a1a1e;--surface2:#24242a;--text:#f2f2f3;--muted:#92929b;--line:#2d2d33;--pi:#7eb5f5;--danger:#ef4444}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui}main{height:100dvh;display:flex;flex-direction:column;min-height:0}.header{height:50px;flex-shrink:0}#transcript{flex:1;overflow:auto;min-height:0;padding:20px}.chat-dock{height:100px;flex-shrink:0}#prompt{width:100%}.hidden{display:none!important}.rail{position:fixed;left:-500px}.settings-workspace{position:fixed;inset:0;background:var(--bg);display:grid;z-index:10}.settings-layout{display:grid;grid-template-columns:190px 1fr;min-height:0}.settings-content{overflow:auto}.settings-grid{display:grid;grid-template-columns:1fr 1fr}.configuration-form label{display:grid}.provider-field-row{display:flex}.provider-field-row input{flex:1}.settings-nav{display:grid}.settings-panel{max-width:900px;margin:auto}</style>
		<aside class="rail"><button id="open-settings">Settings</button><button aria-label="Configure Flight Finder">Configure</button></aside>
		<main><header class="header">Workspace</header><section id="transcript"></section><div class="chat-dock"><textarea id="prompt" aria-label="Message team"></textarea></div></main>
		<section id="settings-workspace" class="settings-workspace hidden"><header class="settings-header">Settings<button id="close-settings">Close</button></header><div class="settings-layout"><nav class="settings-nav"><button>Models</button><button>Connections</button><button>Capabilities</button><button>Plugins &amp; MCP</button><button>Security</button></nav><div class="settings-content"><section id="connections" class="settings-panel" data-settings-panel><div class="settings-grid" id="cards"></div></section></div></div></section>`);
		await page.evaluate(`(() => {
			window.schedule = document.createElement('details'); schedule.className='team-schedule'; schedule.dataset.roomId='flight';
			schedule.innerHTML='<summary>Schedule team</summary><form><label>Request<textarea aria-label="Schedule request"></textarea></label><div style="height:1200px"></div><div class="settings-form-actions"><button type="submit">Save paused</button></div></form>';
			schedule.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.scheduleSaved='true';e.target.dispatchEvent(new Event('settings-baseline'));};
			window.renderTeam = () => { const t=document.getElementById('transcript'); t.innerHTML='<header class="subagent-inspector-heading"><div class="message-label">Flight Finder</div></header><details data-team-detail="memory"><summary>Team memory and tools</summary><button>Review saved memory</button><p>Home airport: SGF</p></details><article style="height:2400px">Long chat</article>';t.insertBefore(schedule,t.children[1]); };
			renderTeam();
			document.querySelector('[aria-label="Configure Flight Finder"]').onclick=()=>{document.getElementById('transcript').innerHTML='<section class="promotion-dialog"><form><label>Name<input required value="Flight Finder"></label><details><summary>Advanced</summary><label>Rounds<input aria-label="Rounds" type="number" required min="1" value="12"></label></details><div style="height:1200px"></div><div class="promotion-actions"><button type="button">Cancel</button><button type="submit">Save team</button></div></form></section>';document.querySelector('.promotion-actions button').onclick=()=>{renderTeam();document.getElementById('prompt').value='';};};
			window.renderCard=()=>{document.getElementById('cards').innerHTML='<article class="settings-card" tabindex="-1" data-settings-resource="provider"><div class="settings-card-header"><strong>Flight data provider</strong></div><div class="capability-meta">Fare research</div><div class="settings-state">Configured</div><form class="configuration-form provider-configuration-form"><label>API key<div class="provider-field-row"><input name="api-key" aria-label="API key" value="original"><button class="provider-field-action" type="button" title="Save API key to vault">Save</button></div></label><div style="height:900px"></div></form><div class="settings-actions"><button type="button" id="disable-provider">Disable</button></div></article>';
			 document.querySelector('.provider-field-action').onclick=()=>{document.body.dataset.savedValue=document.querySelector('[name="api-key"]').value;renderCard();};document.getElementById('disable-provider').onclick=()=>document.body.dataset.disabled='true';};renderCard();
			document.getElementById('close-settings').onclick=()=>document.getElementById('settings-workspace').classList.add('hidden');
		})()`);
		for (const bundle of bundles) await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
		await page.evaluate("conversation.installConversationLayout();settings.installSettingsPresentation()");
		for (const viewport of [
			{ width: 393, height: 851 },
			{ width: 841, height: 701 },
			{ width: 1500, height: 900 },
		]) {
			await page.setViewportSize(viewport);
			await page.getByRole("textbox", { name: "Message team" }).fill("Keep my trip draft");
			await page.evaluate("document.getElementById('transcript').scrollTop=600");
			const scheduleButton = page.getByRole("button", { name: "Schedule", exact: true });
			const bounds = await scheduleButton.boundingBox();
			expect(bounds?.y).toBeLessThan(150);
			await scheduleButton.tap();
			await page.getByRole("textbox", { name: "Schedule request" }).fill("Prepare review drafts");
			// Activity can replace the transcript while the settings editor is open.
			await page.evaluate("renderTeam()");
			expect(await page.getByRole("textbox", { name: "Schedule request" }).inputValue()).toBe(
				"Prepare review drafts",
			);
			const saveBounds = await page.getByRole("button", { name: "Save paused" }).boundingBox();
			expect(saveBounds?.y).toBeLessThan(viewport.height - 100);
			await page.getByRole("button", { name: "Save paused" }).tap();
			expect(await page.locator("body").getAttribute("data-schedule-saved")).toBe("true");
			await page.getByRole("button", { name: "Memory", exact: true }).tap();
			expect(await page.getByText("Home airport: SGF").isVisible()).toBe(true);
			await page.getByRole("button", { name: "Back to chat" }).tap();
			await expect.poll(() => page.evaluate("document.getElementById('transcript').scrollTop")).toBe(600);
			await page.locator("#conversation-toolbar").getByRole("button", { name: "Configure", exact: true }).tap();
			await page.getByText("Advanced", { exact: true }).tap();
			await page.getByLabel("Rounds", { exact: true }).fill("0");
			await page.getByText("Advanced", { exact: true }).tap();
			await page.getByRole("button", { name: "Save team" }).tap();
			expect(await page.getByLabel("Rounds", { exact: true }).isVisible()).toBe(true);
			expect(await page.getByRole("alert").textContent()).toContain("1");
			await page.getByRole("button", { name: "Back to chat" }).tap();
			expect(await page.getByRole("textbox", { name: "Message team" }).inputValue()).toBe("Keep my trip draft");
			await expect.poll(() => page.evaluate("document.getElementById('transcript').scrollTop")).toBe(600);
		}
		await page.evaluate("document.getElementById('settings-workspace').classList.remove('hidden')");
		expect(await page.getByText("Configured", { exact: true }).isVisible()).toBe(true);
		expect(await page.getByRole("textbox", { name: "API key" }).isVisible()).toBe(false);
		await page.getByText("Flight data provider", { exact: true }).tap();
		await page.getByRole("textbox", { name: "API key" }).fill("new-value");
		expect(await page.getByText("Unsaved changes", { exact: true }).isVisible()).toBe(true);
		await page.getByRole("button", { name: "Discard edits" }).tap();
		expect(await page.getByRole("textbox", { name: "API key" }).inputValue()).toBe("original");
		await page.getByRole("textbox", { name: "API key" }).fill("saved-value");
		await page.getByRole("button", { name: "Save API key to vault", exact: true }).tap();
		expect(await page.locator("body").getAttribute("data-saved-value")).toBe("saved-value");
		await expect.poll(() => page.getByRole("textbox", { name: "API key" }).isVisible()).toBe(true);
		await page.getByRole("button", { name: "Disable", exact: true }).tap();
		expect(await page.locator("body").getAttribute("data-disabled")).toBe("true");
		expect(errors).toEqual([]);
	} finally {
		await browser.close();
	}
}, 45_000);
