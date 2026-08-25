import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { BrowserArtifact, BrowserArtifactStore } from "./browser-artifact-store.ts";
import { type BrowserAccess, BrowserPolicy } from "./browser-policy.ts";
import type { BrowserProfile, BrowserProfileStore } from "./browser-profile-store.ts";
import type {
	BrowserCapturePageState,
	BrowserWorkflowCapture,
	BrowserWorkflowCaptureStore,
} from "./browser-workflow-capture.ts";
import type { GovernedActionService } from "./governed-action-service.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";
import type { ServeAuditIdentities } from "./serve-audit-store.ts";

export type BrowserOwnerKind = "pi-session" | "agent-run" | "external-run";
export type BrowserRuntimeKind = "managed-chromium" | "installed-chrome";

export interface BrowserOwner {
	kind: BrowserOwnerKind;
	id: string;
}

export interface BrowserWorkspace {
	id: string;
	root: string;
}

export interface BrowserViewport {
	width: number;
	height: number;
	deviceScaleFactor: number;
}

export interface BrowserSessionRequest {
	owner: BrowserOwner;
	workspace: BrowserWorkspace;
	access: BrowserAccess;
	runtime?: BrowserRuntimeKind;
	profile?: BrowserProfile;
	viewport?: BrowserViewport;
}

export interface BrowserSessionSnapshot {
	id: string;
	owner: BrowserOwner;
	workspace: BrowserWorkspace;
	access: BrowserAccess;
	runtime: BrowserRuntimeKind;
	profile: BrowserProfile;
	controlOwner: "agent" | "user";
	viewport: BrowserViewport;
	canGoBack: boolean;
	canGoForward: boolean;
	status: "starting" | "ready" | "navigating" | "failed" | "closed";
	url?: string;
	title?: string;
	createdAt: number;
	updatedAt: number;
	lastError?: string;
}

export interface BrowserDriverContext {
	setNavigationPolicy(assertAllowed: (url: string) => Promise<void>): Promise<void>;
	navigate(url: string): Promise<{ url: string; title: string }>;
	goBack(): Promise<{ url: string; title: string }>;
	goForward(): Promise<{ url: string; title: string }>;
	reload(): Promise<{ url: string; title: string }>;
	pointerClick(x: number, y: number): Promise<void>;
	typeText(text: string): Promise<void>;
	scroll(deltaX: number, deltaY: number): Promise<void>;
	snapshot(): Promise<{ url: string; title: string; elements: BrowserPageElement[] }>;
	elementAt(x: number, y: number): Promise<BrowserPageElement | undefined>;
	focusedElement(): Promise<BrowserPageElement | undefined>;
	click(elementIndex: number): Promise<void>;
	fill(elementIndex: number, text: string): Promise<void>;
	select(elementIndex: number, value: string): Promise<void>;
	scrollIntoView(elementIndex: number): Promise<void>;
	press(key: string): Promise<void>;
	screenshot(): Promise<Uint8Array>;
	subscribeFrames(listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>>;
	diagnostics(): BrowserDiagnostics;
	downloads(): BrowserDownload[];
	close(): Promise<void>;
}

export interface BrowserFrame {
	jpeg: Uint8Array;
	width: number;
	height: number;
	timestamp: number;
}

export interface BrowserPageElement {
	role: string;
	name: string;
	tag?: string;
	label?: string;
	testId?: string;
	id?: string;
	inputType?: string;
	visible?: boolean;
	enabled?: boolean;
	frame?: BrowserPageFrame[];
}

export interface BrowserPageFrame {
	name: string;
	url: string;
}

export interface BrowserDownload {
	name: string;
	timestamp: number;
}

export interface BrowserSemanticSnapshot {
	revision: number;
	url: string;
	title: string;
	elements: Array<BrowserPageElement & { ref: string }>;
}

export interface BrowserConsoleEvent {
	type: string;
	text: string;
	timestamp: number;
}

export interface BrowserNetworkFailure {
	url: string;
	method: string;
	reason: string;
	timestamp: number;
}

export interface BrowserDiagnostics {
	console: BrowserConsoleEvent[];
	networkFailures: BrowserNetworkFailure[];
}

export interface BrowserDriver {
	createContext(input: {
		profilePath?: string;
		viewport: BrowserViewport;
		runtime: BrowserRuntimeKind;
	}): Promise<BrowserDriverContext>;
	dispose(): Promise<void>;
}

interface BrowserSessionRecord {
	snapshot: BrowserSessionSnapshot;
	context: BrowserDriverContext;
	policy: BrowserPolicy;
	history: string[];
	historyIndex: number;
	mutations: SerialOperationQueue;
	agentObservationRequired: boolean;
	closePromise?: Promise<void>;
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1440, height: 960, deviceScaleFactor: 1 };

/** Owns browser contexts and binds each one to a stable local workspace identity. */
export class BrowserSessionManager implements AsyncDisposable {
	readonly #driver: BrowserDriver;
	readonly #profileStore: BrowserProfileStore;
	readonly #maxSessions: number;
	readonly #artifactStore: BrowserArtifactStore | undefined;
	readonly #captureStore: BrowserWorkflowCaptureStore | undefined;
	readonly #governedActions: GovernedActionService | undefined;
	readonly #sessions = new Map<string, BrowserSessionRecord>();
	readonly #namedProfileLeases = new Map<string, string>();
	readonly #snapshots = new Map<string, BrowserSemanticSnapshot>();
	readonly #snapshotRevisions = new Map<string, number>();
	readonly #lifecycle = new SerialOperationQueue();
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(
		driver: BrowserDriver,
		profileStore: BrowserProfileStore,
		maxSessions = 4,
		artifactStore?: BrowserArtifactStore,
		captureStore?: BrowserWorkflowCaptureStore,
		governedActions?: GovernedActionService,
	) {
		if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
			throw new Error("Browser maxSessions must be positive");
		this.#driver = driver;
		this.#profileStore = profileStore;
		this.#maxSessions = maxSessions;
		this.#artifactStore = artifactStore;
		this.#captureStore = captureStore;
		this.#governedActions = governedActions;
	}

