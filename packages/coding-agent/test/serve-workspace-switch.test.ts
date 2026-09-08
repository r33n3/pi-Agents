import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("switching workspace loads the destination roster, teams, and settings", async () => {
	const first = await createHarness();
	const second = await createHarness();
	const hosts: ServeHost[] = [];
	const browser = await chromium.launch({ headless: true });
	try {
		const urls: string[] = [];
		for (const [index, harness] of [first, second].entries()) {
			const name = index === 0 ? "Travel" : "Studio";
			const connections = new CapabilityConnectionRegistry(
				join(harness.tempDir, "serve", "capabilities", "connections"),
			);
			await connections.save({
				id: "test-account",
				providerId: "google-workspace",
				accountLabel: `${name} account`,
				secretRef: "managed:google-workspace",
				scopes: [],
				capabilityIds: [],
				status: "active",
			});
			const host = new ServeHost({
				agentDir: harness.tempDir,
				capabilitySettingsDir: harness.tempDir,
				session: harness.session,
				host: "127.0.0.1",
				port: 0,
			});
			hosts.push(host);
			const { url } = await host.start();
			urls.push(url);
			const endpoint = new URL(url);
			endpoint.pathname = "/agents";
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `${name} helper`,
					description: "Workspace fixture",
					persona: "Help with this workspace",
					tools: ["read"],
					memory: "none",
					executor: "harness",
					permissionPolicy: "read-only",
					schedules: [],
				}),
			});
			expect(response.status).toBe(201);
			const agent = (await response.json()) as { id: string };
			endpoint.pathname = "/agent-rooms";
			const team = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `${name} team`,
					purpose: "Workspace fixture",
					members: [{ agentId: agent.id, role: "supervisor" }],
					supervisorAgentId: agent.id,
				}),
			});
			expect(team.status).toBe(201);
		}
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		await page.goto(urls[0]);
		await page.getByRole("button", { name: /^Travel team/ }).waitFor();
		expect(await page.getByRole("button", { name: "Connect another workspace", exact: true }).count()).toBe(0);
		await page.goto(urls[1]);
		await page.waitForURL((url) => url.origin === new URL(urls[1]).origin);
		await page.getByRole("button", { name: /^Studio team/ }).waitFor();
		expect(await page.getByRole("button", { name: /^Travel team/ }).count()).toBe(0);
		expect(await page.locator("#connection-list > .connection-group:not(.agent-navigation-group)").count()).toBe(1);
		await page.getByRole("button", { name: "Open Settings", exact: true }).click();
		await page.getByRole("button", { name: "Connections", exact: true }).click();
		await expect.poll(() => page.locator("#settings-connection-list").innerText()).toContain("Studio account");
		expect(await page.locator("#settings-connection-list").innerText()).not.toContain("Travel account");
		await page.goto(urls[0]);
		await page.getByRole("button", { name: /^Travel team/ }).waitFor();
		expect(await page.getByRole("button", { name: /^Studio team/ }).count()).toBe(0);
	} finally {
		await browser.close();
		for (const host of hosts) await host.close();
		first.cleanup();
		second.cleanup();
	}
}, 60_000);
