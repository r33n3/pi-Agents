import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test("natural team request shows review, launches one chat, and passes specialist results to the coordinator", async () => {
	const harness = await createHarness({ tokenSize: { min: 4096, max: 4096 } });
	await writeFile(join(harness.tempDir, "inventory.csv"), "item,quantity,unit_price\nnotebooks,4,4\npens,5,2\n");
	const prompts: string[] = [];
	let failChecker = false;
	const executor = vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async (context) => {
		prompts.push(context.prompt);
		if (failChecker && context.definition.name === "Checker") throw new Error("Checker unavailable for this test");
		return {
			result: Promise.resolve({
				output: context.definition.name === "Coordinator" ? "Verified team report" : "Checked inventory: 26 USD",
				transcript: [],
				inputEvidence: context.inputBinding?.files,
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
		await page.getByRole("button", { name: "Build a new agent", exact: true }).click();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("configure_team", {
					name: "Inventory team",
					steps: [
						{ name: "Reader", instructions: "Read inventory", tools: ["read"] },
						{ name: "Checker", instructions: "Check the reader result", tools: ["read"] },
						{ name: "Coordinator", instructions: "Summarize the checked result", tools: [] },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Review the three roles and launch your team."),
		]);
		await page.getByRole("textbox", { name: "Message Agent Builder" }).fill("Build an inventory review team.");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "Launch team", exact: true }).click({ timeout: 30_000 });
		await expect
			.poll(() => page.getByRole("textbox", { name: "Message Coordinator", exact: true }).isVisible(), {
				timeout: 15_000,
			})
			.toBe(true);
		await page.getByRole("textbox", { name: "Message Coordinator", exact: true }).fill("Review inventory.csv");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => page.locator("article").filter({ hasText: "Verified team report" }).isVisible(), {
				timeout: 20_000,
			})
			.toBe(true);
		expect(prompts).toHaveLength(3);
		expect(prompts[1]).toContain("Checked inventory: 26 USD");
		expect(prompts[2]).toContain("Checked inventory: 26 USD");
		expect(await page.locator("article.agent-team-run").innerText()).not.toContain("Checked inventory: 26 USD");
		await page.getByText("Team steps", { exact: true }).click();
		expect(await page.locator("article.agent-team-run").innerText()).toContain("Checked inventory: 26 USD");
		failChecker = true;
		await page.getByRole("textbox", { name: "Message Coordinator", exact: true }).fill("Review another inventory");
		await page.keyboard.press("Enter");
		await expect
			.poll(() => page.locator("article.agent-team-run").innerText(), { timeout: 20_000 })
			.toContain("TEAM · FAILED");
		expect(await page.locator("article.agent-team-run").innerText()).toContain("Checker unavailable for this test");
		expect(prompts).toHaveLength(5);
		expect(prompts[3]).toContain("Current user request:\nReview another inventory");
	} finally {
		await browser.close();
		await host.close();
		executor.mockRestore();
		harness.cleanup();
	}
}, 90_000);
