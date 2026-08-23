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
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1440, height: 960, deviceScaleFactor: 1 };

/** Owns browser contexts and binds each one to a stable local workspace identity. */
export class BrowserSessionManager implements AsyncDisposable {
	readonly #driver: BrowserDriver;
	readonly #profileStore: BrowserProfileStore;
	readonly #maxSessions: number;
	readonly #artifactStore: BrowserArtifactStore | undefined;
	readonly #captureStore: BrowserWorkflowCaptureStore | undefined;
	readonly #sessions = new Map<string, BrowserSessionRecord>();
	readonly #namedProfileLeases = new Map<string, string>();
	readonly #snapshots = new Map<string, BrowserSemanticSnapshot>();
	readonly #snapshotRevisions = new Map<string, number>();
	#disposed = false;

	constructor(
		driver: BrowserDriver,
		profileStore: BrowserProfileStore,
		maxSessions = 4,
		artifactStore?: BrowserArtifactStore,
		captureStore?: BrowserWorkflowCaptureStore,
	) {
		if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
			throw new Error("Browser maxSessions must be positive");
		this.#driver = driver;
		this.#profileStore = profileStore;
		this.#maxSessions = maxSessions;
		this.#artifactStore = artifactStore;
		this.#captureStore = captureStore;
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
		try {
			if (profile.kind === "named") this.#namedProfileLeases.set(profile.id, id);
			const policy = new BrowserPolicy(request.access);
			const context = await this.#driver.createContext({
				profilePath: await this.#profileStore.pathFor(profile),
				viewport,
				runtime,
			});
			await context.setNavigationPolicy(async (url) => {
				await policy.assertResolvedNavigation(url);
			});
			snapshot.status = "ready";
			snapshot.updatedAt = Date.now();
			this.#sessions.set(id, {
				snapshot,
				context,
				policy,
				history: [],
				historyIndex: -1,
			});
			return this.get(id)!;
		} catch (error) {
			if (profile.kind === "named") this.#namedProfileLeases.delete(profile.id);
			snapshot.status = "failed";
			snapshot.updatedAt = Date.now();
			snapshot.lastError = message(error);
			throw error;
		}
	}

	async navigate(id: string, url: string, actor: "agent" | "user" = "agent"): Promise<BrowserSessionSnapshot> {
		this.#assertActive();
		const record = this.#requireSession(id);
		this.#assertMutation(record, actor);
		if (record.snapshot.status === "closed") throw new Error(`Browser session ${id} is closed`);
		const allowedUrl = await record.policy.assertResolvedNavigation(url);
		const before = await this.#capturePageState(id, record);
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
		this.#snapshots.delete(id);
		if (before) {
			await this.#captureStore?.record(id, {
				action: { kind: "navigate", url: record.snapshot.url ?? allowedUrl.href },
				before,
				after: await this.#pageState(record.context),
			});
		}
		return this.get(id)!;
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

	setControl(id: string, controlOwner: "agent" | "user"): BrowserSessionSnapshot {
		const record = this.#requireSession(id);
		if (record.snapshot.status === "closed") throw new Error(`Browser session ${id} is closed`);
		record.snapshot.controlOwner = controlOwner;
		record.snapshot.updatedAt = Date.now();
		return this.get(id)!;
	}

	async pointerClick(id: string, x: number, y: number): Promise<void> {
		const record = this.#requireSession(id);
		this.#assertMutation(record, "user");
		assertCoordinate(x, "x", record.snapshot.viewport.width);
		assertCoordinate(y, "y", record.snapshot.viewport.height);
		const before = await this.#capturePageState(id, record);
		const target = before ? await record.context.elementAt(x, y) : undefined;
		await record.context.pointerClick(x, y);
		record.snapshot.updatedAt = Date.now();
		this.#snapshots.delete(id);
		if (before) {
			await this.#captureStore?.record(id, {
				action: { kind: "click", x, y, target },
				before,
				after: await this.#pageState(record.context),
			});
		}
	}

	async typeText(id: string, text: string): Promise<void> {
		const record = this.#requireSession(id);
		this.#assertMutation(record, "user");
		if (text.length === 0 || text.length > 100_000)
			throw new Error("Browser text must contain 1 to 100000 characters");
		const before = await this.#capturePageState(id, record);
		const target = before ? await record.context.focusedElement() : undefined;
		await record.context.typeText(text);
		record.snapshot.updatedAt = Date.now();
		this.#snapshots.delete(id);
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
	}

	async scroll(id: string, deltaX: number, deltaY: number): Promise<void> {
		const record = this.#requireSession(id);
		this.#assertMutation(record, "user");
		if (
			!Number.isFinite(deltaX) ||
			!Number.isFinite(deltaY) ||
			Math.abs(deltaX) > 10_000 ||
			Math.abs(deltaY) > 10_000
		) {
			throw new Error("Browser scroll values are out of range");
		}
		const before = await this.#capturePageState(id, record);
		await record.context.scroll(deltaX, deltaY);
		record.snapshot.updatedAt = Date.now();
		this.#snapshots.delete(id);
		if (before) {
			await this.#captureStore?.record(id, {
				action: { kind: "scroll", deltaX, deltaY },
				before,
				after: await this.#pageState(record.context),
			});
		}
	}

	async startCapture(id: string): Promise<BrowserWorkflowCapture> {
		if (!this.#captureStore) throw new Error("Browser workflow capture is unavailable");
		const record = this.#requireSession(id);
		return this.#captureStore.start({
			sessionId: id,
			owner: record.snapshot.owner,
			profile: record.snapshot.profile,
			viewport: record.snapshot.viewport,
			initial: await this.#pageState(record.context),
		});
	}

	async stopCapture(id: string): Promise<BrowserWorkflowCapture> {
		if (!this.#captureStore) throw new Error("Browser workflow capture is unavailable");
		return this.#captureStore.stop(id);
	}

	getCapture(id: string): BrowserWorkflowCapture | undefined {
		return this.#captureStore?.getForSession(id);
	}

	async snapshot(id: string): Promise<BrowserSemanticSnapshot> {
		this.#assertActive();
		const page = await this.#requireSession(id).context.snapshot();
		const revision = (this.#snapshotRevisions.get(id) ?? 0) + 1;
		const snapshot: BrowserSemanticSnapshot = {
			revision,
			url: page.url,
			title: page.title,
			elements: page.elements.slice(0, 200).map((element, index) => ({ ...element, ref: `e${index + 1}` })),
		};
		this.#snapshots.set(id, snapshot);
		this.#snapshotRevisions.set(id, revision);
		return snapshot;
	}

	async click(id: string, revision: number, ref: string): Promise<void> {
		this.#assertMutation(this.#requireSession(id), "agent");
		await this.#performElementAction(id, revision, ref, (context, index) => context.click(index));
	}

	async fill(id: string, revision: number, ref: string, text: string): Promise<void> {
		this.#assertMutation(this.#requireSession(id), "agent");
		await this.#performElementAction(id, revision, ref, (context, index) => context.fill(index, text));
	}

	async select(id: string, revision: number, ref: string, value: string): Promise<void> {
		this.#assertMutation(this.#requireSession(id), "agent");
		await this.#performElementAction(id, revision, ref, (context, index) => context.select(index, value));
	}

	async scrollIntoView(id: string, revision: number, ref: string): Promise<void> {
		this.#assertMutation(this.#requireSession(id), "agent");
		await this.#performElementAction(id, revision, ref, (context, index) => context.scrollIntoView(index));
	}

	async press(id: string, key: string): Promise<void> {
		const record = this.#requireSession(id);
		this.#assertMutation(record, "agent");
		await record.context.press(key);
		this.#snapshots.delete(id);
		this.#snapshotRevisions.delete(id);
	}

	async screenshot(id: string): Promise<Uint8Array> {
		return this.#requireSession(id).context.screenshot();
	}

	subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
		return this.#requireSession(id).context.subscribeFrames(listener);
	}

	async captureScreenshotArtifact(id: string): Promise<{ png: Uint8Array; artifact?: BrowserArtifact }> {
		const record = this.#requireSession(id);
		const png = await record.context.screenshot();
		const artifact = await this.#artifactStore?.saveScreenshot(record.snapshot.owner, png);
		return { png, artifact };
	}

	async listArtifacts(id: string): Promise<BrowserArtifact[]> {
		const owner = this.#requireSession(id).snapshot.owner;
		return (await this.#artifactStore?.list(owner)) ?? [];
	}

	diagnostics(id: string): BrowserDiagnostics {
		const diagnostics = this.#requireSession(id).context.diagnostics();
		return {
			console: diagnostics.console.map((entry) => ({ ...entry })),
			networkFailures: diagnostics.networkFailures.map((entry) => ({ ...entry })),
		};
	}

	downloads(id: string): BrowserDownload[] {
		return this.#requireSession(id)
			.context.downloads()
			.map((entry) => ({ ...entry }));
	}

	async close(id: string): Promise<void> {
		const record = this.#sessions.get(id);
		if (!record || record.snapshot.status === "closed") return;
		record.snapshot.status = "closed";
		record.snapshot.updatedAt = Date.now();
		await this.#captureStore?.interrupt(id);
		await record.context.close();
		if (record.snapshot.profile.kind === "named") {
			this.#namedProfileLeases.delete(record.snapshot.profile.id);
		}
		this.#snapshots.delete(id);
	}

	async closeOwner(owner: BrowserOwner): Promise<void> {
		await Promise.all(this.list(owner).map((session) => this.close(session.id)));
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
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
		this.#assertMutation(record, actor);
		const before = await this.#capturePageState(id, record);
		record.snapshot.status = "navigating";
		record.snapshot.updatedAt = Date.now();
		try {
			if (name === "back" && record.historyIndex < 1) throw new Error("Browser cannot go back");
			if (name === "forward" && record.historyIndex >= record.history.length - 1)
				throw new Error("Browser cannot go forward");
			const page = await action(record.context);
			await record.policy.assertResolvedNavigation(page.url);
			record.snapshot.status = "ready";
			record.snapshot.url = page.url;
			record.snapshot.title = page.title;
			if (name === "back") record.historyIndex--;
			if (name === "forward") record.historyIndex++;
			record.snapshot.canGoBack = record.historyIndex > 0;
			record.snapshot.canGoForward = record.historyIndex >= 0 && record.historyIndex < record.history.length - 1;
			record.snapshot.lastError = undefined;
		} catch (error) {
			record.snapshot.status = "failed";
			record.snapshot.lastError = `${name}: ${message(error)}`;
			throw error;
		} finally {
			record.snapshot.updatedAt = Date.now();
		}
		this.#snapshots.delete(id);
		if (before) {
			await this.#captureStore?.record(id, {
				action: { kind: name },
				before,
				after: await this.#pageState(record.context),
			});
		}
		return this.get(id)!;
	}

	async #capturePageState(id: string, record: BrowserSessionRecord): Promise<BrowserCapturePageState | undefined> {
		return this.#captureStore?.getForSession(id) ? this.#pageState(record.context) : undefined;
	}

	async #pageState(context: BrowserDriverContext): Promise<BrowserCapturePageState> {
		const page = await context.snapshot();
		return { url: page.url, title: page.title, elements: page.elements };
	}

	#assertMutation(record: BrowserSessionRecord, actor: "agent" | "user"): void {
		if (record.snapshot.controlOwner !== actor) {
			throw new Error(`Browser is controlled by ${record.snapshot.controlOwner}; ${actor} actions are paused`);
		}
	}

	async #performElementAction(
		id: string,
		revision: number,
		ref: string,
		action: (context: BrowserDriverContext, index: number) => Promise<void>,
	): Promise<void> {
		const snapshot = this.#snapshots.get(id);
		if (!snapshot || snapshot.revision !== revision)
			throw new Error("Browser snapshot is stale; request a fresh snapshot");
		const index = snapshot.elements.findIndex((element) => element.ref === ref);
		if (index < 0) throw new Error(`Browser element ${ref} was not found in snapshot ${revision}`);
		await action(this.#requireSession(id).context, index);
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
