import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserProfileStore } from "../src/core/serve/browser-profile-store.ts";
import {
	type BrowserDriver,
	type BrowserDriverContext,
	BrowserSessionManager,
} from "../src/core/serve/browser-session-manager.ts";
import type { BrowserWorkflowCapture } from "../src/core/serve/browser-workflow-capture.ts";
import { BrowserWorkflowCompiler } from "../src/core/serve/browser-workflow-compiler.ts";
import { BrowserWorkflowRegistry } from "../src/core/serve/browser-workflow-registry.ts";
import { BrowserWorkflowRunner } from "../src/core/serve/browser-workflow-runner.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class WorkflowBrowserContext implements BrowserDriverContext {
	url = "about:blank";
	title = "";
	readonly #stall: boolean;

	constructor(stall = false) {
		this.#stall = stall;
	}

	async setNavigationPolicy(): Promise<void> {}
	async navigate(url: string) {
		this.url = url;
		this.title = "Sign in";
		return { url, title: this.title };
	}
	async goBack() {
		return { url: this.url, title: this.title };
	}
	async goForward() {
		return { url: this.url, title: this.title };
	}
	async reload() {
		return { url: this.url, title: this.title };
	}
	async pointerClick(): Promise<void> {}
	async typeText(): Promise<void> {}
	async scroll(): Promise<void> {}
	async snapshot() {
		return {
			url: this.url,
			title: this.title,
			elements:
				this.title === "Sign in"
					? [{ role: "button", name: "Sign in", tag: "button", testId: "sign-in", visible: true, enabled: true }]
					: [],
		};
	}
	async elementAt() {
		return { role: "button", name: "Sign in", tag: "button", testId: "sign-in" };
	}
	async focusedElement(): Promise<undefined> {
		return undefined;
	}
	async click(): Promise<void> {
		if (this.#stall) return;
		this.url = "http://127.0.0.1:4173/account";
		this.title = "Account";
	}
	async fill(): Promise<void> {}
	async select(): Promise<void> {}
	async scrollIntoView(): Promise<void> {}
	async press(): Promise<void> {}
	async screenshot(): Promise<Uint8Array> {
		return new Uint8Array([137, 80, 78, 71]);
	}
	async subscribeFrames(): Promise<() => Promise<void>> {
		return async () => {};
	}
	diagnostics() {
		return { console: [], networkFailures: [] };
	}
	downloads() {
		return [];
	}
	async close(): Promise<void> {}
}

class WorkflowBrowserDriver implements BrowserDriver {
	stallNext = false;

	async createContext(): Promise<BrowserDriverContext> {
		const context = new WorkflowBrowserContext(this.stallNext);
		this.stallNext = false;
		return context;
	}
	async dispose(): Promise<void> {}
}

function capture(): BrowserWorkflowCapture {
	const target = { role: "button", name: "Sign in", tag: "button", testId: "sign-in" };
	const initial = { url: "http://127.0.0.1:4173/login", title: "Sign in", elements: [target] };
	return {
		schema: "pi.browser-capture.v1",
		id: "capture-validate",
		sessionId: "source-session",
		owner: { kind: "pi-session", id: "pi-source" },
		profile: { kind: "ephemeral" },
		viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
		status: "stopped",
		startedAt: 1,
		updatedAt: 2,
		initial,
		steps: [
			{
				id: "step-1",
				timestamp: 2,
				action: { kind: "click", x: 10, y: 10, target },
				before: initial,
				after: { url: "http://127.0.0.1:4173/account", title: "Account", elements: [] },
			},
		],
	};
}

describe("BrowserWorkflowRunner", () => {
	test("validates the exact digest and executes only after activation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-runner-"));
		roots.push(root);
		const registry = new BrowserWorkflowRegistry(join(root, "workflows"));
		await registry.initialize();
		const compiled = await new BrowserWorkflowCompiler(registry).compile(capture(), { name: "Sign in" });
		const manager = new BrowserSessionManager(new WorkflowBrowserDriver(), new BrowserProfileStore(root));
		const runner = new BrowserWorkflowRunner(registry, manager, join(root, "runs"));
		await runner.initialize();
		const input = {
			owner: { kind: "agent-run" as const, id: "run-owner" },
			workspace: { id: "project", root },
			parameters: {},
		};
		const validation = await runner.validate(compiled.id, compiled.version, input);
		expect(validation.status).toBe("completed");
		expect(registry.get(compiled.id)?.status).toBe("validated");
		await registry.activate(compiled.id, compiled.version);
		const execution = await runner.execute(compiled.id, input);
		expect(execution.status).toBe("completed");
		expect(runner.list(compiled.id)).toHaveLength(2);
		await manager.dispose();
	});

	test("requires an explicit approval signal for approval-gated execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-runner-"));
		roots.push(root);
		const registry = new BrowserWorkflowRegistry(join(root, "workflows"));
		await registry.initialize();
		const initial = await new BrowserWorkflowCompiler(registry).compile(capture(), { name: "Approved sign in" });
		const draft = await registry.saveDraft({
			...initial,
			policy: { ...initial.policy, approval: "always" },
		});
		const compiled = await registry.setStatus(draft.id, draft.version, "compiled");
		const manager = new BrowserSessionManager(new WorkflowBrowserDriver(), new BrowserProfileStore(root));
		const runner = new BrowserWorkflowRunner(registry, manager, join(root, "runs"));
		await runner.initialize();
		const input = {
			owner: { kind: "agent-run" as const, id: "approved-owner" },
			workspace: { id: "project", root },
			parameters: {},
		};
		await runner.validate(compiled.id, compiled.version, input);
		await registry.activate(compiled.id, compiled.version);
		await expect(runner.executeVersion(compiled.id, compiled.version, input)).rejects.toThrow("explicit approval");
		await expect(
			runner.executeVersion(compiled.id, compiled.version, { ...input, approved: true }),
		).resolves.toMatchObject({ status: "completed" });
		await manager.dispose();
	});

	test("cancels an execution while it is waiting for an assertion", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-runner-"));
		roots.push(root);
		const registry = new BrowserWorkflowRegistry(join(root, "workflows"));
		await registry.initialize();
		const compiled = await new BrowserWorkflowCompiler(registry).compile(capture(), { name: "Cancelable sign in" });
		const driver = new WorkflowBrowserDriver();
		const manager = new BrowserSessionManager(driver, new BrowserProfileStore(root));
		const runner = new BrowserWorkflowRunner(registry, manager, join(root, "runs"));
		await runner.initialize();
		const input = {
			owner: { kind: "agent-run" as const, id: "cancel-owner" },
			workspace: { id: "project", root },
			parameters: {},
		};
		await runner.validate(compiled.id, compiled.version, input);
		await registry.activate(compiled.id, compiled.version);
		driver.stallNext = true;
		const execution = await runner.startExecute(compiled.id, input);
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
		await execution.cancel();
		await expect(execution.completion).resolves.toMatchObject({ status: "cancelled" });
		expect(manager.list().filter((session) => session.status !== "closed")).toHaveLength(0);
		await manager.dispose();
	});
});
