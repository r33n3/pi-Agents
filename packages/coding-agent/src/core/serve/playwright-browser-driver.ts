import { existsSync } from "node:fs";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { chromium } from "playwright";
import type {
	BrowserDiagnostics,
	BrowserDriver,
	BrowserDriverContext,
	BrowserFrame,
	BrowserPageElement,
	BrowserViewport,
} from "./browser-session-manager.ts";

export interface BrowserInstallationStatus {
	installed: boolean;
	executablePath: string;
}

/** Playwright-backed Chromium driver. It launches lazily so `pi --serve` never requires a browser binary. */
export class PlaywrightBrowserDriver implements BrowserDriver {
	#browser: Browser | undefined;
	#disposed = false;

	installationStatus(): BrowserInstallationStatus {
		const executablePath = chromium.executablePath();
		return { executablePath, installed: existsSync(executablePath) };
	}

	async createContext(input: { profilePath?: string; viewport: BrowserViewport }): Promise<BrowserDriverContext> {
		if (this.#disposed) throw new Error("Playwright browser driver is disposed");
		const status = this.installationStatus();
		if (!status.installed) {
			throw new Error("Managed Chromium is not installed. Run: pi browser install chromium");
		}
		const viewport = {
			width: input.viewport.width,
			height: input.viewport.height,
		};
		if (input.profilePath) {
			const context = await chromium.launchPersistentContext(input.profilePath, {
				headless: true,
				viewport,
				deviceScaleFactor: input.viewport.deviceScaleFactor,
				acceptDownloads: true,
				env: browserEnvironment(),
			});
			const page = context.pages()[0] ?? (await context.newPage());
			return new PlaywrightBrowserContext(context, page);
		}
		const browser = await this.#sharedBrowser();
		const context = await browser.newContext({
			viewport,
			deviceScaleFactor: input.viewport.deviceScaleFactor,
			acceptDownloads: true,
		});
		return new PlaywrightBrowserContext(context, await context.newPage());
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#browser?.close();
		this.#browser = undefined;
	}

	async #sharedBrowser(): Promise<Browser> {
		if (this.#browser) return this.#browser;
		this.#browser = await chromium.launch({
			headless: true,
			env: browserEnvironment(),
		});
		return this.#browser;
	}
}

class PlaywrightBrowserContext implements BrowserDriverContext {
	readonly #context: BrowserContext;
	readonly #page: Page;
	#history: string[] = [];
	#historyIndex = -1;
	readonly #diagnostics: BrowserDiagnostics = { console: [], networkFailures: [] };
	readonly #blockedRequestReasons = new Map<string, string>();
	#assertNavigationAllowed: ((url: string) => Promise<void>) | undefined;

