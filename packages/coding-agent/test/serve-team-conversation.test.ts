import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness } from "./suite/harness.ts";

test.each(["builder", "main chat", "reload"])(
	"team review in %s launches one chat and passes specialist results to the coordinator",
	async (view) => {
		const harness = await createHarness({ tokenSize: { min: 4096, max: 4096 } });
		await writeFile(join(harness.tempDir, "inventory.csv"), "item,quantity,unit_price\nnotebooks,4,4\npens,5,2\n");
		const prompts: string[] = [];
		const names: string[] = [];
		let failChecker = false;
		let releaseFirst = () => {};
		const firstTurnGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const executor = vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async (context) => {
			prompts.push(context.prompt);
			names.push(context.definition.name);
			if (view === "builder" && prompts.length === 1) await firstTurnGate;
			if (failChecker && context.definition.name === "Checker") throw new Error("Checker unavailable for this test");
			const goal =
				context.prompt
					.split("Current user goal for this run (the only completion target):\n")
					.at(-1)
					?.split("\n\nCurrent member cards")[0] ?? "";
			const prefix = context.definition.id.replace(/step-\d+$/, "step-");
			const output =
				context.definition.name === "Coordinator"
					? goal.startsWith("Hello")
						? { message: "Hello. What would you like the team to do?", requestAgentIds: [] }
						: goal.startsWith("What tools")
							? { message: "Reader and Checker have read tools. I coordinate their work.", requestAgentIds: [] }
							: goal.startsWith("What was") || context.prompt.includes("Round 3 ·")
								? { message: "Verified team report: 26 USD", requestAgentIds: [] }
								: {
										message: "Reader, read the requested inventory and ask Checker to verify it.",
										requestAgentIds: [`${prefix}1`],
									}
					: {
							message: "Checked inventory: 26 USD",
							requestAgentIds: context.definition.name === "Reader" ? [`${prefix}2`] : [],
						};
			return {
				result: Promise.resolve({
					output: JSON.stringify({ outcome: "reply", ...output }),
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
			await page.addInitScript(() => {
				const sockets: WebSocket[] = [];
				Object.assign(globalThis, { testSockets: sockets });
				globalThis.WebSocket = class extends WebSocket {
					constructor(...args: ConstructorParameters<typeof WebSocket>) {
						super(...args);
						sockets.push(this);
					}
				};
			});
			page.setDefaultTimeout(15_000);
			await page.goto(started.url);
			if (view === "builder") await page.getByRole("button", { name: "Build a new agent", exact: true }).click();
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("configure_team", {
						name: "Inventory team",
						steps: [
							{ name: "Reader", instructions: "Read inventory", tools: ["read"], capabilities: [] },
							{ name: "Checker", instructions: "Check the reader result", tools: ["read"], capabilities: [] },
							{ name: "Coordinator", instructions: "Summarize the checked result", tools: [], capabilities: [] },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Review the three roles and launch your team."),
			]);
			await page
				.getByRole("textbox", { name: view === "builder" ? "Message Agent Builder" : "Message Pi", exact: true })
				.fill("Build an inventory review team.");
			await page.keyboard.press("Enter");
			await page
				.getByText("Review the three roles and launch your team.", { exact: true })
				.waitFor({ timeout: 30_000 });
			if (view === "reload") await page.reload();
			const teams = page.getByRole("region", { name: "Teams", exact: true });
			await teams.getByRole("button", { name: "Review Inventory team", exact: true }).click();
			await teams.getByRole("button", { name: "Expand Inventory team", exact: true }).click();
			expect(await teams.getByRole("group", { name: "Inventory team members", exact: true }).innerText()).toContain(
				"Coordinator",
			);
			const review = page.locator("#transcript .team-review");
			await expect.poll(() => review.innerText(), { timeout: 30_000 }).toContain("Inventory team");
			expect(await review.innerText()).toContain("Check the reader result");
			expect(await review.innerText()).toContain("Tools: read");
			expect(prompts).toHaveLength(0);
			if (view === "reload") {
				await page.route("**/agent-teams/launch?*", (route) =>
					route.fulfill({
						status: 409,
						contentType: "application/json",
						body: JSON.stringify({ error: "Review is stale; prepare the team again" }),
					}),
				);
				await review.getByRole("button", { name: "Launch team", exact: true }).click();
				await expect.poll(() => review.getByRole("alert").innerText()).toContain("Review is stale");
				expect(prompts).toHaveLength(0);
				await page.unroute("**/agent-teams/launch?*");
			}
			await page.getByRole("button", { name: "Launch team", exact: true }).click({ timeout: 30_000 });
			await expect
				.poll(() => page.getByRole("textbox", { name: "Message Inventory team", exact: true }).isVisible(), {
					timeout: 15_000,
				})
				.toBe(true);
			expect(await teams.getByRole("button", { name: "Open Inventory team", exact: true }).count()).toBe(1);
			expect(await teams.getByRole("button", { name: "Review Inventory team", exact: true }).count()).toBe(0);
			expect(await page.locator(".agent-navigation-group > .session-row").count()).toBe(0);
			await teams.getByRole("button", { name: "Collapse Inventory team", exact: true }).click();
			expect(await teams.getByRole("group", { name: "Inventory team members", exact: true }).isVisible()).toBe(
				false,
			);
			await page.reload();
			await teams.getByRole("button", { name: "Open Inventory team", exact: true }).waitFor();
			await review.getByRole("button", { name: "Open team", exact: true }).waitFor();
			expect(await teams.getByRole("group", { name: "Inventory team members", exact: true }).isVisible()).toBe(
				false,
			);
			await teams.getByRole("button", { name: "Expand Inventory team", exact: true }).click();
			await teams.getByRole("button", { name: "Talk to Reader in Inventory team", exact: true }).click();
			await page.getByRole("textbox", { name: "Message Reader", exact: true }).waitFor();
			await page.getByRole("textbox", { name: "Message Reader", exact: true }).fill("Unsent reader question");
			await teams.getByRole("button", { name: "Open Inventory team", exact: true }).click();
			await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).waitFor();
			expect(await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).inputValue()).toBe("");
			await page
				.getByRole("textbox", { name: "Message Inventory team", exact: true })
				.fill("Unsent coordinator question");
			await teams.getByRole("button", { name: "Talk to Reader in Inventory team", exact: true }).click();
			expect(await page.getByRole("textbox", { name: "Message Reader", exact: true }).inputValue()).toBe(
				"Unsent reader question",
			);
			await page.reload();
			await teams.getByRole("button", { name: "Open Inventory team", exact: true }).click();
			expect(await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).inputValue()).toBe(
				"Unsent coordinator question",
			);
			if (view === "reload") {
				await page.route("**/agent-rooms/*/message?*", (route) =>
					route.fulfill({
						status: 503,
						contentType: "application/json",
						body: JSON.stringify({ error: "Team temporarily unavailable" }),
					}),
				);
				await page
					.getByRole("textbox", { name: "Message Inventory team", exact: true })
					.fill("Retry this team request");
				await page.keyboard.press("Enter");
				await expect
					.poll(() => page.getByRole("textbox", { name: "Message Inventory team", exact: true }).inputValue())
					.toBe("Retry this team request");
				expect(prompts).toHaveLength(0);
				await page.unroute("**/agent-rooms/*/message?*");
			}
			expect(await page.locator("dialog[open]").count()).toBe(0);
			expect(prompts).toHaveLength(0);
			await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).fill("Review inventory.csv");
			if (view === "main chat") {
				const selectedModel = await page.locator("#model").inputValue();
				await page.evaluate(() => {
					const sockets = (globalThis as typeof globalThis & { testSockets: WebSocket[] }).testSockets;
					for (const socket of sockets) socket.close();
				});
				await expect
					.poll(() =>
						page.evaluate(() => {
							const sockets = (globalThis as typeof globalThis & { testSockets: WebSocket[] }).testSockets;
							return sockets.length > 1 && sockets.at(-1)?.readyState === WebSocket.OPEN;
						}),
					)
					.toBe(true);
				await expect.poll(() => page.locator("#status").innerText()).not.toMatch(/Connecting|Reconnecting/);
				await expect.poll(() => page.locator("#prompt").isEnabled(), { timeout: 15_000 }).toBe(true);
				expect(await page.locator("#model").inputValue()).toBe(selectedModel);
				expect(await page.locator("#model").isDisabled()).toBe(true);
				expect(await page.locator("#prompt").inputValue()).toBe("Review inventory.csv");
				expect(await page.locator("#prompt").getAttribute("aria-label")).toBe("Message Inventory team");
				expect(await page.locator("#status").innerText()).toBe("");
				expect(await page.locator("#session-stats .session-stat-input").count()).toBe(1);
				expect(await page.locator("#session-stats .session-stat-output").count()).toBe(1);
				expect(
					await page
						.locator("#session-stats .session-stat-input .session-stat-symbol")
						.evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).color),
				).toBe("rgb(239, 107, 107)");
				expect(
					await page
						.locator("#session-stats .session-stat-output .session-stat-symbol")
						.evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).color),
				).toBe("rgb(67, 197, 138)");
				await page.locator("#prompt").focus();
			}
			await page.keyboard.press("Enter");
			if (view === "builder") {
				await expect.poll(() => names.length).toBe(1);
				await page.waitForResponse((response) => response.url().includes("agent-tasks.json?view=activity"));
				const heading = await page.locator("#transcript header").elementHandle();
				await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).fill("Unsent follow-up");
				const refresh = await page.waitForResponse((response) =>
					response.url().includes("agent-tasks.json?view=activity"),
				);
				const activity = await refresh.json();
				expect(activity.tasks[0]).toMatchObject({ summary: true });
				expect(activity.tasks[0]).not.toHaveProperty("contract");
				expect(await heading?.evaluate((node) => node.isConnected)).toBe(true);
				expect(await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).inputValue()).toBe(
					"Unsent follow-up",
				);
				const detailUrl = new URL(`/agent-tasks/${activity.tasks[0].id}`, started.url);
				detailUrl.search = new URL(started.url).search;
				const detail = await (await page.request.get(detailUrl.toString())).json();
				expect(detail).toHaveProperty("contract");
				expect(detail.summary).toBeUndefined();
				releaseFirst();
			}
			await expect
				.poll(() => page.locator("article").filter({ hasText: "Verified team report" }).isVisible(), {
					timeout: 20_000,
				})
				.toBe(true);
			expect(names).toEqual(["Coordinator", "Reader", "Checker", "Coordinator"]);
			expect(await teams.getByRole("button", { name: "Open Inventory team", exact: true }).innerText()).toContain(
				"completed",
			);
			expect(prompts[2]).toContain("Checked inventory: 26 USD");
			expect(prompts[3]).toContain("Checked inventory: 26 USD");
			expect(await page.locator("details.team-communication").count()).toBe(3);
			expect(await page.locator("details.team-communication[open]").count()).toBe(0);
			await page.locator("details.team-communication summary").first().click();
			expect(await page.locator("details.team-communication[open]").count()).toBe(1);
			for (const prompt of ["Hello", "What tools do you have?", "What was the total you just checked?"]) {
				const before = names.length;
				await page.getByRole("textbox", { name: "Message Inventory team", exact: true }).fill(prompt);
				await page.getByRole("button", { name: "Send to team", exact: true }).click();
				await expect.poll(() => names.length).toBe(before + 1);
				await expect.poll(() => page.locator("#phase").innerText(), { timeout: 20_000 }).toBe("Completed");
				expect(names.at(-1)).toBe("Coordinator");
			}
			expect(prompts.at(-1)).toContain("Earlier answer: Verified team report: 26 USD");
			expect(prompts.at(-1)).toContain('"tools":["read"]');
			failChecker = true;
			await page
				.getByRole("textbox", { name: "Message Inventory team", exact: true })
				.fill("Review another inventory");
			await page.keyboard.press("Enter");
			await expect
				.poll(() => page.locator("#transcript").innerText(), { timeout: 20_000 })
				.toContain("One or more room members failed");
			expect(await page.locator("#transcript").innerText()).toContain("Checker unavailable for this test");
			expect(prompts).toHaveLength(10);
			expect(prompts[7]).toContain(
				"Current user goal for this run (the only completion target):\nReview another inventory",
			);
		} finally {
			releaseFirst();
			await browser.close();
			await host.close();
			executor.mockRestore();
			harness.cleanup();
		}
	},
	90_000,
);
