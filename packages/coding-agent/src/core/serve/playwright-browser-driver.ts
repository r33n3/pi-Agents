import { existsSync } from "node:fs";
import type { Browser, BrowserContext, CDPSession, Frame, Locator, Page } from "playwright";
import { chromium } from "playwright";
import type {
	BrowserDiagnostics,
	BrowserDriver,
	BrowserDriverContext,
	BrowserFrame,
	BrowserPageElement,
	BrowserPageFrame,
	BrowserRuntimeKind,
	BrowserViewport,
} from "./browser-session-manager.ts";

export interface BrowserInstallationStatus {
	installed: boolean;
	executablePath: string;
	installedChrome?: boolean;
}

/** Playwright-backed Chromium driver. It launches lazily so `pi --serve` never requires a browser binary. */
export class PlaywrightBrowserDriver implements BrowserDriver {
	#managedBrowser: Browser | undefined;
	#installedChromeBrowser: Browser | undefined;
	#disposed = false;

	installationStatus(): BrowserInstallationStatus {
		const executablePath = chromium.executablePath();
		return { executablePath, installed: existsSync(executablePath), installedChrome: chromeIsInstalled() };
	}

	async createContext(input: {
		profilePath?: string;
		viewport: BrowserViewport;
		runtime: BrowserRuntimeKind;
	}): Promise<BrowserDriverContext> {
		if (this.#disposed) throw new Error("Playwright browser driver is disposed");
		const status = this.installationStatus();
		if (input.runtime === "managed-chromium" && !status.installed) {
			throw new Error("Managed Chromium is not installed. Run: pi browser install chromium");
		}
		if (input.runtime === "installed-chrome" && !status.installedChrome) {
			throw new Error("Installed Chrome compatibility mode was selected, but stable Chrome was not found");
		}
		const viewport = {
			width: input.viewport.width,
			height: input.viewport.height,
		};
		if (input.profilePath) {
			const context = await chromium.launchPersistentContext(input.profilePath, {
				channel: input.runtime === "installed-chrome" ? "chrome" : undefined,
				headless: true,
				viewport,
				deviceScaleFactor: input.viewport.deviceScaleFactor,
				acceptDownloads: true,
				env: browserEnvironment(),
			});
			const page = context.pages()[0] ?? (await context.newPage());
			return new PlaywrightBrowserContext(context, page);
		}
		const browser = await this.#sharedBrowser(input.runtime);
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
		await Promise.all([this.#managedBrowser?.close(), this.#installedChromeBrowser?.close()]);
		this.#managedBrowser = undefined;
		this.#installedChromeBrowser = undefined;
	}

	async #sharedBrowser(runtime: BrowserRuntimeKind): Promise<Browser> {
		const existing = runtime === "installed-chrome" ? this.#installedChromeBrowser : this.#managedBrowser;
		if (existing) return existing;
		const browser = await chromium.launch({
			channel: runtime === "installed-chrome" ? "chrome" : undefined,
			headless: true,
			env: browserEnvironment(),
		});
		if (runtime === "installed-chrome") this.#installedChromeBrowser = browser;
		else this.#managedBrowser = browser;
		return browser;
	}
}

class PlaywrightBrowserContext implements BrowserDriverContext {
	readonly #context: BrowserContext;
	#page: Page;
	#elementLocators: Locator[] = [];
	readonly #attachedPages = new WeakSet<Page>();
	readonly #downloads: Array<{ name: string; timestamp: number }> = [];
	#history: string[] = [];
	#historyIndex = -1;
	readonly #diagnostics: BrowserDiagnostics = { console: [], networkFailures: [] };
	readonly #blockedRequestReasons = new Map<string, string>();
	#assertNavigationAllowed: ((url: string) => Promise<void>) | undefined;

	constructor(context: BrowserContext, page: Page) {
		this.#context = context;
		this.#page = page;
		this.#attachPage(page);
		context.on("page", (opened) => {
			this.#page = opened;
			this.#attachPage(opened);
		});
	}

	#attachPage(page: Page): void {
		if (this.#attachedPages.has(page)) return;
		this.#attachedPages.add(page);
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
		page.on("download", (download) => {
			appendBounded(this.#downloads, { name: download.suggestedFilename().slice(0, 1_000), timestamp: Date.now() });
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
		this.#elementLocators = [];
		const elements: BrowserPageElement[] = [];
		for (const frame of this.#page.frames()) {
			const locators = await this.#interactiveElements(frame).all();
			for (const locator of locators) {
				if (elements.length >= 300) break;
				const element = await locator.evaluate(serializeBrowserElement);
				const framePath = browserFramePath(frame);
				if (framePath.length > 0) element.frame = framePath;
				this.#elementLocators.push(locator);
				elements.push(element);
			}
			if (elements.length >= 300) break;
		}
		return { url: this.#page.url(), title: await this.#page.title(), elements };
	}

	async elementAt(x: number, y: number): Promise<BrowserPageElement | undefined> {
		for (const frame of [...this.#page.frames()].reverse()) {
			let localX = x;
			let localY = y;
			if (frame !== this.#page.mainFrame()) {
				const box = await frame
					.frameElement()
					.then((element) => element.boundingBox())
					.catch(() => null);
				if (!box || x < box.x || y < box.y || x > box.x + box.width || y > box.y + box.height) continue;
				localX -= box.x;
				localY -= box.y;
			}
			const element = await frame.evaluate<BrowserPageElement | undefined, BrowserElementInspection>(
				inspectBrowserElement,
				{ kind: "point", x: localX, y: localY },
			);
			if (!element) continue;
			const framePath = browserFramePath(frame);
			if (framePath.length > 0) element.frame = framePath;
			return element;
		}
		return undefined;
	}

	async focusedElement(): Promise<BrowserPageElement | undefined> {
		for (const frame of [...this.#page.frames()].reverse()) {
			const element = await frame.evaluate<BrowserPageElement | undefined, BrowserElementInspection>(
				inspectBrowserElement,
				{ kind: "focused" },
			);
			if (!element || !["a", "button", "input", "textarea", "select"].includes(element.tag ?? "")) continue;
			const framePath = browserFramePath(frame);
			if (framePath.length > 0) element.frame = framePath;
			return element;
		}
		return undefined;
	}

	click(elementIndex: number): Promise<void> {
		return this.#requiredElement(elementIndex).click();
	}

	fill(elementIndex: number, text: string): Promise<void> {
		return this.#requiredElement(elementIndex).fill(text);
	}

	async select(elementIndex: number, value: string): Promise<void> {
		await this.#requiredElement(elementIndex).selectOption(value);
	}

	async scrollIntoView(elementIndex: number): Promise<void> {
		await this.#requiredElement(elementIndex).scrollIntoViewIfNeeded();
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
		let pending:
			| {
					data: string;
					metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
					sessionId: number;
			  }
			| undefined;
		let timer: NodeJS.Timeout | undefined;
		let lastFrameAt = 0;
		const flush = () => {
			timer = undefined;
			const payload = pending;
			pending = undefined;
			if (stopped || !payload) return;
			lastFrameAt = Date.now();
			const jpeg = Buffer.from(payload.data, "base64");
			listener({
				jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength),
				width: payload.metadata.deviceWidth,
				height: payload.metadata.deviceHeight,
				timestamp: payload.metadata.timestamp ? payload.metadata.timestamp * 1_000 : lastFrameAt,
			});
			void session.send("Page.screencastFrameAck", { sessionId: payload.sessionId }).catch(() => {});
		};
		const onFrame = (payload: {
			data: string;
			metadata: { deviceWidth: number; deviceHeight: number; timestamp?: number };
			sessionId: number;
		}) => {
			if (stopped) return;
			pending = payload;
			if (!timer) timer = setTimeout(flush, Math.max(0, 100 - (Date.now() - lastFrameAt)));
		};
		session.on("Page.screencastFrame", onFrame);
		await session.send("Page.startScreencast", {
			format: "jpeg",
			quality: 72,
			maxWidth: 1440,
			maxHeight: 960,
			everyNthFrame: 2,
		});
		return async () => {
			if (stopped) return;
			stopped = true;
			pending = undefined;
			if (timer) clearTimeout(timer);
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

	downloads(): Array<{ name: string; timestamp: number }> {
		return this.#downloads.map((entry) => ({ ...entry }));
	}

	close(): Promise<void> {
		return this.#context.close();
	}

	#interactiveElements(frame: Frame = this.#page.mainFrame()): Locator {
		return frame.locator("a, button, input, textarea, select, [role=button], [role=link]");
	}

	#requiredElement(index: number): Locator {
		const locator = this.#elementLocators[index];
		if (!locator) throw new Error("Browser element snapshot is stale; request a fresh snapshot");
		return locator;
	}

	async #pageDetails(): Promise<{ url: string; title: string }> {
		return { url: this.#page.url(), title: await this.#page.title() };
	}
}

interface BrowserElementInspection {
	kind: "point" | "focused";
	x?: number;
	y?: number;
}

function browserFramePath(frame: Frame): BrowserPageFrame[] {
	const path: BrowserPageFrame[] = [];
	let current: Frame | null = frame;
	while (current?.parentFrame()) {
		path.unshift({ name: current.name().slice(0, 240), url: current.url().slice(0, 4_000) });
		current = current.parentFrame();
	}
	return path;
}

function inspectBrowserElement(input: BrowserElementInspection): BrowserPageElement | undefined {
	const browserDocument = (globalThis as unknown as { document: BrowserDocument }).document;
	const node =
		input.kind === "focused"
			? browserDocument.activeElement
			: browserDocument
					.elementFromPoint(input.x ?? 0, input.y ?? 0)
					?.closest("a, button, input, textarea, select, [role]");
	if (!node) return undefined;
	const tag = node.tagName.toLowerCase();
	const label = node.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim();
	const name =
		node.getAttribute("aria-label") ||
		label ||
		node.placeholder ||
		node.textContent ||
		node.getAttribute("name") ||
		"";
	return {
		role: node.getAttribute("role") ?? tag,
		name: name.replace(/\s+/g, " ").trim().slice(0, 240),
		tag,
		label: label?.slice(0, 240),
		testId: node.getAttribute("data-testid")?.slice(0, 240),
		id: node.id?.slice(0, 240) || undefined,
		inputType: node.type?.slice(0, 80),
		visible: node.getClientRects().length > 0,
		enabled: !node.disabled,
	};
}

function serializeBrowserElement(node: unknown): BrowserPageElement {
	const element = node as BrowserDomElement;
	const tag = element.tagName.toLowerCase();
	const label = element.labels?.[0]?.textContent?.replace(/\s+/g, " ").trim();
	const name =
		element.getAttribute("aria-label") ||
		label ||
		element.placeholder ||
		element.textContent ||
		element.getAttribute("name") ||
		"";
	return {
		role: element.getAttribute("role") ?? tag,
		name: name.replace(/\s+/g, " ").trim().slice(0, 240),
		tag,
		label: label?.slice(0, 240),
		testId: element.getAttribute("data-testid")?.slice(0, 240),
		id: element.id?.slice(0, 240) || undefined,
		inputType: element.type?.slice(0, 80),
		visible: element.getClientRects().length > 0,
		enabled: !element.disabled,
	};
}

interface BrowserDomElement {
	tagName: string;
	textContent: string | null;
	id: string;
	labels?: ArrayLike<{ textContent: string | null }>;
	placeholder?: string;
	type?: string;
	disabled?: boolean;
	getAttribute(name: string): string | null;
	closest(selector: string): BrowserDomElement | null;
	getClientRects(): ArrayLike<unknown>;
}

interface BrowserDocument {
	activeElement: BrowserDomElement | null;
	elementFromPoint(x: number, y: number): BrowserDomElement | null;
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

function chromeIsInstalled(): boolean {
	const candidates =
		process.platform === "win32"
			? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
					.filter((root): root is string => root !== undefined)
					.map((root) => `${root}\\Google\\Chrome\\Application\\chrome.exe`)
			: process.platform === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
				: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
	return candidates.some((candidate) => existsSync(candidate));
}

function appendBounded<T>(entries: T[], entry: T): void {
	entries.push(entry);
	if (entries.length > 200) entries.splice(0, entries.length - 200);
}