	constructor(context: BrowserContext, page: Page) {
		this.#context = context;
		this.#page = page;
		page.on("console", (message) => {
			appendBounded(this.#diagnostics.console, {
				type: message.type(),
				text: message.text().slice(0, 4_000),
				timestamp: Date.now(),
			});
		});
		page.on("requestfailed", (request) => {
			const url = request.url();
			const policyReason = this.#blockedRequestReasons.get(url);
			this.#blockedRequestReasons.delete(url);
			appendBounded(this.#diagnostics.networkFailures, {
				url: url.slice(0, 4_000),
				method: request.method(),
				reason: policyReason ?? request.failure()?.errorText ?? "Request failed",
				timestamp: Date.now(),
			});
		});
	}

	async setNavigationPolicy(assertAllowed: (url: string) => Promise<void>): Promise<void> {
		this.#assertNavigationAllowed = assertAllowed;
		await this.#context.route("**/*", async (route) => {
			try {
				await this.#assertNavigationAllowed?.(route.request().url());
				await route.continue();
			} catch (error) {
				this.#blockedRequestReasons.set(
					route.request().url(),
					`Blocked by browser access policy: ${error instanceof Error ? error.message : String(error)}`,
				);
				await route.abort("blockedbyclient");
			}
		});
	}

	async navigate(url: string): Promise<{ url: string; title: string }> {
		await this.#page.goto(url, { waitUntil: "domcontentloaded" });
		const page = await this.#pageDetails();
		this.#history = [...this.#history.slice(0, this.#historyIndex + 1), page.url];
		this.#historyIndex = this.#history.length - 1;
		return page;
	}

	async goBack(): Promise<{ url: string; title: string }> {
		if (this.#historyIndex < 1) throw new Error("Browser cannot go back");
		await this.#page.goBack({ waitUntil: "domcontentloaded" });
		this.#historyIndex--;
		return await this.#pageDetails();
	}

	async goForward(): Promise<{ url: string; title: string }> {
		if (this.#historyIndex >= this.#history.length - 1) throw new Error("Browser cannot go forward");
		await this.#page.goForward({ waitUntil: "domcontentloaded" });
		this.#historyIndex++;
		return await this.#pageDetails();
	}

	async reload(): Promise<{ url: string; title: string }> {
		await this.#page.reload({ waitUntil: "domcontentloaded" });
		return await this.#pageDetails();
	}

	pointerClick(x: number, y: number): Promise<void> {
		return this.#page.mouse.click(x, y);
	}

	typeText(text: string): Promise<void> {
		return this.#page.keyboard.insertText(text);
	}

	scroll(deltaX: number, deltaY: number): Promise<void> {
		return this.#page.mouse.wheel(deltaX, deltaY);
	}

	async snapshot(): Promise<{ url: string; title: string; elements: BrowserPageElement[] }> {
		const selector = "a, button, input, textarea, select, [role=button], [role=link]";
		const elements = await this.#page.locator(selector).evaluateAll((nodes) =>
			nodes.map((node) => {
				const element = node as unknown as {
					getAttribute(name: string): string | null;
					name?: string;
					tagName: string;
					textContent: string | null;
					value?: string;
				};
				const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
				const value = element.value?.trim();
				const name =
					element.getAttribute("aria-label") ||
					value ||
					element.textContent ||
					element.getAttribute("placeholder") ||
					"";
				return { role, name: name.replace(/\s+/g, " ").trim().slice(0, 240) };
			}),
		);
		return { url: this.#page.url(), title: await this.#page.title(), elements };
	}

	click(elementIndex: number): Promise<void> {
		return this.#interactiveElements().nth(elementIndex).click();
	}

	fill(elementIndex: number, text: string): Promise<void> {
		return this.#interactiveElements().nth(elementIndex).fill(text);
	}

	press(key: string): Promise<void> {
		return this.#page.keyboard.press(key);
	}

	async screenshot(): Promise<Uint8Array> {
		return new Uint8Array(await this.#page.screenshot({ type: "png" }));
	}

	async subscribeFrames(listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
		const session = await this.#context.newCDPSession(this.#page);
		let stopped = false;
		const onFrame = (payload: {
			data: string;
			metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
			sessionId: number;
		}) => {
			void session.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => {});
			if (stopped) return;
			const jpeg = Buffer.from(payload.data, "base64");
			listener({
				jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
				width: payload.metadata.deviceWidth,
				height: payload.metadata.deviceHeight,
				timestamp: payload.metadata.timestamp ? payload.metadata.timestamp * 1_000 : Date.now(),
			});
		};
		session.on("Page.screencastFrame", onFrame);
		await session.send("Page.startScreencast", {
			format: "jpeg",
			quality: 72,
			maxWidth: 1440,
			maxHeight: 960,
			everyNthFrame: 1,
		});
		return async () => {
			if (stopped) return;
			stopped = true;
			session.off("Page.screencastFrame", onFrame);
			await stopScreencast(session);
		};
	}

	diagnostics(): BrowserDiagnostics {
		return {
			console: this.#diagnostics.console.map((entry) => ({ ...entry })),
			networkFailures: this.#diagnostics.networkFailures.map((entry) => ({ ...entry })),
		};
	}

	close(): Promise<void> {
		return this.#context.close();
	}

	#interactiveElements() {
		return this.#page.locator("a, button, input, textarea, select, [role=button], [role=link]");
	}

	async #pageDetails(): Promise<{ url: string; title: string }> {
		return { url: this.#page.url(), title: await this.#page.title() };
	}
}

async function stopScreencast(session: CDPSession): Promise<void> {
	await session.send("Page.stopScreencast").catch(() => {});
	await session.detach().catch(() => {});
}

function browserEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of [
		"COMSPEC",
		"HOME",
		"LANG",
		"LC_ALL",
		"LOCALAPPDATA",
		"PATH",
		"PROGRAMDATA",
		"PROGRAMFILES",
		"SYSTEMROOT",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"WINDIR",
	]) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

function appendBounded<T>(entries: T[], entry: T): void {
	entries.push(entry);
	if (entries.length > 200) entries.splice(0, entries.length - 200);
}
