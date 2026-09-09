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
	const prompts: string[] = [];
	let stopped = 0;
	let finishActive: (() => void) | undefined;
	const executor = vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async (context) => {
		names.push(context.definition.name);
		prompts.push(context.prompt);
		const output =
			names.length === 1
				? {
						outcome: "reply",
						message: "Adding a data specialist to check the source",
						requestAgentIds: [],
						recruit: [{ name: "Data specialist", role: "Check source data" }],
						remember: [{ key: "source-policy", text: "Use the provided source for this project", scope: "team" }],
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
			names.length === 8 || names.length === 10
				? new Promise<AgentExecutionResult>((resolve) => {
						finish = () => resolve({ output: JSON.stringify(output), transcript: [] });
						finishActive = finish;
					})
				: Promise.resolve({ output: JSON.stringify(output), transcript: [] });
		return {
			result,
			subscribe: () => () => {},
			abort: async () => {
				stopped++;
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
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
		await page.goto(started.url);
		await page.getByRole("button", { name: "Create a team", exact: true }).first().click();
		await page.getByRole("button", { name: "Build a team in chat", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Agent Builder", exact: true }).waitFor();
		expect(names).toHaveLength(0);
		await page.getByRole("button", { name: "Create a team", exact: true }).first().click();
		const dialog = page.getByRole("region", { name: "Create a team", exact: true });
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await dialog.getByLabel("Name", { exact: true }).fill("Source review");
		await dialog.getByRole("button", { name: /^Members/ }).click();
		await dialog.getByText("Role and instructions", { exact: true }).click();
		await dialog.getByLabel("Working notes for Supervisor", { exact: true }).fill("Keep summaries brief.");
		await dialog.getByRole("button", { name: "Memory", exact: true }).click();
		await dialog.getByLabel("Shared team notes", { exact: true }).fill("Use free tools for this project.");
		await dialog.getByRole("button", { name: "Tools", exact: true }).click();
		await dialog.getByLabel("Write workspace files", { exact: true }).check();
		await dialog.getByRole("button", { name: "Overview", exact: true }).click();
		await dialog.getByRole("combobox", { name: "Team supervisor", exact: true }).selectOption("supervisor");
		await dialog.getByLabel("Allow supervisor to add missing specialists (up to 8 members)", { exact: true }).check();
		await dialog.getByRole("button", { name: "Create team", exact: true }).click();
		await page.getByRole("textbox", { name: "Message Source review", exact: true }).waitFor();
		expect(names).toHaveLength(0);
		await page
			.getByRole("textbox", { name: "Message Source review", exact: true })
			.fill("Check the source and recruit expertise if needed");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect
			.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
			.toContain("Team review complete");
		expect(await page.locator("dialog[open]").count()).toBe(0);
		expect(names).toEqual(["Supervisor", "Data specialist", "Supervisor"]);
		await page.getByRole("button", { name: "Expand Source review", exact: true }).click();
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
		expect(await page.locator(".team-needs-user").innerText()).toContain("Which source should we use?");
		expect(await page.locator(".team-needs-user").innerText()).toContain("Reply below");
		expect(await page.locator("#transcript").getByText("Which source should we use?", { exact: true }).count()).toBe(
			0,
		);
		expect(await page.getByRole("button", { name: "Stop team", exact: true }).count()).toBe(0);
		expect(await page.locator("#conversation-stop").count()).toBe(0);
		await composer.fill("Use the uploaded source");
		await page.getByRole("button", { name: "Continue team", exact: true }).click();
		await expect.poll(() => page.locator("#phase").innerText(), { timeout: 20_000 }).toBe("Completed");
		expect(names.length).toBe(5);
		await page.getByRole("button", { name: "Talk to Data specialist in Source review", exact: true }).click();
		expect(await composer.inputValue()).toBe("@Data specialist ");
		await composer.fill("@Data specialist check again");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect.poll(() => names.length, { timeout: 20_000 }).toBe(7);
		await expect.poll(() => page.locator("#phase").innerText(), { timeout: 20_000 }).toBe("Completed");
		expect(names.slice(-2)).toEqual(["Data specialist", "Supervisor"]);
		await expect
			.poll(() => page.getByRole("button", { name: "Send to team", exact: true }).isEnabled(), { timeout: 20_000 })
			.toBe(true);
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await page.getByRole("button", { name: "Configure Source review", exact: true }).click();
		expect(await page.locator("dialog[open]").count()).toBe(0);
		await page.getByRole("region", { name: "Manage Source review", exact: true }).waitFor();
		await page.getByRole("button", { name: /^Members ·/ }).click();
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
		await composer.fill("Focus on the source discrepancies first");
		expect(await page.getByRole("button", { name: "Stop team", exact: true }).count()).toBe(1);
		expect(await page.getByRole("button", { name: "Send to team", exact: true }).count()).toBe(0);
		// Enter continues to submit steering; the single composer button cancels.
		await composer.press("Enter");
		await expect.poll(() => composer.inputValue()).toBe("");
		expect(names).toHaveLength(8);
		expect(stopped).toBe(0);
		finishActive?.();
		await expect.poll(() => names.length, { timeout: 20_000 }).toBe(9);
		await expect.poll(() => page.locator("#phase").innerText(), { timeout: 20_000 }).toBe("Completed");
		expect(stopped).toBe(0);
		expect(prompts[8]).toContain("Run a longer source review");
		expect(prompts[8]).toContain("Focus on the source discrepancies first");
		expect(prompts[8]).toContain("Keep summaries brief.");
		expect(prompts[8]).toContain("Use the provided source for this project");
		expect(prompts[8]).toContain("Use free tools for this project.");
		await composer.fill("Run another longer review");
		await page.getByRole("button", { name: "Send to team", exact: true }).click();
		await expect.poll(() => names.length, { timeout: 20_000 }).toBe(10);
		await expect.poll(() => page.locator("#composer-action").getAttribute("aria-label")).toBe("Stop team");
		expect(await page.locator("#transcript").getByRole("button", { name: "Stop team", exact: true }).count()).toBe(0);
		await page.setViewportSize({ width: 393, height: 851 });
		await composer.fill("Keep my unsent draft");
		await page.getByRole("button", { name: "Stop team", exact: true }).tap();
		await expect.poll(() => stopped).toBeGreaterThan(0);
		await expect
			.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
			.toContain("Room run was cancelled");
		await expect.poll(() => page.getByRole("button", { name: "Send to team", exact: true }).isEnabled()).toBe(true);
		expect(await composer.inputValue()).toBe("Keep my unsent draft");
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.reload();
		await page.getByRole("button", { name: "Collapse Source review", exact: true }).waitFor();
		await page.getByRole("button", { name: "Collapse Source review", exact: true }).click();
		expect(await page.getByRole("group", { name: "Source review members", exact: true }).isVisible()).toBe(false);
		await page.getByRole("button", { name: "Expand Source review", exact: true }).click();
		await expect
			.poll(() => page.getByRole("group", { name: "Source review members", exact: true }).innerText())
			.toContain("Supervisor");
		await page.getByRole("button", { name: "Talk to Supervisor in Source review", exact: true }).click();
		await expect.poll(() => page.locator("#transcript").innerText()).toContain("Use the uploaded source");
		await page.locator("#conversation-toolbar").getByRole("button", { name: "Memory", exact: true }).click();
		await page.getByRole("button", { name: "Review saved memory", exact: true }).click();
		await expect.poll(() => page.locator("#conversation-options").innerText()).toContain("source-policy");
		await page.getByRole("button", { name: "Back to chat", exact: true }).click();
		await page.getByRole("button", { name: "Configure Source review", exact: true }).click();
		await page.getByRole("button", { name: /^Members ·/ }).click();
		await page
			.locator(".editor-roster .editor-member")
			.filter({ hasText: "Supervisor" })
			.getByText("Role and instructions", { exact: true })
			.click();
		expect(await page.getByLabel("Working notes for Supervisor", { exact: true }).inputValue()).toBe(
			"Keep summaries brief.",
		);
		expect(await page.locator("dialog[open]").count()).toBe(0);
	} finally {
		await browser.close();
		await host.close();
		executor.mockRestore();
		harness.cleanup();
	}
}, 90_000);
