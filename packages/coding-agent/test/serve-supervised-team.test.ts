import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import type { AgentExecutionResult } from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("creates a sidebar team, recruits a member, and continues in the same team", async () => {
	const harness = await createHarness();
	const registry = new AgentRegistry(join(harness.tempDir, "serve"), { defaultWorkspace: harness.tempDir });
	await registry.save({
		id: "supervisor",
		name: "Supervisor",
		description: "Organize specialists",
		persona: "Supervise",
		tools: ["read"],
		executor: "harness",
		permissionPolicy: "read-only",
		memory: "none",
		schedules: [],
	});
	const names: string[] = [];
	const executor = vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async (context) => {
		names.push(context.definition.name);
		const output =
			names.length === 1
				? {
						outcome: "reply",
						message: "Adding a data specialist to check the source",
						requestAgentIds: [],
						recruit: [{ name: "Data specialist", role: "Check source data" }],
					}
				: names.length === 4
					? { outcome: "needs-user", message: "Which source should we use?", requestAgentIds: [] }
					: {
							outcome: "reply",
							message: context.definition.name === "Supervisor" ? "Team review complete" : "Source checked",
							requestAgentIds: [],
						};
		let finish: (() => void) | undefined;
		const result =
			names.length === 8
				? new Promise<AgentExecutionResult>((resolve) => {
						finish = () => resolve({ output: JSON.stringify(output), transcript: [] });
					})
				: Promise.resolve({ output: JSON.stringify(output), transcript: [] });
		return {
			result,
			subscribe: () => () => {},
			abort: async () => {
				finish?.();
			},
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
		await page.getByRole("button", { name: "Create a team", exact: true }).first().click();
		const dialog = page.locator("dialog[open]");
		await dialog.getByLabel("Name", { exact: true }).fill("Source review");
		await dialog.getByLabel("Purpose", { exact: true }).fill("Check source data");
		await dialog.getByRole("combobox", { name: "Team supervisor", exact: true }).selectOption("supervisor");
		await dialog.getByLabel("Allow supervisor to add missing specialists (up to 8 members)", { exact: true }).check();
		await dialog.getByLabel("Goal", { exact: true }).fill("Check the source and recruit expertise if needed");
		await dialog.getByRole("button", { name: "Start team", exact: true }).click();
		await expect
			.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
			.toContain("Team review complete");
		expect(await page.locator("dialog[open]").count()).toBe(0);
		expect(names).toEqual(["Supervisor", "Data specialist", "Supervisor"]);
		await expect
			.poll(() => page.getByRole("group", { name: "Source review members", exact: true }).innerText())
			.toContain("Data specialist");
		const composer = page.getByRole("textbox", { name: "Message Source review", exact: true });
		await composer.fill("Keep this team draft");
		await page.locator("#session-tabs .session-tab").first().click();
		await expect.poll(() => page.getByRole("textbox", { name: "Message Pi", exact: true }).isVisible()).toBe(true);
		await page.getByRole("button", { name: "Talk to Supervisor in Source review", exact: true }).click();
		expect(await composer.inputValue()).toBe("Keep this team draft");
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await page
			.getByRole("textbox", { name: "Message Source review", exact: true })
			.fill("Summarize what you checked");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect.poll(() => names.length).toBe(4);
		await expect
			.poll(() => page.getByRole("button", { name: "Continue team", exact: true }).isVisible(), { timeout: 20_000 })
			.toBe(true);
		await composer.fill("Use the uploaded source");
		await page.getByRole("button", { name: "Continue team", exact: true }).click();
		await expect
			.poll(() => page.getByRole("button", { name: "Send to team", exact: true }).isVisible(), { timeout: 20_000 })
			.toBe(true);
		expect(names.length).toBe(5);
		await page.getByRole("button", { name: "Talk to Data specialist in Source review", exact: true }).click();
		expect(await composer.inputValue()).toBe("@Data specialist ");
		await composer.fill("@Data specialist check again");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect.poll(() => names.length, { timeout: 20_000 }).toBe(7);
		await expect
			.poll(() => page.getByRole("button", { name: "Send to team", exact: true }).isVisible(), { timeout: 20_000 })
			.toBe(true);
		expect(names.slice(-2)).toEqual(["Data specialist", "Supervisor"]);
		await expect
			.poll(() => page.getByRole("button", { name: "Send to team", exact: true }).isEnabled(), { timeout: 20_000 })
			.toBe(true);
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await page.getByRole("button", { name: "Manage Source review members", exact: true }).click();
		await page.getByRole("checkbox", { name: "Include Data specialist", exact: true }).uncheck();
		await page.getByRole("button", { name: "Save team", exact: true }).click();
		await expect
			.poll(() => page.getByRole("group", { name: "Source review members", exact: true }).innerText())
			.not.toContain("Data specialist");
		await composer.fill("Run a longer source review");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect.poll(() => names.length, { timeout: 20_000 }).toBe(8);
		await page.locator("#session-tabs .session-tab").first().click();
		await expect.poll(() => page.getByRole("textbox", { name: "Message Pi", exact: true }).isVisible()).toBe(true);
		await page.getByRole("button", { name: "Talk to Supervisor in Source review", exact: true }).click();
		await page.getByRole("button", { name: "Stop team", exact: true }).click();
		await expect
			.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
			.toContain("Room run was cancelled");
		await page.reload();
		await expect
			.poll(() => page.getByRole("group", { name: "Source review members", exact: true }).innerText())
			.toContain("Supervisor");
		await page.getByRole("button", { name: "Talk to Supervisor in Source review", exact: true }).click();
		await expect.poll(() => page.locator("#transcript").innerText()).toContain("Use the uploaded source");
		expect(await page.locator("dialog[open]").count()).toBe(0);
	} finally {
		await browser.close();
		await host.close();
		executor.mockRestore();
		harness.cleanup();
	}
}, 90_000);