	list(owner?: BrowserOwner): BrowserSessionSnapshot[] {
		return [...this.#sessions.values()]
			.map((entry) => entry.snapshot)
			.filter((snapshot) => owner === undefined || sameOwner(snapshot.owner, owner))
			.map((snapshot) => ({ ...snapshot, owner: { ...snapshot.owner }, workspace: { ...snapshot.workspace } }));
	}

	get(id: string): BrowserSessionSnapshot | undefined {
		const snapshot = this.#sessions.get(id)?.snapshot;
		return snapshot ? { ...snapshot, owner: { ...snapshot.owner }, workspace: { ...snapshot.workspace } } : undefined;
	}

	async create(request: BrowserSessionRequest): Promise<BrowserSessionSnapshot> {
		this.#assertActive();
		return this.#lifecycle.run(async () => {
			this.#assertActive();
			if (this.#activeSessionCount() >= this.#maxSessions)
				throw new Error(`Browser session limit reached (${this.#maxSessions})`);
			assertOwner(request.owner);
			const workspace = normalizeWorkspace(request.workspace);
			const profile = request.profile ?? { kind: "ephemeral" };
			const runtime = request.runtime ?? "managed-chromium";
			if (profile.kind === "named") {
				const leasedBy = this.#namedProfileLeases.get(profile.id);
				if (leasedBy) throw new Error(`Browser profile ${profile.id} is already in use by session ${leasedBy}`);
			}
			const viewport = request.viewport ?? DEFAULT_VIEWPORT;
			assertViewport(viewport);
			const id = randomUUID();
			const now = Date.now();
			const snapshot: BrowserSessionSnapshot = {
				id,
				owner: { ...request.owner },
				workspace,
				access: request.access,
				runtime,
				profile,
				controlOwner: "agent",
				viewport,
				canGoBack: false,
				canGoForward: false,
				status: "starting",
				createdAt: now,
				updatedAt: now,
			};
			let context: BrowserDriverContext | undefined;
			try {
				if (profile.kind === "named") this.#namedProfileLeases.set(profile.id, id);
				const policy = new BrowserPolicy(request.access);
				context = await this.#driver.createContext({
					profilePath: await this.#profileStore.pathFor(profile),
					viewport,
					runtime,
				});
				this.#assertActive();
				await context.setNavigationPolicy(async (url) => {
					await policy.assertResolvedNavigation(url);
				});
				this.#assertActive();
				snapshot.status = "ready";
				snapshot.updatedAt = Date.now();
				this.#sessions.set(id, {
					snapshot,
					context,
					policy,
					history: [],
					historyIndex: -1,
					mutations: new SerialOperationQueue(),
					agentObservationRequired: false,
				});
				context = undefined;
				return this.get(id)!;
			} catch (error) {
				if (profile.kind === "named") this.#namedProfileLeases.delete(profile.id);
				snapshot.status = "failed";
				snapshot.updatedAt = Date.now();
				snapshot.lastError = message(error);
				if (context) {
					try {
						await context.close();
					} catch (closeError) {
						throw new AggregateError([error, closeError], "Failed to create and clean up browser session");
					}
				}
				throw error;
			}
		});
	}

	async navigate(id: string, url: string, actor: "agent" | "user" = "agent"): Promise<BrowserSessionSnapshot> {
		this.#assertActive();
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			let allowedUrl: URL | undefined;
			return this.#executeGoverned(
				record,
				"browser.navigate",
				this.#actionTarget(record, actor, { operation: "navigate", url: canonicalAuditUrl(url) }),
				async () => {
					this.#assertMutation(record, actor);
					allowedUrl = await record.policy.assertResolvedNavigation(url);
				},
				async () => {
					if (!allowedUrl) throw new Error("Browser navigation was not authorized");
					const before = await this.#capturePageState(id, record);
					this.#invalidateSnapshot(id);
					record.snapshot.status = "navigating";
					record.snapshot.updatedAt = Date.now();
					try {
						const page = await record.context.navigate(allowedUrl.href);
						record.snapshot.status = "ready";
						record.snapshot.url = page.url;
						record.snapshot.title = page.title;
						record.history = [...record.history.slice(0, record.historyIndex + 1), page.url];
						record.historyIndex = record.history.length - 1;
						record.snapshot.canGoBack = record.historyIndex > 0;
						record.snapshot.canGoForward = false;
						record.snapshot.lastError = undefined;
					} catch (error) {
						record.snapshot.status = "failed";
						record.snapshot.lastError = message(error);
						throw error;
					} finally {
						record.snapshot.updatedAt = Date.now();
					}
					if (before) {
						await this.#captureStore?.record(id, {
							action: { kind: "navigate", url: record.snapshot.url ?? allowedUrl.href },
							before,
							after: await this.#pageState(record.context),
						});
					}
					return this.get(id)!;
				},
			);
		});
	}

	async goBack(id: string, actor: "agent" | "user" = "agent"): Promise<BrowserSessionSnapshot> {
		return this.#navigateHistory(id, actor, (context) => context.goBack(), "back");
	}

	async goForward(id: string, actor: "agent" | "user" = "agent"): Promise<BrowserSessionSnapshot> {
		return this.#navigateHistory(id, actor, (context) => context.goForward(), "forward");
	}

	async reload(id: string, actor: "agent" | "user" = "agent"): Promise<BrowserSessionSnapshot> {
		return this.#navigateHistory(id, actor, (context) => context.reload(), "reload");
	}

	async setControl(id: string, controlOwner: "agent" | "user"): Promise<BrowserSessionSnapshot> {
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			return this.#executeGoverned(
				record,
				"browser.set-control",
				this.#actionTarget(record, "user", { operation: "set-control", controlOwner }),
				() => this.#assertOpen(record),
				async () => {
					if (record.snapshot.controlOwner === "user" && controlOwner === "agent") {
						record.agentObservationRequired = true;
						this.#snapshots.delete(id);
					}
					record.snapshot.controlOwner = controlOwner;
					record.snapshot.updatedAt = Date.now();
					return this.get(id)!;
				},
			);
		});
	}

	async pointerClick(id: string, x: number, y: number): Promise<void> {
		const record = this.#requireSession(id);
		await record.mutations.run(async () => {
			await this.#executeGoverned(
				record,
				"browser.input.click",
				this.#actionTarget(record, "user", {
					operation: "pointer-click",
					x: canonicalAuditNumber(x),
					y: canonicalAuditNumber(y),
				}),
				() => {
					this.#assertMutation(record, "user");
					assertCoordinate(x, "x", record.snapshot.viewport.width);
					assertCoordinate(y, "y", record.snapshot.viewport.height);
				},
				async () => {
					const before = await this.#capturePageState(id, record);
					const target = before ? await record.context.elementAt(x, y) : undefined;
					this.#invalidateSnapshot(id);
					await record.context.pointerClick(x, y);
					record.snapshot.updatedAt = Date.now();
					if (before) {
						await this.#captureStore?.record(id, {
							action: { kind: "click", x, y, target },
							before,
							after: await this.#pageState(record.context),
						});
					}
				},
			);
		});
	}

	async typeText(id: string, text: string): Promise<void> {
		const record = this.#requireSession(id);
		await record.mutations.run(async () => {
			await this.#executeGoverned(
				record,
				"browser.input.type",
				this.#actionTarget(record, "user", { operation: "type", textLength: text.length }),
				() => {
					this.#assertMutation(record, "user");
					if (text.length === 0 || text.length > 100_000)
						throw new Error("Browser text must contain 1 to 100000 characters");
				},
				async () => {
					const before = await this.#capturePageState(id, record);
					const target = before ? await record.context.focusedElement() : undefined;
					this.#invalidateSnapshot(id);
					await record.context.typeText(text);
					record.snapshot.updatedAt = Date.now();
					if (before) {
						await this.#captureStore?.record(id, {
							action: {
								kind: "type",
								textLength: text.length,
								target,
								sensitive: target?.inputType === "password",
							},
							before,
							after: await this.#pageState(record.context),
						});
					}
				},
			);
		});
	}

	async scroll(id: string, deltaX: number, deltaY: number): Promise<void> {
		const record = this.#requireSession(id);
		await record.mutations.run(async () => {
			await this.#executeGoverned(
				record,
				"browser.input.scroll",
				this.#actionTarget(record, "user", {
					operation: "scroll",
					deltaX: canonicalAuditNumber(deltaX),
					deltaY: canonicalAuditNumber(deltaY),
				}),
				() => {
					this.#assertMutation(record, "user");
					if (
						!Number.isFinite(deltaX) ||
						!Number.isFinite(deltaY) ||
						Math.abs(deltaX) > 10_000 ||
						Math.abs(deltaY) > 10_000
					) {
						throw new Error("Browser scroll values are out of range");
					}
				},
				async () => {
					const before = await this.#capturePageState(id, record);
					this.#invalidateSnapshot(id);
					await record.context.scroll(deltaX, deltaY);
					record.snapshot.updatedAt = Date.now();
					if (before) {
						await this.#captureStore?.record(id, {
							action: { kind: "scroll", deltaX, deltaY },
							before,
							after: await this.#pageState(record.context),
						});
					}
				},
			);
		});
	}

	async startCapture(id: string): Promise<BrowserWorkflowCapture> {
		const captureStore = this.#captureStore;
		if (!captureStore) throw new Error("Browser workflow capture is unavailable");
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			return captureStore.start({
				sessionId: id,
				owner: record.snapshot.owner,
				profile: record.snapshot.profile,
				viewport: record.snapshot.viewport,
				initial: await this.#pageState(record.context),
			});
		});
	}

	async stopCapture(id: string): Promise<BrowserWorkflowCapture> {
		const captureStore = this.#captureStore;
		if (!captureStore) throw new Error("Browser workflow capture is unavailable");
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			return captureStore.stop(id);
		});
	}

	getCapture(id: string): BrowserWorkflowCapture | undefined {
		return this.#captureStore?.getForSession(id);
	}

	async snapshot(id: string): Promise<BrowserSemanticSnapshot> {
		this.#assertActive();
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			this.#invalidateSnapshot(id);
			const page = await record.context.snapshot();
			const revision = (this.#snapshotRevisions.get(id) ?? 0) + 1;
			const snapshot: BrowserSemanticSnapshot = {
				revision,
				url: page.url,
				title: page.title,
				elements: page.elements.slice(0, 200).map((element, index) => ({ ...element, ref: `e${index + 1}` })),
			};
			this.#snapshots.set(id, snapshot);
			this.#snapshotRevisions.set(id, revision);
			if (record.snapshot.controlOwner === "agent") record.agentObservationRequired = false;
			return snapshot;
		});
	}

	async click(id: string, revision: number, ref: string): Promise<void> {
		await this.#performElementAction(id, revision, ref, "browser.element.click", {}, (context, index) =>
			context.click(index),
		);
	}

	async fill(id: string, revision: number, ref: string, text: string): Promise<void> {
		await this.#performElementAction(
			id,
			revision,
			ref,
			"browser.element.fill",
			{ textLength: text.length },
			(context, index) => context.fill(index, text),
		);
	}

	async select(id: string, revision: number, ref: string, value: string): Promise<void> {
		await this.#performElementAction(
			id,
			revision,
			ref,
			"browser.element.select",
			{ valueLength: value.length },
			(context, index) => context.select(index, value),
		);
	}

	async scrollIntoView(id: string, revision: number, ref: string): Promise<void> {
		await this.#performElementAction(id, revision, ref, "browser.element.scroll-into-view", {}, (context, index) =>
			context.scrollIntoView(index),
		);
	}

	async press(id: string, key: string): Promise<void> {
		const record = this.#requireSession(id);
		await record.mutations.run(async () => {
			await this.#executeGoverned(
				record,
				"browser.keyboard.press",
				this.#actionTarget(record, "agent", { operation: "press", keyLength: key.length }),
				() => this.#assertMutation(record, "agent"),
				async () => {
					this.#invalidateSnapshot(id);
					await record.context.press(key);
				},
			);
		});
	}

	async screenshot(id: string): Promise<Uint8Array> {
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			return record.context.screenshot();
		});
	}

	async subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			return record.context.subscribeFrames(listener);
		});
	}

	async captureScreenshotArtifact(id: string): Promise<{ png: Uint8Array; artifact?: BrowserArtifact }> {
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			this.#assertOpen(record);
			const png = await record.context.screenshot();
			const artifact = await this.#artifactStore?.saveScreenshot(record.snapshot.owner, png);
			return { png, artifact };
		});
	}

	async listArtifacts(id: string): Promise<BrowserArtifact[]> {
		const owner = this.#requireSession(id).snapshot.owner;
		return (await this.#artifactStore?.list(owner)) ?? [];
	}

	diagnostics(id: string): BrowserDiagnostics {
		const record = this.#requireSession(id);
		this.#assertOpen(record);
		const diagnostics = record.context.diagnostics();
		return {
			console: diagnostics.console.map((entry) => ({ ...entry })),
			networkFailures: diagnostics.networkFailures.map((entry) => ({ ...entry })),
		};
	}

	downloads(id: string): BrowserDownload[] {
		const record = this.#requireSession(id);
		this.#assertOpen(record);
		return record.context.downloads().map((entry) => ({ ...entry }));
	}

	async close(id: string): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record) return;
		if (record.closePromise) return record.closePromise;
		const close = record.mutations.run(async () => {
			record.snapshot.status = "closed";
			record.snapshot.updatedAt = Date.now();
			const errors: unknown[] = [];
			try {
				await this.#captureStore?.interrupt(id);
			} catch (error) {
				errors.push(error);
			}
			try {
				await record.context.close();
			} catch (error) {
				errors.push(error);
			} finally {
				if (record.snapshot.profile.kind === "named") {
					this.#namedProfileLeases.delete(record.snapshot.profile.id);
				}
				this.#snapshots.delete(id);
				this.#snapshotRevisions.delete(id);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, `Failed to close browser session ${id}`);
		});
		record.closePromise = close;
		return record.closePromise;
	}

	async closeOwner(owner: BrowserOwner): Promise<void> {
		await Promise.all(this.list(owner).map((session) => this.close(session.id)));
	}

	async dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#disposePromise = this.#lifecycle.run(async () => {
			const errors: unknown[] = [];
			for (const session of this.#sessions.values()) {
				try {
					await this.close(session.snapshot.id);
				} catch (error) {
					errors.push(error);
				}
			}
			try {
				await this.#driver.dispose();
			} catch (error) {
				errors.push(error);
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose browser sessions");
		});
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#requireSession(id: string): BrowserSessionRecord {
		const record = this.#sessions.get(id);
		if (!record) throw new Error(`Browser session ${id} was not found`);
		return record;
	}

	async #navigateHistory(
		id: string,
		actor: "agent" | "user",
		action: (context: BrowserDriverContext) => Promise<{ url: string; title: string }>,
		name: "back" | "forward" | "reload",
	): Promise<BrowserSessionSnapshot> {
		this.#assertActive();
		const record = this.#requireSession(id);
		return record.mutations.run(async () => {
			const expectedUrl =
				name === "back"
					? record.history[record.historyIndex - 1]
					: name === "forward"
						? record.history[record.historyIndex + 1]
						: record.snapshot.url;
			return this.#executeGoverned(
				record,
				`browser.history.${name}`,
				this.#actionTarget(record, actor, {
					operation: name,
					...(expectedUrl ? { url: canonicalAuditUrl(expectedUrl) } : {}),
				}),
				async () => {
					this.#assertMutation(record, actor);
					if (name === "back" && record.historyIndex < 1) throw new Error("Browser cannot go back");
					if (name === "forward" && record.historyIndex >= record.history.length - 1)
						throw new Error("Browser cannot go forward");
					if (!expectedUrl) throw new Error(`Browser cannot ${name} before navigating to a page`);
					await record.policy.assertResolvedNavigation(expectedUrl);
				},
				async () => {
					const before = await this.#capturePageState(id, record);
					record.snapshot.status = "navigating";
					record.snapshot.updatedAt = Date.now();
					try {
						this.#invalidateSnapshot(id);
						const page = await action(record.context);
						await record.policy.assertResolvedNavigation(page.url);
						record.snapshot.status = "ready";
						record.snapshot.url = page.url;
						record.snapshot.title = page.title;
						if (name === "back") record.historyIndex--;
						if (name === "forward") record.historyIndex++;
						record.snapshot.canGoBack = record.historyIndex > 0;
						record.snapshot.canGoForward =
							record.historyIndex >= 0 && record.historyIndex < record.history.length - 1;
						record.snapshot.lastError = undefined;
					} catch (error) {
						record.snapshot.status = "failed";
						record.snapshot.lastError = `${name}: ${message(error)}`;
						throw error;
					} finally {
						record.snapshot.updatedAt = Date.now();
					}
					if (before) {
						await this.#captureStore?.record(id, {
							action: { kind: name },
							before,
							after: await this.#pageState(record.context),
						});
					}
					return this.get(id)!;
				},
			);
		});
	}

	async #capturePageState(id: string, record: BrowserSessionRecord): Promise<BrowserCapturePageState | undefined> {
		return this.#captureStore?.getForSession(id) ? this.#pageState(record.context) : undefined;
	}

	async #pageState(context: BrowserDriverContext): Promise<BrowserCapturePageState> {
		const page = await context.snapshot();
		return { url: page.url, title: page.title, elements: page.elements };
	}

	#assertMutation(record: BrowserSessionRecord, actor: "agent" | "user"): void {
		this.#assertOpen(record);
		if (record.snapshot.controlOwner !== actor) {
			throw new Error(`Browser is controlled by ${record.snapshot.controlOwner}; ${actor} actions are paused`);
		}
		if (actor === "agent" && record.agentObservationRequired) {
			throw new Error("Browser changed during human control; request a fresh snapshot before acting");
		}
	}

	async #performElementAction(
		id: string,
		revision: number,
		ref: string,
		family: string,
		target: Record<string, string | number>,
		action: (context: BrowserDriverContext, index: number) => Promise<void>,
	): Promise<void> {
		const record = this.#requireSession(id);
		await record.mutations.run(async () => {
			let index: number | undefined;
			await this.#executeGoverned(
				record,
				family,
				this.#actionTarget(record, "agent", {
					operation: family.slice("browser.".length),
					revision: canonicalAuditNumber(revision),
					ref: canonicalAuditText(ref),
					...target,
				}),
				() => {
					this.#assertMutation(record, "agent");
					const snapshot = this.#snapshots.get(id);
					if (!snapshot || snapshot.revision !== revision)
						throw new Error("Browser snapshot is stale; request a fresh snapshot");
					const resolvedIndex = snapshot.elements.findIndex((element) => element.ref === ref);
					if (resolvedIndex < 0) throw new Error(`Browser element ${ref} was not found in snapshot ${revision}`);
					index = resolvedIndex;
				},
				async () => {
					if (index === undefined) throw new Error("Browser element action was not authorized");
					this.#invalidateSnapshot(id);
					await action(record.context, index);
				},
			);
		});
	}

	async #executeGoverned<TResult>(
		record: BrowserSessionRecord,
		family: string,
		target: Record<string, unknown>,
		authorize: () => Promise<void> | void,
		dispatch: () => Promise<TResult>,
	): Promise<TResult> {
		if (!this.#governedActions) {
			await authorize();
			return dispatch();
		}
		const result = await this.#governedActions.execute({
			family,
			target,
			identities: this.#auditIdentities(
				record,
				target.actor === "agent" || target.actor === "user" ? target.actor : record.snapshot.controlOwner,
			),
			canonicalize: (value) => value,
			authorize: async () => {
				try {
					await authorize();
					return {
						decision: "allow",
						reason: "Browser session policy allowed the action",
						policy: record.snapshot.access,
					};
				} catch (error) {
					return { decision: "deny", reason: message(error), policy: record.snapshot.access };
				}
			},
			dispatch: async () => dispatch(),
		});
		if (result.status === "denied") throw new Error(result.reason);
		return result.value;
	}

	#auditIdentities(record: BrowserSessionRecord, actor: "agent" | "user"): ServeAuditIdentities {
		return {
			actorId: actor,
			sessionId: record.snapshot.id,
			...(record.snapshot.owner.kind === "agent-run" ? { agentId: record.snapshot.owner.id } : {}),
		};
	}

	#actionTarget(
		record: BrowserSessionRecord,
		actor: "agent" | "user",
		details: Record<string, unknown>,
	): Record<string, unknown> {
		return {
			actor,
			sessionId: record.snapshot.id,
			owner: { ...record.snapshot.owner },
			workspaceId: record.snapshot.workspace.id,
			...details,
		};
	}

	#assertOpen(record: BrowserSessionRecord): void {
		if (record.snapshot.status === "closed") throw new Error(`Browser session ${record.snapshot.id} is closed`);
	}

	#invalidateSnapshot(id: string): void {
		this.#snapshots.delete(id);
	}

	#assertActive(): void {
		if (this.#disposed) throw new Error("Browser session manager is disposed");
	}

	#activeSessionCount(): number {
		return [...this.#sessions.values()].filter((entry) => entry.snapshot.status !== "closed").length;
	}
}

