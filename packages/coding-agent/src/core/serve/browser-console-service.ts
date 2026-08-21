import type {
	BrowserDiagnostics,
	BrowserFrame,
	BrowserOwner,
	BrowserSessionManager,
	BrowserSessionSnapshot,
} from "./browser-session-manager.ts";
import type { BrowserInstallationStatus } from "./playwright-browser-driver.ts";

export interface BrowserConsoleStatus extends BrowserInstallationStatus {
	browser: "chromium";
	sessionCount: number;
}

/** Exposes the safe, token-gated browser console view without leaking driver objects. */
export class BrowserConsoleService {
	readonly #manager: BrowserSessionManager;
	readonly #installationStatus: () => BrowserInstallationStatus;

	constructor(manager: BrowserSessionManager, installationStatus: () => BrowserInstallationStatus) {
		this.#manager = manager;
		this.#installationStatus = installationStatus;
	}

	status(): BrowserConsoleStatus {
		return { browser: "chromium", ...this.#installationStatus(), sessionCount: this.#manager.list().length };
	}

	list(owner?: BrowserOwner): BrowserSessionSnapshot[] {
		return this.#manager.list(owner);
	}

	get(id: string): BrowserSessionSnapshot | undefined {
		return this.#manager.get(id);
	}

	screenshot(id: string): Promise<Uint8Array> {
		return this.#manager.screenshot(id);
	}

	subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
		return this.#manager.subscribeFrames(id, listener);
	}

	diagnostics(id: string): BrowserDiagnostics {
		return this.#manager.diagnostics(id);
	}

	navigate(id: string, url: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.navigate(id, url, "user");
	}

	goBack(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.goBack(id, "user");
	}

	goForward(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.goForward(id, "user");
	}

	reload(id: string): Promise<BrowserSessionSnapshot> {
		return this.#manager.reload(id, "user");
	}

	setControl(id: string, controlOwner: "agent" | "user"): BrowserSessionSnapshot {
		return this.#manager.setControl(id, controlOwner);
	}

	pointerClick(id: string, x: number, y: number): Promise<void> {
		return this.#manager.pointerClick(id, x, y);
	}

	typeText(id: string, text: string): Promise<void> {
		return this.#manager.typeText(id, text);
	}

	scroll(id: string, deltaX: number, deltaY: number): Promise<void> {
		return this.#manager.scroll(id, deltaX, deltaY);
	}
}
