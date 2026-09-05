import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Browser, chromium, type Page } from "playwright";
import { afterEach, expect, test, vi } from "vitest";
import type { AgentBuildRecord } from "../src/core/serve/agent-build-lifecycle-service.ts";
import { ChildProcessAgentExecutor } from "../src/core/serve/child-process-agent-executor.ts";
import type { ConversationBuildView } from "../src/core/serve/conversation-build-coordinator.ts";
import { ServeHost } from "../src/core/serve/serve-host.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
let restoredHarness: Harness | undefined;
let host: ServeHost | undefined;
let browser: Browser | undefined;

afterEach(async () => {
	await browser?.close();
	await host?.close();
	vi.restoreAllMocks();
	restoredHarness?.cleanup();
	harness?.cleanup();
});

test("builds, tests, accepts, activates and schedules through the browser with host-observed approval", async () => {
	// This scenario tests lifecycle transitions; emit each short fixture response in one chunk.
	harness = await createHarness({ tokenSize: { min: 4096, max: 4096 } });
	const fixture = harness;
	vi.spyOn(ChildProcessAgentExecutor.prototype, "start").mockImplementation(async () => ({
		result: Promise.resolve({ output: "A concise, verified review.", transcript: [] }),
		subscribe: () => () => {},
		abort: async () => {},
		dispose: async () => {},
		[Symbol.asyncDispose]: async () => {},
	}));
	host = new ServeHost({ agentDir: fixture.tempDir, session: fixture.session, host: "127.0.0.1", port: 0 });
	const started = await host.start();
	const url = new URL(started.url);
	const token = url.searchParams.get("token")!;
	// Only this fixture's faux provider is configured. No external model requests.
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.setDefaultTimeout(30_000);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto(started.url);
	await page.getByRole("button", { name: "Build a new agent", exact: true }).click();
	const readBuilds = async (): Promise<ConversationBuildView[]> => {
		const response = await fetch(`${url.origin}/agent-build-conversations.json?token=${token}`, {
			signal: AbortSignal.timeout(5_000),
		});
		expect(response.ok).toBe(true);
		return ((await response.json()) as { builds: ConversationBuildView[] }).builds;
	};
	const current = async (): Promise<AgentBuildRecord> => (await readBuilds())[0]!.build;
	const send = async (text: string, tool: string, args: Record<string, unknown>): Promise<void> => {
		fixture.setResponses([
			fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }),
			fauxAssistantMessage("Review the retained package and evidence."),
		]);
		await sendChat(page, text);
		try {
			await expect.poll(() => fixture.getPendingResponseCount(), { timeout: 8_000 }).toBe(0);
		} catch (error) {
			throw new Error(`${text}: ${await page.locator("body").innerText()}`, { cause: error });
		}
		await expect.poll(() => fixture.session.isStreaming).toBe(false);
	};
	await send("Create an agent that returns a concise review.", "configure_agent", {
		name: "conversation-reviewer",
		description: "Return a concise review",
		projectRoot: fixture.tempDir,
		executor: "session",
		tools: [],
		model: `${fixture.getModel().provider}/${fixture.getModel().id}`,
		scheduleTask: "Return the daily review",
		scheduleCadence: "daily 09:00",
		scheduleTimezone: "America/Chicago",
		scheduleConfirmed: true,
	});
	await expect.poll(async () => (await current()).stage).toBe("draft");
	await expect.poll(() => page.locator("#agent-name").inputValue()).toBe("conversation-reviewer");
	const buildId = (await current()).id;
	await page.getByRole("button", { name: "Try candidate", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Run proof", exact: true }).click();
	await expect.poll(async () => (await current()).stage, { timeout: 15_000 }).toBe("proof-ready");
	await page.getByRole("button", { name: "Review proof", exact: true }).click();
	await page.getByRole("button", { name: "Accept proof", exact: true }).click();
	await expect.poll(async () => (await current()).stage).toBe("proven");
	expect((await current()).proof?.review?.accepted).toBe(true);

	const activate = { buildId, action: "activate", confirmed: false };
	await send("Activate the accepted revision", "manage_agent_build", activate);
	const proposal = (await readBuilds())[0]!.proposals.find((entry) => entry.state === "pending")!;
	expect(proposal.action).toBe("activate");
	// A model claiming that the user said yes cannot authorize this operation.
	await send("Explain the activation", "manage_agent_build", {
		...activate,
		confirmed: true,
		proposalId: proposal.id,
		confirmationText: "yes",
	});
	expect((await current()).agentId).toBeUndefined();
	await send("yes", "manage_agent_build", { ...activate, confirmed: true, proposalId: proposal.id });
	await expect.poll(async () => (await current()).activeProof?.agentRevision).toBe(1);
	expect((await current()).skill).toBeUndefined();
	await expect.poll(() => page.getByRole("button", { name: "Add routine", exact: true }).count()).toBe(1);
	const schedule = { buildId, action: "schedule", confirmed: false };
	await send("Enable the daily review", "manage_agent_build", schedule);
	const scheduleProposal = (await readBuilds())[0]!.proposals.find((entry) => entry.state === "pending")!;
	await send("yes", "manage_agent_build", { ...schedule, confirmed: true, proposalId: scheduleProposal.id });
	await expect.poll(async () => (await current()).stage).toBe("automated");
	expect((await current()).routineIds).toHaveLength(1);
	await send("yes", "manage_agent_build", { ...schedule, confirmed: true, proposalId: scheduleProposal.id });
	expect((await current()).routineIds).toHaveLength(1);
	await send("Refine the review to mention limitations", "configure_agent", {
		buildId,
		expectedBuildRevision: (await current()).revision,
		id: "conversation-reviewer",
		name: "conversation-reviewer",
		description: "Return a concise review with limitations",
	});
	expect(await current()).toMatchObject({ stage: "draft", candidateRevision: 2, activeProof: { agentRevision: 1 } });
	const routinesResponse = await fetch(`${url.origin}/routines.json?token=${token}`);
	expect(await routinesResponse.json()).toMatchObject({ routines: [expect.objectContaining({ enabled: true })] });
	expect(pageErrors).toEqual([]);
	await host.close();
	restoredHarness = await createHarness();
	host = new ServeHost({ agentDir: fixture.tempDir, session: restoredHarness.session, host: "127.0.0.1", port: 0 });
	const restarted = new URL((await host.start()).url);
	const restoredBuilds = await fetch(`${restarted.origin}/agent-builds.json${restarted.search}`);
	expect(await restoredBuilds.json()).toMatchObject({
		builds: [
			expect.objectContaining({
				id: buildId,
				stage: "draft",
				candidateRevision: 2,
				activeProof: { agentRevision: 1, runId: expect.any(String) },
			}),
		],
	});
	const restoredRoutines = await fetch(`${restarted.origin}/routines.json${restarted.search}`);
	expect(await restoredRoutines.json()).toMatchObject({ routines: [expect.objectContaining({ enabled: true })] });
	await page.goto(restarted.href);
	await expect.poll(() => page.getByRole("button", { name: /conversation-reviewer/ }).count()).toBeGreaterThan(0);
	await page.getByRole("button", { name: "Build a new agent", exact: true }).click();
	const staleExit = await page.getByRole("button", { name: "Exit editing", exact: true }).elementHandle();
	await page.locator("button.session-select").filter({ hasText: "conversation-reviewer" }).click();
	await expect
		.poll(() => page.getByRole("textbox", { name: "Message conversation-reviewer", exact: true }).isVisible(), {
			timeout: 15_000,
		})
		.toBe(true);
	// A delayed builder click must not clear the newly selected agent's refresh target.
	await staleExit!.evaluate((button) => button.click());
	await sendChat(page, "Return a review through the normal agent inbox.");
	try {
		await expect
			.poll(() => page.locator("article").filter({ hasText: "A concise, verified review." }).isVisible(), {
				timeout: 15_000,
			})
			.toBe(true);
	} catch (error) {
		throw new Error(`Agent inbox after stale builder exit: ${await page.locator("body").innerText()}`, {
			cause: error,
		});
	}
	expect(pageErrors).toEqual([]);
}, 300_000);

async function sendChat(page: Page, text: string): Promise<void> {
	await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
	const composer = page.locator("#prompt");
	await composer.fill(text);
	await page.keyboard.press("Enter");
}