function assertCoordinate(value: number, name: string, maximum: number): void {
	if (!Number.isFinite(value) || value < 0 || value > maximum) {
		throw new Error(`Browser ${name} must be within the viewport`);
	}
}

function assertOwner(owner: BrowserOwner): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner.id)) throw new Error("Browser owner id is invalid");
}

function normalizeWorkspace(workspace: BrowserWorkspace): BrowserWorkspace {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspace.id)) throw new Error("Browser workspace id is invalid");
	if (workspace.root.trim() === "") throw new Error("Browser workspace root is required");
	return { id: workspace.id, root: resolve(workspace.root) };
}

function assertViewport(viewport: BrowserViewport): void {
	if (!Number.isSafeInteger(viewport.width) || viewport.width < 320 || viewport.width > 7680) {
		throw new Error("Browser viewport width must be between 320 and 7680");
	}
	if (!Number.isSafeInteger(viewport.height) || viewport.height < 240 || viewport.height > 4320) {
		throw new Error("Browser viewport height must be between 240 and 4320");
	}
	if (
		!Number.isFinite(viewport.deviceScaleFactor) ||
		viewport.deviceScaleFactor < 0.5 ||
		viewport.deviceScaleFactor > 4
	) {
		throw new Error("Browser device scale factor must be between 0.5 and 4");
	}
}

function sameOwner(left: BrowserOwner, right: BrowserOwner): boolean {
	return left.kind === right.kind && left.id === right.id;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function canonicalAuditUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "[INVALID_URL]";
	}
	if (url.username) url.username = "redacted";
	if (url.password) url.password = "redacted";
	for (const key of [...url.searchParams.keys()]) {
		if (isSensitiveAuditName(key)) url.searchParams.set(key, "redacted");
	}
	url.searchParams.sort();
	url.hash = "";
	return canonicalAuditText(url.href, 4_000);
}

function canonicalAuditNumber(value: number): number | string {
	return Number.isFinite(value) ? value : "[INVALID_NUMBER]";
}

function canonicalAuditText(value: string, maximum = 512): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum - 14)}...[TRUNCATED]`;
}

function isSensitiveAuditName(value: string): boolean {
	const name = value.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		name === "auth" ||
		name === "code" ||
		name === "key" ||
		name === "sig" ||
		name.includes("authorization") ||
		name.includes("cookie") ||
		name.includes("password") ||
		name.includes("secret") ||
		name.includes("signature") ||
		name.includes("token") ||
		name.includes("apikey")
	);
}
