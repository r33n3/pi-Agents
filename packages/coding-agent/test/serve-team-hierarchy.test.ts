import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("creates and runs a coordinator through the main chat with linked child conversations", async () => {
	const harness = await createHarness();
	const registry = new AgentRegistry(join(harness.tempDir, "serve"), { defaultWorkspace: harness.tempDir });
	for (const id of ["manager", "designer", "reviewer"])
		await registry.save({
			id,
			name: id,
			description: id,
			persona: id,
			tools: [],
			executor: "harness",
			permissionPolicy: "read-only",
			memory: "none",
			schedules: [],
		});
	const order: string[] = [];
	let managerTurns = 0;
	const executor = vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async (context) => {
		order.push(context.definition.id);
		let requestTeam: { teamId: string; goal: string } | undefined;
		let message =
			context.definition.id === "designer" ? "Design evidence: one room" : "Review evidence: scope is feasible";
		if (context.definition.id === "manager") {
			managerTurns++;
			if (managerTurns === 1) requestTeam = { teamId: "design", goal: "Propose a tiny prototype" };
			if (managerTurns === 2) {
				expect(context.prompt).toContain("Design evidence: one room");
				requestTeam = { teamId: "review", goal: "Check the one-room prototype scope" };
			}
			message = requestTeam
				? `Please ${requestTeam.goal.toLowerCase()}.`
				: "Prototype scope completed by Design and checked by Review.";
		}
		return {
			result: Promise.resolve({
				output: JSON.stringify({
					outcome: "reply",
					message,
					requestAgentIds: [],
					...(requestTeam ? { requestTeam } : {}),
				}),
				transcript: [],
			}),
			subscribe: () => () => {},
			abort: async () => {},
			dispose: async () => {},
			[Symbol.asyncDispose]: async () => {},
		};
	});
	const host = new ServeHost({ agentDir: harness.tempDir, session: harness.session, host: "127.0.0.1", port: 0 });
	const browser = await chromium.launch({ headless: true });
	try {
		const started = await host.start();
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
		await page.goto(started.url);
		for (const [name, supervisor] of [
			["Design", "designer"],
			["Review", "reviewer"],
			["Studio", "manager"],
		]) {
			await page.getByRole("button", { name: "Create a team", exact: true }).first().click();
			const form = page.getByRole("region", { name: "Create a team", exact: true });
			await form.getByLabel("Name", { exact: true }).fill(name!);
			await form.getByRole("combobox", { name: "Team supervisor", exact: true }).selectOption(supervisor!);
			if (name === "Studio") {
				await form.getByRole("button", { name: "Advanced", exact: true }).click();
				await form.getByText("Teams this coordinator may assign", { exact: true }).click();
				await form.getByLabel("Coordinate Design", { exact: true }).check();
				await form.getByLabel("Coordinate Review", { exact: true }).check();
			}
			await form.getByRole("button", { name: "Create team", exact: true }).click();
			await page.getByRole("textbox", { name: `Message ${name}`, exact: true }).waitFor();
		}
		expect(order).toEqual([]);
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await page
			.getByRole("textbox", { name: "Message Studio", exact: true })
			.fill("Use the selected teams to scope and check a prototype");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect
			.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
			.toContain("Prototype scope completed by Design and checked by Review.");
		expect(order).toEqual(["manager", "designer", "manager", "reviewer", "manager"]);
		await page.getByText("Design · completed", { exact: true }).click();
		await page.locator("#transcript").getByRole("button", { name: "Open Design", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Design", exact: true }).waitFor();
		expect(await page.locator("#transcript").textContent()).toContain("From Studio");
		await page.locator("#transcript").getByRole("button", { name: "Open Studio", exact: true }).click();
		await page.getByRole("button", { name: "Expand Studio", exact: true }).click();
		await page.getByRole("button", { name: "Open Review from Studio", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Review", exact: true }).waitFor();
		await page.reload();
		await page.getByRole("button", { name: "Open Review from Studio", exact: true }).click();
		expect(await page.locator("#transcript").innerText()).toContain("Review evidence: scope is feasible");
		expect(await page.locator("dialog[open]").count()).toBe(0);
	} finally {
		await browser.close();
		await host.close();
		executor.mockRestore();
		harness.cleanup();
	}
}, 90_000);
