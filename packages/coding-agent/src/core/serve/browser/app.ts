import { PiClient, type PiSessionHandle, type Unsubscribe } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	SessionMetadata,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { installThemedSelect } from "./themed-select.ts";
import { createBrowserWebSocketTransport } from "./websocket-transport.ts";

const status = element("status");
const transcript = element("transcript");
const form = requiredElement<HTMLFormElement>("composer");
const input = requiredElement<HTMLTextAreaElement>("prompt");
const send = requiredElement<HTMLButtonElement>("composer-action");
const attachmentInput = requiredElement<HTMLInputElement>("attachment-input");
const attachmentButton = requiredElement<HTMLButtonElement>("attachment-button");
const attachmentList = element("attachment-list");
const model = requiredElement<HTMLSelectElement>("model");
const agentModel = requiredElement<HTMLSelectElement>("agent-model");
const thinking = requiredElement<HTMLSelectElement>("thinking");
const phase = element("phase");
const agentList = element("agent-list");
const newAgent = requiredElement<HTMLButtonElement>("new-agent");
const agentForm = requiredElement<HTMLFormElement>("agent-form");
const runForm = requiredElement<HTMLFormElement>("run-form");
const runAgent = requiredElement<HTMLSelectElement>("run-agent");
const runList = element("run-list");
const routineList = element("routine-list");
const routineEditor = createRoutineEditor();
const builderChat = element("builder-chat");
const builderChatForm = requiredElement<HTMLFormElement>("builder-chat-form");
const builderPrompt = requiredElement<HTMLTextAreaElement>("builder-prompt");
const builderSubmit = (() => {
	const value = builderChatForm.querySelector<HTMLButtonElement>('button[type="submit"]');
	if (!value) throw new Error("Missing builder chat submit button");
	return value;
})();
const sessionTabs = element("session-tabs");
const connectionList = element("connection-list");
const connectionForm = requiredElement<HTMLFormElement>("connection-form");
const connectionUrl = requiredElement<HTMLInputElement>("connection-url");
const showConnectionForm = requiredElement<HTMLButtonElement>("show-connection-form");
const externalConnectionList = element("external-connection-list");
const externalRunForm = requiredElement<HTMLFormElement>("external-run-form");
const externalRunList = element("external-run-list");
const externalModel = requiredElement<HTMLSelectElement>("external-model");
const previewStatus = element("preview-status");
const previewSession = element("preview-session");
const previewImage = requiredElement<HTMLImageElement>("preview-image");
const previewForm = requiredElement<HTMLFormElement>("preview-form");
const previewAddress = requiredElement<HTMLInputElement>("preview-address");
const previewBack = requiredElement<HTMLButtonElement>("preview-back");
const previewForward = requiredElement<HTMLButtonElement>("preview-forward");
const previewReload = requiredElement<HTMLButtonElement>("preview-reload");
const previewControl = requiredElement<HTMLButtonElement>("preview-control");
const previewTypeForm = requiredElement<HTMLFormElement>("preview-type-form");
const previewType = requiredElement<HTMLInputElement>("preview-type");
const previewConsole = element("preview-console");
const previewNetwork = element("preview-network");
const modelPicker = installThemedSelect(model);
const agentModelPicker = installThemedSelect(agentModel);
const externalModelPicker = installThemedSelect(externalModel);
const routineModelPicker = installThemedSelect(routineEditor.model);
const capabilityToken = new URL(location.href).searchParams.get("token");

let client: PiClient | undefined;
let session: PiSessionHandle | undefined;
let unsubscribeSession: Unsubscribe | undefined;
let builderSession: PiSessionHandle | undefined;
let unsubscribeBuilder: Unsubscribe | undefined;
let activeSidebarAgent: AgentSummary | undefined;
let activeTargetKey: string | undefined;
let activePreviewSessionId: string | undefined;
let activePreviewSession: BrowserSessionSummary | undefined;
let previewStream: WebSocket | undefined;
let previewStreamSessionId: string | undefined;
let previewFrameUrl: string | undefined;
let selectedExternalConnectionId: string | undefined;
let availableModels: ModelMetadata[] = [];
let agents: AgentSummary[] = [];
const attachmentsBySession = new Map<string, AttachmentSummary[]>();

interface AttachmentSummary {
	id: string;
	name: string;
	mimeType: string;
	size: number;
}

interface CapabilityEntry {
	id: string;
	name: string;
	description: string;
	status: "active" | "available" | "unavailable";
	scope: string;
	source?: string;
	path?: string;
}

interface CapabilitySnapshot {
	tools: CapabilityEntry[];
	skills: CapabilityEntry[];
	extensions: CapabilityEntry[];
	mcpServers: CapabilityEntry[];
	acpConnections: CapabilityEntry[];
	modelProviders: CapabilityEntry[];
}

interface ConnectionEntry {
	id: string;
	label: string;
	client: PiClient;
	primary: boolean;
	sessions: readonly SessionMetadata[];
}

interface SessionTarget {
	key: string;
	connectionId: string;
	session: SessionMetadata;
}

interface ExternalConnectionSummary {
	id: string;
	name: string;
	description: string;
	inputLabel: "Task" | "Goal";
	available: boolean;
	warning?: string;
	defaultModel: { provider: string; id: string };
	models: Array<{ provider: string; id: string; name: string }>;
}

interface ExternalRunSummary {
	id: string;
	connectionId: string;
	prompt: string;
	cwd: string;
	model: { provider: string; id: string };
	status: string;
	createdAt: number;
	error?: string;
}

interface BrowserConsoleStatus {
	browser: "chromium";
	installed: boolean;
	executablePath: string;
	sessionCount: number;
}

interface BrowserSessionSummary {
	id: string;
	owner: { kind: "pi-session" | "agent-run" | "external-run"; id: string };
	status: "starting" | "ready" | "navigating" | "failed" | "closed";
	url?: string;
	title?: string;
	updatedAt: number;
	lastError?: string;
	controlOwner: "agent" | "user";
	viewport: { width: number; height: number; deviceScaleFactor: number };
	canGoBack: boolean;
	canGoForward: boolean;
}

interface BrowserDiagnostics {
	console: Array<{ type: string; text: string; timestamp: number }>;
	networkFailures: Array<{ url: string; method: string; reason: string; timestamp: number }>;
}

let externalConnections: ExternalConnectionSummary[] = [];

const connections = new Map<string, ConnectionEntry>();
const reconnecting = new Set<string>();
const sessionAliases = readSessionAliases();

function readSessionAliases(): Record<string, string> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem("pi-serve-session-aliases") ?? "{}");
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		return Object.fromEntries(
			Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
	} catch {
		return {};
	}
}

function sessionDisplayName(target: SessionTarget): string {
	return sessionAliases[target.key] ?? target.session.sessionName ?? "Pi session";
}

function renameSession(target: SessionTarget): void {
	const alias = window.prompt("Session name (leave blank to restore the Pi name)", sessionDisplayName(target));
	if (alias === null) return;
	const trimmed = alias.trim();
	if (trimmed) sessionAliases[target.key] = trimmed;
	else delete sessionAliases[target.key];
	localStorage.setItem("pi-serve-session-aliases", JSON.stringify(sessionAliases));
	renderSessionNavigation();
}

function element(id: string): HTMLElement {
	const value = document.getElementById(id);
	if (!value) throw new Error(`Missing #${id}`);
	return value;
}

function requiredElement<T extends HTMLElement>(id: string): T {
	return element(id) as T;
}

function createRoutineEditor(): {
	form: HTMLFormElement;
	id: HTMLInputElement;
	name: HTMLInputElement;
	targetKind: HTMLSelectElement;
	agent: HTMLSelectElement;
	acp: HTMLSelectElement;
	skill: HTMLInputElement;
	prompt: HTMLTextAreaElement;
	cwd: HTMLInputElement;
	model: HTMLSelectElement;
	interval: HTMLInputElement;
	enabled: HTMLInputElement;
	agentLabel: HTMLLabelElement;
	acpLabel: HTMLLabelElement;
	skillLabel: HTMLLabelElement;
	cwdLabel: HTMLLabelElement;
	deleteButton: HTMLButtonElement;
	runButton: HTMLButtonElement;
	clearButton: HTMLButtonElement;
} {
	const panel = element("routines");
	const card = document.createElement("div");
	card.className = "card";
	const title = document.createElement("strong");
	title.id = "routine-editor-title";
	title.textContent = "New routine";
	const form = document.createElement("form");
	form.id = "routine-editor";
	const id = document.createElement("input");
	id.type = "hidden";
	const name = document.createElement("input");
	name.required = true;
	const targetKind = document.createElement("select");
	for (const [value, label] of [
		["agent", "Local agent"],
		["acp", "ACP target"],
		["skill", "Skill"],
	] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		targetKind.append(option);
	}
	const agent = document.createElement("select");
	const acp = document.createElement("select");
	const skill = document.createElement("input");
	skill.placeholder = "skill-name";
	const prompt = document.createElement("textarea");
	prompt.required = true;
	const cwd = document.createElement("input");
	const model = document.createElement("select");
	const interval = document.createElement("input");
	interval.type = "number";
	interval.min = "1";
	interval.value = "60";
	interval.required = true;
	const enabled = document.createElement("input");
	enabled.type = "checkbox";
	const label = (text: string, control: HTMLElement) => {
		const wrapper = document.createElement("label");
		wrapper.append(text, control);
		return wrapper;
	};
	const agentLabel = label("Agent", agent);
	const acpLabel = label("ACP target", acp);
	const skillLabel = label("Skill name", skill);
	const cwdLabel = label("Working directory", cwd);
	const enabledLabel = label("Active", enabled);
	const actions = document.createElement("div");
	actions.className = "routine-actions";
	const save = document.createElement("button");
	save.type = "submit";
	save.className = "primary";
	save.textContent = "Save";
	const runButton = document.createElement("button");
	runButton.type = "button";
	runButton.textContent = "Run now";
	const clearButton = document.createElement("button");
	clearButton.type = "button";
	clearButton.textContent = "New";
	const deleteButton = document.createElement("button");
	deleteButton.type = "button";
	deleteButton.className = "danger";
	deleteButton.textContent = "Delete";
	actions.append(save, runButton, clearButton, deleteButton);
	form.append(
		id,
		label("Name", name),
		label("Run with", targetKind),
		agentLabel,
		acpLabel,
		skillLabel,
		label("Instructions", prompt),
		cwdLabel,
		label("Model", model),
		label("Run every (minutes)", interval),
		enabledLabel,
		actions,
	);
	card.append(title, form);
	panel.insertBefore(card, routineList);
	return {
		form,
		id,
		name,
		targetKind,
		agent,
		acp,
		skill,
		prompt,
		cwd,
		model,
		interval,
		enabled,
		agentLabel,
		acpLabel,
		skillLabel,
		cwdLabel,
		deleteButton,
		runButton,
		clearButton,
	};
}

function setStatus(message: string, error = false): void {
	status.textContent = message;
	status.classList.toggle("error", error);
}

function setBusy(snapshot: SessionSnapshot): void {
	const busy = snapshot.phase !== "idle";
	phase.textContent = snapshot.phase;
	send.classList.toggle("is-stopping", busy);
	send.setAttribute("aria-label", busy ? "Stop response" : "Send message");
	model.disabled = busy;
	thinking.disabled = busy;
	attachmentButton.disabled = busy || !activeConnectionIsPrimary();
	attachmentInput.disabled = busy || !activeConnectionIsPrimary();
}

function render(snapshot: SessionSnapshot): void {
	const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	const previousScrollTop = transcript.scrollTop;
	transcript.replaceChildren(...snapshot.transcript.map(renderItem));
	setBusy(snapshot);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
	modelPicker.refresh();
	thinking.value = snapshot.thinkingLevel;
	transcript.scrollTop = nearBottom ? transcript.scrollHeight : previousScrollTop;
}

function renderItem(item: TranscriptItem): HTMLElement {
	const article = document.createElement("article");
	article.className = `message ${item.role}`;
	const label = document.createElement("div");
	label.className = "message-label";
	label.textContent = item.role === "assistant" ? "π" : item.role;
	article.append(label);

	if (item.role === "tool") {
		appendText(article, `${item.toolName} · ${item.status}`);
		for (const content of item.content) {
			if (content.type === "text") appendText(article, content.text);
		}
		return article;
	}

	for (const content of item.content) {
		if (content.type === "text") appendText(article, content.text);
		else if (content.type === "thinking") appendText(article, content.thinking, "thinking");
		else if (content.type === "toolCall") appendText(article, `Using ${content.toolName}`, "tool-call");
		else if (content.type === "image") appendText(article, `[image: ${content.mimeType}]`);
	}
	return article;
}

function appendText(parent: HTMLElement, text: string, className?: string): void {
	const block = document.createElement("div");
	if (className) block.className = className;
	block.textContent = text;
	parent.append(block);
}

function populateModels(models: readonly ModelMetadata[], includeAgentModels = false): void {
	availableModels = [...models];
	const options = models.map((entry) => {
		const option = document.createElement("option");
		option.value = `${entry.provider}/${entry.id}`;
		option.textContent = `${entry.provider} / ${entry.name}`;
		return option;
	});
	model.replaceChildren(...options);
	modelPicker.refresh();
	if (!includeAgentModels) return;
	const inherit = document.createElement("option");
	inherit.value = "";
	inherit.textContent = "Inherit current session";
	agentModel.replaceChildren(
		inherit,
		...models.map((entry) => {
			const option = document.createElement("option");
			option.value = `${entry.provider}/${entry.id}`;
			option.textContent = `${entry.provider} / ${entry.name}`;
			return option;
		}),
	);
	agentModelPicker.refresh();
	refreshRoutineEditorOptions();
}

function socketUrl(controlUrl: string): { label: string; url: string } {
	const parsed = new URL(controlUrl, location.href);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Pi control URL must use http or https");
	}
	const token = parsed.searchParams.get("token");
	if (!token) throw new Error("Pi control URL is missing its capability token");
	const socket = new URL(parsed.origin);
	socket.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
	socket.pathname = "/pi";
	socket.searchParams.set("token", token);
	return { label: parsed.host, url: socket.href };
}

async function addConnection(controlUrl: string, primary = false): Promise<ConnectionEntry> {
	const socket = socketUrl(controlUrl);
	const connectedClient = await PiClient.connect({
		transportFactory: createBrowserWebSocketTransport(socket.url),
		onListenerError: (error) => setStatus(error.message, true),
	});
	const id = connectedClient.snapshot?.serverId ?? crypto.randomUUID();
	const existing = connections.get(id);
	if (existing) {
		await connectedClient.dispose();
		return existing;
	}
	const entry: ConnectionEntry = {
		id,
		label: primary ? "This Pi" : socket.label,
		client: connectedClient,
		primary,
		sessions: [],
	};
	connections.set(id, entry);
	connectedClient.onConnectionStateChange((change) => {
		if (change.state === "disconnected") void reconnect(entry);
	});
	await refreshSessionTargets();
	return entry;
}

function sessionTargets(): SessionTarget[] {
	return [...connections.values()].flatMap((entry) =>
		entry.sessions
			.filter(
				(metadata) => !metadata.sessionName?.startsWith("builder:") && !metadata.sessionName?.startsWith("agent:"),
			)
			.map((metadata) => ({
				key: `${entry.id}:${metadata.id}`,
				connectionId: entry.id,
				session: metadata,
			})),
	);
}

async function refreshSessionTargets(): Promise<void> {
	await Promise.all(
		[...connections.values()].map(async (entry) => {
			try {
				entry.sessions = await entry.client.listSessions();
			} catch {
				entry.sessions = [];
			}
		}),
	);
	renderSessionNavigation();
}

function renderSessionNavigation(): void {
	const targets = sessionTargets();
	sessionTabs.replaceChildren(
		...targets.map((target) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab";
			button.classList.toggle("active", target.key === activeTargetKey);
			const sessionName = sessionDisplayName(target);
			const connection = connections.get(target.connectionId);
			button.textContent = connections.size > 1 && connection ? `${connection.label} · ${sessionName}` : sessionName;
			button.title = target.session.cwd ?? target.session.id;
			button.addEventListener("click", () => void switchSession(target));
			button.addEventListener("dblclick", () => renameSession(target));
			return button;
		}),
	);
	connectionList.replaceChildren(
		...[...connections.values()].map((entry) => {
			const group = document.createElement("section");
			group.className = "connection-group";
			const heading = document.createElement("div");
			heading.className = "connection-heading";
			const indicator = document.createElement("i");
			const label = document.createElement("span");
			label.textContent = entry.label;
			heading.append(indicator, label);
			if (!entry.primary) {
				const remove = document.createElement("button");
				remove.type = "button";
				remove.title = `Disconnect ${entry.label}`;
				remove.setAttribute("aria-label", `Disconnect ${entry.label}`);
				remove.textContent = "×";
				remove.addEventListener("click", () => void removeConnection(entry.id));
				heading.append(remove);
			}
			group.append(heading);
			for (const target of targets.filter((candidate) => candidate.connectionId === entry.id)) {
				const row = document.createElement("div");
				row.className = "nav-item session-entry session-row";
				const button = document.createElement("button");
				button.type = "button";
				button.className = "session-select";
				button.classList.toggle("active", target.key === activeTargetKey);
				const name = document.createElement("strong");
				name.textContent = sessionDisplayName(target);
				const cwd = document.createElement("span");
				cwd.className = "muted";
				cwd.textContent = target.session.cwd ?? "Live local process";
				button.append(name, cwd);
				button.addEventListener("click", () => void switchSession(target));
				const rename = document.createElement("button");
				rename.type = "button";
				rename.className = "session-rename";
				rename.textContent = "Rename";
				rename.addEventListener("click", () => renameSession(target));
				row.append(button, rename);
				group.append(row);
			}
			return group;
		}),
	);
}

async function switchSession(target: SessionTarget): Promise<void> {
	if (target.key === activeTargetKey && session?.attached) return;
	const entry = connections.get(target.connectionId);
	if (!entry) throw new Error("Pi connection is unavailable");
	unsubscribeSession?.();
	unsubscribeSession = undefined;
	await session?.dispose().catch(() => {});
	session = await entry.client.attachSession(target.session.id);
	activeTargetKey = target.key;
	populateModels(entry.client.snapshot?.models ?? []);
	unsubscribeSession = session.subscribe(render);
	if (session.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
	void loadPreview().catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
	setStatus(`Connected to ${entry.label}`);
}

function setPreviewMessage(message: string, error = false): void {
	previewStatus.textContent = message;
	previewStatus.classList.toggle("error", error);
}

function setPreviewControls(browserSession: BrowserSessionSummary | undefined): void {
	const sessionId = browserSession?.id;
	const userControls = browserSession?.controlOwner === "user";
	activePreviewSessionId = sessionId;
	activePreviewSession = browserSession;
	previewAddress.value = browserSession?.url ?? "";
	previewAddress.disabled = !userControls;
	previewBack.disabled = !userControls || !browserSession?.canGoBack;
	previewForward.disabled = !userControls || !browserSession?.canGoForward;
	previewReload.disabled = !userControls || !browserSession?.url;
	previewType.disabled = !userControls;
	previewControl.disabled = sessionId === undefined;
	previewControl.textContent = userControls ? "Return to agent" : "Take control";
}

function ensurePreviewStream(sessionId: string): boolean {
	if (!capabilityToken) return false;
	if (!previewStream || previewStream.readyState >= WebSocket.CLOSING) {
		const protocol = location.protocol === "https:" ? "wss:" : "ws:";
		previewStream = new WebSocket(
			`${protocol}//${location.host}/browser-stream?token=${encodeURIComponent(capabilityToken)}`,
		);
		previewStream.binaryType = "arraybuffer";
		previewStream.addEventListener("open", () => subscribePreviewStream());
		previewStream.addEventListener("message", handlePreviewStreamMessage);
		previewStream.addEventListener("close", () => {
			previewStream = undefined;
			previewStreamSessionId = undefined;
		});
	}
	if (previewStream.readyState === WebSocket.OPEN && previewStreamSessionId !== sessionId) {
		previewStreamSessionId = sessionId;
		previewStream.send(JSON.stringify({ type: "subscribe", sessionId }));
	}
	return previewStream.readyState === WebSocket.OPEN;
}

function subscribePreviewStream(): void {
	if (!previewStream || previewStream.readyState !== WebSocket.OPEN || !activePreviewSessionId) return;
	previewStreamSessionId = activePreviewSessionId;
	previewStream.send(JSON.stringify({ type: "subscribe", sessionId: activePreviewSessionId }));
}

function handlePreviewStreamMessage(event: MessageEvent): void {
	if (typeof event.data === "string") {
		const value: unknown = JSON.parse(event.data);
		if (typeof value === "object" && value !== null && "type" in value && value.type === "error") {
			setPreviewMessage(
				"message" in value && typeof value.message === "string" ? value.message : "Browser stream failed",
				true,
			);
		}
		return;
	}
	if (!(event.data instanceof ArrayBuffer)) return;
	const packet = new Uint8Array(event.data);
	if (packet.byteLength < 6 || packet[0] !== 1) return;
	const metadataLength = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(1);
	if (metadataLength < 2 || 5 + metadataLength >= packet.byteLength) return;
	const metadata: unknown = JSON.parse(new TextDecoder().decode(packet.subarray(5, 5 + metadataLength)));
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		!("sessionId" in metadata) ||
		metadata.sessionId !== activePreviewSessionId
	)
		return;
	const nextUrl = URL.createObjectURL(new Blob([packet.subarray(5 + metadataLength)], { type: "image/jpeg" }));
	previewImage.src = nextUrl;
	if (previewFrameUrl) URL.revokeObjectURL(previewFrameUrl);
	previewFrameUrl = nextUrl;
}

async function loadPreview(): Promise<void> {
	if (!capabilityToken) return;
	if (!session || !activeConnectionIsPrimary()) {
		previewSession.textContent = "No local Pi session selected";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		setPreviewMessage("Preview is available for sessions hosted by this Pi console.");
		previewStream?.close();
		return;
	}
	const statusResponse = await fetch(`/browser/status?token=${encodeURIComponent(capabilityToken)}`);
	if (!statusResponse.ok) throw new Error(await responseError(statusResponse, "Could not load browser status"));
	const browserStatus: unknown = await statusResponse.json();
	if (!isBrowserConsoleStatus(browserStatus)) throw new Error("Browser status response is invalid");
	if (!browserStatus.installed) {
		previewSession.textContent = "Managed Chromium is not installed";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		setPreviewMessage("Run `pi browser install chromium`, then ask Pi to open a local URL.");
		return;
	}
	const sessionsResponse = await fetch(
		`/browser/sessions?token=${encodeURIComponent(capabilityToken)}&ownerKind=pi-session&ownerId=${encodeURIComponent(session.id)}`,
	);
	if (!sessionsResponse.ok) throw new Error(await responseError(sessionsResponse, "Could not load browser sessions"));
	const payload: unknown = await sessionsResponse.json();
	if (!isBrowserSessionList(payload)) throw new Error("Browser session response is invalid");
	const browserSession = payload.sessions
		.filter((entry) => entry.status !== "closed")
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	if (!browserSession) {
		previewSession.textContent = "No browser session for this Pi chat";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		setPreviewMessage("Ask Pi to use browser_open with a permitted local URL.");
		previewStream?.close();
		return;
	}
	previewSession.textContent = [browserSession.title ?? "Untitled page", browserSession.url ?? browserSession.status]
		.filter(Boolean)
		.join(" · ");
	setPreviewControls(browserSession);
	if (browserSession.status === "failed") {
		previewImage.removeAttribute("src");
		setPreviewMessage(browserSession.lastError ?? "Browser session failed", true);
		return;
	}
	if (!ensurePreviewStream(browserSession.id)) {
		previewImage.src = `/browser/sessions/${encodeURIComponent(browserSession.id)}/screenshot?token=${encodeURIComponent(capabilityToken)}&at=${browserSession.updatedAt}`;
	}
	setPreviewMessage(`${browserSession.status} · managed Chromium · live`);
	if (document.querySelector("[data-preview-tab].active")?.getAttribute("data-preview-tab") !== "page") {
		void loadPreviewDiagnostics();
	}
}

async function loadPreviewDiagnostics(): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) {
		previewConsole.replaceChildren();
		previewNetwork.replaceChildren();
		return;
	}
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/diagnostics?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser diagnostics"));
	const diagnostics: unknown = await response.json();
	if (!isBrowserDiagnostics(diagnostics)) throw new Error("Browser diagnostics response is invalid");
	previewConsole.replaceChildren(
		...diagnostics.console.map((entry) => diagnosticRow(`${entry.type} · ${entry.text}`, entry.timestamp)),
	);
	previewNetwork.replaceChildren(
		...diagnostics.networkFailures.map((entry) =>
			diagnosticRow(`${entry.method} ${entry.url}\n${entry.reason}`, entry.timestamp),
		),
	);
	if (diagnostics.console.length === 0) appendText(previewConsole, "No console entries", "muted");
	if (diagnostics.networkFailures.length === 0) appendText(previewNetwork, "No failed requests", "muted");
}

function diagnosticRow(text: string, timestamp: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "preview-diagnostic";
	appendText(row, new Date(timestamp).toLocaleTimeString(), "muted");
	appendText(row, text);
	return row;
}

function isBrowserDiagnostics(value: unknown): value is BrowserDiagnostics {
	return (
		typeof value === "object" &&
		value !== null &&
		"console" in value &&
		Array.isArray(value.console) &&
		"networkFailures" in value &&
		Array.isArray(value.networkFailures)
	);
}

async function navigatePreview(url: string): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/navigate?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ url }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not navigate managed browser"));
	setPreviewMessage("Navigating managed browser…");
	await loadPreview();
}

async function previewAction(action: "back" | "forward" | "reload"): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/${action}?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST" },
	);
	if (!response.ok) throw new Error(await responseError(response, `Could not ${action} managed browser`));
	await loadPreview();
}

async function setPreviewControl(controlOwner: "agent" | "user"): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/control?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ controlOwner }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not change browser control"));
	await loadPreview();
}

async function sendPreviewInput(input: Record<string, unknown>): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	if (previewStream?.readyState === WebSocket.OPEN && previewStreamSessionId === activePreviewSessionId) {
		previewStream.send(
			JSON.stringify({ type: "input", sessionId: activePreviewSessionId, requestId: crypto.randomUUID(), input }),
		);
		return;
	}
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/input?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not send browser input"));
	await loadPreview();
}

function isBrowserConsoleStatus(value: unknown): value is BrowserConsoleStatus {
	return (
		typeof value === "object" &&
		value !== null &&
		"browser" in value &&
		value.browser === "chromium" &&
		"installed" in value &&
		typeof value.installed === "boolean" &&
		"sessionCount" in value &&
		typeof value.sessionCount === "number"
	);
}

function isBrowserSessionList(value: unknown): value is { sessions: BrowserSessionSummary[] } {
	if (typeof value !== "object" || value === null || !("sessions" in value) || !Array.isArray(value.sessions)) {
		return false;
	}
	return value.sessions.every((entry) => {
		return (
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"status" in entry &&
			typeof entry.status === "string" &&
			"updatedAt" in entry &&
			typeof entry.updatedAt === "number" &&
			"controlOwner" in entry &&
			(entry.controlOwner === "agent" || entry.controlOwner === "user") &&
			"viewport" in entry &&
			typeof entry.viewport === "object" &&
			entry.viewport !== null &&
			"width" in entry.viewport &&
			typeof entry.viewport.width === "number" &&
			"height" in entry.viewport &&
			typeof entry.viewport.height === "number" &&
			"canGoBack" in entry &&
			typeof entry.canGoBack === "boolean" &&
			"canGoForward" in entry &&
			typeof entry.canGoForward === "boolean"
		);
	});
}

function activeConnectionIsPrimary(): boolean {
	const target = sessionTargets().find((candidate) => candidate.key === activeTargetKey);
	return target ? connections.get(target.connectionId)?.primary === true : false;
}

function activeAttachments(): AttachmentSummary[] {
	if (!session) return [];
	let values = attachmentsBySession.get(session.id);
	if (!values) {
		values = [];
		attachmentsBySession.set(session.id, values);
	}
	return values;
}

function renderAttachments(): void {
	const local = activeConnectionIsPrimary();
	attachmentButton.disabled = !local;
	attachmentButton.title = local ? "Attach files" : "Attachments require a session hosted by this Pi console";
	attachmentList.replaceChildren(
		...activeAttachments().map((attachment) => {
			const chip = document.createElement("div");
			chip.className = "attachment-chip";
			const preview = document.createElement("a");
			preview.href = `/attachments/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(capabilityToken ?? "")}`;
			preview.target = "_blank";
			preview.rel = "noreferrer";
			preview.textContent = attachment.name;
			preview.title = "Preview or download attachment";
			const size = document.createElement("span");
			size.textContent = formatBytes(attachment.size);
			const rename = document.createElement("button");
			rename.type = "button";
			rename.textContent = "Rename";
			rename.addEventListener("click", () => {
				void renameAttachment(attachment).catch((error: unknown) =>
					setStatus(error instanceof Error ? error.message : String(error), true),
				);
			});
			const remove = document.createElement("button");
			remove.type = "button";
			remove.setAttribute("aria-label", `Remove ${attachment.name}`);
			remove.textContent = "×";
			remove.addEventListener("click", () => {
				void removeAttachment(attachment).catch((error: unknown) =>
					setStatus(error instanceof Error ? error.message : String(error), true),
				);
			});
			chip.append(preview, size, rename, remove);
			return chip;
		}),
	);
}

async function uploadFiles(files: Iterable<File>): Promise<void> {
	if (!session || !activeConnectionIsPrimary()) {
		setStatus("Attachments require a session hosted by this Pi console", true);
		return;
	}
	const current = activeAttachments();
	for (const file of files) {
		if (current.length >= 8) throw new Error("A prompt can include at most 8 attachments");
		if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} exceeds 10 MiB`);
		setStatus(`Uploading ${file.name}…`);
		const response = await fetch(`/attachments?token=${encodeURIComponent(capabilityToken ?? "")}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				sessionId: session.id,
				name: file.name || `attachment-${Date.now()}`,
				mimeType: file.type || "application/octet-stream",
				data: arrayBufferToBase64(await file.arrayBuffer()),
			}),
		});
		if (!response.ok) throw new Error(await responseError(response, `Could not upload ${file.name}`));
		const payload: unknown = await response.json();
		if (!isAttachmentSummary(payload)) throw new Error("Attachment service returned an invalid response");
		current.push(payload);
		renderAttachments();
	}
	setStatus(`${current.length} attachment${current.length === 1 ? "" : "s"} ready`);
}

async function renameAttachment(attachment: AttachmentSummary): Promise<void> {
	const name = window.prompt("Attachment name", attachment.name)?.trim();
	if (!name || name === attachment.name) return;
	const response = await fetch(
		`/attachments/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(capabilityToken ?? "")}`,
		{ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not rename attachment"));
	const payload: unknown = await response.json();
	if (!isAttachmentSummary(payload)) throw new Error("Attachment service returned an invalid response");
	Object.assign(attachment, payload);
	renderAttachments();
}

async function removeAttachment(attachment: AttachmentSummary): Promise<void> {
	const response = await fetch(
		`/attachments/${encodeURIComponent(attachment.id)}?token=${encodeURIComponent(capabilityToken ?? "")}`,
		{ method: "DELETE" },
	);
	if (!response.ok && response.status !== 404)
		throw new Error(await responseError(response, "Could not remove attachment"));
	if (session)
		attachmentsBySession.set(
			session.id,
			activeAttachments().filter((entry) => entry.id !== attachment.id),
		);
	renderAttachments();
}

function isAttachmentSummary(value: unknown): value is AttachmentSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"mimeType" in value &&
		typeof value.mimeType === "string" &&
		"size" in value &&
		typeof value.size === "number"
	);
}

function arrayBufferToBase64(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function responseError(response: Response, fallback: string): Promise<string> {
	try {
		const value: unknown = await response.json();
		if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string") {
			return value.error;
		}
	} catch {}
	return `${fallback}: HTTP ${response.status}`;
}

async function removeConnection(id: string): Promise<void> {
	const entry = connections.get(id);
	if (!entry || entry.primary) return;
	if (activeTargetKey?.startsWith(`${id}:`)) {
		activeTargetKey = undefined;
		const fallback = sessionTargets().find((target) => target.connectionId !== id);
		if (fallback) await switchSession(fallback);
	}
	connections.delete(id);
	await entry.client.dispose();
	renderSessionNavigation();
}

async function connect(): Promise<void> {
	if (!capabilityToken) throw new Error("The capability token is missing");
	const primary = await addConnection(location.href, true);
	client = primary.client;
	populateModels(primary.client.snapshot?.models ?? [], true);
	const initial = sessionTargets().find((target) => target.connectionId === primary.id);
	if (!initial) throw new Error("The active Pi session is unavailable");
	await switchSession(initial);
	await Promise.all([
		loadAgents().catch(() => {}),
		loadRoutines().catch(() => {}),
		loadCapabilities().catch(() => {}),
		loadExternalConnections().catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		),
	]);
}

async function loadCapabilities(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/capabilities.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load capabilities: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isCapabilitySnapshot(payload)) throw new Error("Capability catalog returned an invalid response");
	const groups: Array<[string, CapabilityEntry[]]> = [
		["Tools", payload.tools],
		["Skills", payload.skills],
		["Extensions", payload.extensions],
		["MCP servers", payload.mcpServers],
		["ACP connectors", payload.acpConnections],
		["Model providers", payload.modelProviders],
	];
	element("capability-list").replaceChildren(
		...groups.map(([label, entries]) => {
			const section = document.createElement("section");
			section.className = "capability-section";
			const heading = document.createElement("h3");
			heading.textContent = `${label} · ${entries.length}`;
			section.append(heading);
			if (entries.length === 0) {
				appendText(section, `No ${label.toLowerCase()} configured`, "muted");
				return section;
			}
			for (const entry of entries) {
				const card = document.createElement("div");
				card.className = "card capability-card";
				const title = document.createElement("strong");
				const name = document.createElement("span");
				name.textContent = entry.name;
				const state = document.createElement("span");
				state.className = "capability-status";
				state.textContent = entry.status;
				title.append(name, state);
				appendText(card, entry.description, "muted");
				const meta = document.createElement("div");
				meta.className = "capability-meta";
				meta.textContent = [entry.scope, entry.source, entry.path].filter(Boolean).join(" · ");
				card.prepend(title);
				card.append(meta);
				section.append(card);
			}
			return section;
		}),
	);
}

function isCapabilitySnapshot(value: unknown): value is CapabilitySnapshot {
	if (typeof value !== "object" || value === null) return false;
	return ["tools", "skills", "extensions", "mcpServers", "acpConnections", "modelProviders"].every(
		(key) => key in value && Array.isArray(value[key as keyof typeof value]),
	);
}

interface AgentSummary {
	id: string;
	source: "managed" | "pi-agent";
	personaId?: string;
	name: string;
	description: string;
	tools: string[];
	memory: "none" | "notes";
	persona: string;
	executor: "session" | "harness";
	permissionPolicy: "read-only" | "workspace-write";
	model?: { provider: string; id: string };
	browser?: { access: "disabled" | "loopback" | "public-web" | "private-network"; profile: { kind: "ephemeral" } };
	schedules: Array<{ id: string; prompt: string; intervalMinutes: number; enabled: boolean }>;
}

async function loadAgents(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/agents.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load agents: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isAgentList(payload)) throw new Error("Agent registry returned an invalid response");
	agents = payload.agents;
	agentList.replaceChildren(
		...payload.agents.map((agent) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "nav-item agent-entry";
			const icon = agent.personaId ? document.createElement("img") : document.createElement("span");
			icon.className = "agent-icon";
			if (icon instanceof HTMLImageElement) {
				icon.src = `/agents/${encodeURIComponent(agent.id)}/icon?token=${encodeURIComponent(capabilityToken ?? "")}`;
				icon.alt = "";
				icon.addEventListener("error", () => {
					const fallback = document.createElement("span");
					fallback.className = "agent-icon";
					fallback.textContent = "π";
					icon.replaceWith(fallback);
				});
			} else {
				icon.textContent = "π";
			}
			const name = document.createElement("strong");
			name.className = "agent-name";
			name.textContent = agent.name;
			button.append(icon, name);
			button.title = agent.description;
			button.addEventListener("click", () => void openAgent(agent));
			return button;
		}),
	);
	const selectedAgent = runAgent.value;
	runAgent.replaceChildren(
		...payload.agents.map((agent) => {
			const option = document.createElement("option");
			option.value = agent.id;
			option.textContent = agent.name;
			return option;
		}),
	);
	if (payload.agents.some((agent) => agent.id === selectedAgent)) runAgent.value = selectedAgent;
	refreshRoutineEditorOptions();
}

function isAgentList(value: unknown): value is { agents: AgentSummary[] } {
	if (typeof value !== "object" || value === null || !("agents" in value) || !Array.isArray(value.agents))
		return false;
	return value.agents.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"source" in entry &&
			(entry.source === "managed" || entry.source === "pi-agent") &&
			(!("personaId" in entry) || entry.personaId === undefined || typeof entry.personaId === "string") &&
			"name" in entry &&
			typeof entry.name === "string" &&
			"description" in entry &&
			typeof entry.description === "string" &&
			"tools" in entry &&
			Array.isArray(entry.tools) &&
			entry.tools.every((tool: unknown) => typeof tool === "string") &&
			"memory" in entry &&
			(entry.memory === "none" || entry.memory === "notes") &&
			"persona" in entry &&
			typeof entry.persona === "string" &&
			"executor" in entry &&
			(entry.executor === "session" || entry.executor === "harness") &&
			"permissionPolicy" in entry &&
			(entry.permissionPolicy === "read-only" || entry.permissionPolicy === "workspace-write") &&
			(!("model" in entry) ||
				entry.model === undefined ||
				(typeof entry.model === "object" &&
					entry.model !== null &&
					"provider" in entry.model &&
					typeof entry.model.provider === "string" &&
					"id" in entry.model &&
					typeof entry.model.id === "string")) &&
			"schedules" in entry &&
			Array.isArray(entry.schedules),
	);
}

async function loadExternalConnections(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/external-connections.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load external connections: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isExternalConnectionList(payload)) throw new Error("External connection catalog returned an invalid response");
	externalConnections = payload.connections;
	refreshRoutineEditorOptions();
	externalConnectionList.replaceChildren(
		...externalConnections.map((connection) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "nav-item external-connection-entry";
			button.classList.toggle("active", connection.id === selectedExternalConnectionId);
			button.disabled = !connection.available;
			const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			icon.classList.add("external-connection-icon");
			icon.dataset.provider = connection.id;
			icon.setAttribute("viewBox", "0 0 24 24");
			icon.setAttribute("aria-hidden", "true");
			const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
			use.setAttribute(
				"href",
				connection.id === "claude-code"
					? "#external-icon-anthropic"
					: connection.id === "openai"
						? "#external-icon-openai"
						: connection.id === "hermes"
							? "#external-icon-hermes"
							: "#external-icon-pi",
			);
			icon.append(use);
			const copy = document.createElement("div");
			copy.className = "external-connection-copy";
			const name = document.createElement("strong");
			name.textContent = connection.name;
			const state = document.createElement("span");
			state.className = "muted";
			state.textContent = connection.available
				? `${connection.defaultModel.provider}/${connection.defaultModel.id}`
				: "Unavailable";
			copy.append(name, state);
			button.append(icon, copy);
			button.title = connection.description;
			button.addEventListener("click", () => openExternalConnection(connection));
			return button;
		}),
	);
}

function isExternalConnectionList(value: unknown): value is { connections: ExternalConnectionSummary[] } {
	if (typeof value !== "object" || value === null || !("connections" in value) || !Array.isArray(value.connections)) {
		return false;
	}
	return value.connections.every(
		(connection) =>
			typeof connection === "object" &&
			connection !== null &&
			"id" in connection &&
			typeof connection.id === "string" &&
			"name" in connection &&
			typeof connection.name === "string" &&
			"description" in connection &&
			typeof connection.description === "string" &&
			"inputLabel" in connection &&
			(connection.inputLabel === "Task" || connection.inputLabel === "Goal") &&
			"available" in connection &&
			typeof connection.available === "boolean" &&
			"models" in connection &&
			Array.isArray(connection.models),
	);
}

function openExternalConnection(connection: ExternalConnectionSummary): void {
	selectedExternalConnectionId = connection.id;
	requiredElement<HTMLInputElement>("external-id").value = connection.id;
	element("external-title").textContent = connection.name;
	element("external-description").textContent = connection.description;
	element("external-warning").textContent = connection.warning ?? "";
	element("external-prompt-label").childNodes[0].textContent = connection.inputLabel;
	requiredElement<HTMLTextAreaElement>("external-prompt").placeholder =
		`${connection.inputLabel} for ${connection.name}`;
	requiredElement<HTMLInputElement>("external-cwd").value = session?.snapshot?.cwd ?? "";
	externalModel.replaceChildren(
		...connection.models.map((entry) => {
			const option = document.createElement("option");
			option.value = `${entry.provider}/${entry.id}`;
			option.textContent = `${entry.provider} / ${entry.name}`;
			return option;
		}),
	);
	externalModel.value = `${connection.defaultModel.provider}/${connection.defaultModel.id}`;
	externalModelPicker.refresh();
	document.querySelector<HTMLElement>('[data-tab="external"]')?.classList.remove("hidden");
	activateTab("external");
	void loadExternalConnections().catch(() => {});
	void loadExternalRuns().catch(() => {});
}

function activateTab(id: string): void {
	document.querySelectorAll("[data-tab]").forEach((entry) => {
		entry.classList.toggle("active", entry.getAttribute("data-tab") === id);
	});
	document.querySelectorAll("[data-panel]").forEach((entry) => {
		entry.classList.toggle("hidden", entry.id !== id);
	});
}

function activateRailTab(id: string): void {
	document.querySelectorAll("[data-rail-tab]").forEach((entry) => {
		entry.classList.toggle("active", entry.getAttribute("data-rail-tab") === id);
	});
	document.querySelectorAll("[data-rail-panel]").forEach((entry) => {
		entry.classList.toggle("hidden", entry.id !== id);
	});
}

function activateBuilderTab(id: string): void {
	document.querySelectorAll("[data-builder-tab]").forEach((entry) => {
		entry.classList.toggle("active", entry.getAttribute("data-builder-tab") === id);
	});
	document.querySelectorAll("[data-builder-panel]").forEach((entry) => {
		entry.classList.toggle("hidden", entry.id !== id);
	});
}

function resizeComposer(): void {
	input.style.height = "0";
	input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function installPanelResizer(
	id: string,
	property: "--rail-width" | "--details-width",
	storageKey: string,
	direction: 1 | -1,
	minimum: number,
	maximum: number,
): void {
	const resizer = element(id);
	const currentWidth = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(property));
	const setWidth = (value: number) => {
		const width = Math.max(minimum, Math.min(maximum, value));
		document.documentElement.style.setProperty(property, `${width}px`);
		resizer.setAttribute("aria-valuenow", String(Math.round(width)));
		return width;
	};
	const stored = Number(localStorage.getItem(storageKey));
	if (Number.isFinite(stored) && stored >= minimum && stored <= maximum) {
		setWidth(stored);
	}
	resizer.setAttribute("aria-valuemin", String(minimum));
	resizer.setAttribute("aria-valuemax", String(maximum));
	resizer.setAttribute("aria-valuenow", String(Math.round(currentWidth())));
	resizer.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const keyboardDirection = event.key === "ArrowRight" ? 1 : -1;
		const width = setWidth(currentWidth() + keyboardDirection * direction * 12);
		localStorage.setItem(storageKey, String(Math.round(width)));
	});
	resizer.addEventListener("pointerdown", (event) => {
		const pointer = event as PointerEvent;
		const startX = pointer.clientX;
		const current = currentWidth();
		resizer.classList.add("dragging");
		resizer.setPointerCapture(pointer.pointerId);
		const move = (moveEvent: PointerEvent) => {
			setWidth(current + (moveEvent.clientX - startX) * direction);
		};
		const finish = () => {
			resizer.classList.remove("dragging");
			resizer.removeEventListener("pointermove", move);
			resizer.removeEventListener("pointerup", finish);
			resizer.removeEventListener("pointercancel", finish);
			const width = currentWidth();
			localStorage.setItem(storageKey, String(Math.round(width)));
		};
		resizer.addEventListener("pointermove", move);
		resizer.addEventListener("pointerup", finish);
		resizer.addEventListener("pointercancel", finish);
	});
}

async function openAgent(agent?: AgentSummary): Promise<void> {
	activeSidebarAgent = agent;
	agentForm.reset();
	const catalogAgent = agent?.source === "pi-agent";
	for (const control of agentForm.querySelectorAll<
		HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement
	>("input, textarea, select, button")) {
		control.disabled = catalogAgent;
	}
	requiredElement<HTMLInputElement>("agent-id").value = agent?.id ?? "";
	requiredElement<HTMLInputElement>("agent-name").value = agent?.name ?? "";
	requiredElement<HTMLTextAreaElement>("agent-description").value = agent?.description ?? "";
	requiredElement<HTMLTextAreaElement>("agent-persona").value = agent?.persona ?? "";
	requiredElement<HTMLInputElement>("agent-tools").value = agent?.tools.join(", ") ?? "";
	requiredElement<HTMLSelectElement>("agent-memory").value = agent?.memory ?? "none";
	requiredElement<HTMLSelectElement>("agent-executor").value = agent?.executor ?? "harness";
	requiredElement<HTMLSelectElement>("agent-permissions").value = agent?.permissionPolicy ?? "read-only";
	requiredElement<HTMLSelectElement>("agent-browser-access").value = agent?.browser?.access ?? "disabled";
	agentModel.value = agent?.model ? `${agent.model.provider}/${agent.model.id}` : "";
	agentModelPicker.refresh();
	element("builder-title").textContent = agent
		? catalogAgent
			? `${agent.name} · Pi agent catalog`
			: agent.name
		: "Build a new agent";
	const configureTab = document.querySelector<HTMLElement>('[data-tab="configure"]');
	if (configureTab) configureTab.textContent = agent ? "Agent" : "Builder";
	builderPrompt.placeholder = agent ? `Message ${agent.name}…` : "Describe the agent you want to build";
	builderChatForm.classList.toggle("agent-chat-composer", agent !== undefined);
	builderSubmit.textContent = agent ? "↑" : "Ask builder";
	builderSubmit.setAttribute("aria-label", agent ? `Send message to ${agent.name}` : "Ask builder");
	activateTab("configure");
	activateBuilderTab("builder-chat-panel");
	unsubscribeBuilder?.();
	await builderSession?.dispose().catch(() => {});
	builderChat.replaceChildren();
	if (!client) return;
	builderSession = await client.createSession({ name: agent ? `agent:${agent.id}` : "builder:new" });
	unsubscribeBuilder = builderSession.subscribe((snapshot) => {
		builderChat.replaceChildren(...snapshot.transcript.map(renderItem));
		builderChat.scrollTop = builderChat.scrollHeight;
		const busy = snapshot.phase !== "idle";
		builderPrompt.disabled = busy;
		builderSubmit.classList.toggle("is-stopping", busy && activeSidebarAgent !== undefined);
		builderSubmit.textContent = activeSidebarAgent ? (busy ? "■" : "↑") : "Ask builder";
		builderSubmit.setAttribute(
			"aria-label",
			activeSidebarAgent ? (busy ? "Stop response" : `Send message to ${agent?.name ?? "agent"}`) : "Ask builder",
		);
	});
}

interface RunSummary {
	id: string;
	agentId: string;
	prompt: string;
	status: string;
	createdAt: number;
	error?: string;
}

async function loadRuns(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/runs.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load runs: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isRunList(payload)) throw new Error("Run manager returned an invalid response");
	runList.replaceChildren(
		...payload.runs.map((run) => {
			const card = document.createElement("div");
			card.className = "card run-card";
			appendText(card, `${run.agentId} · ${run.status}`);
			appendText(card, run.prompt, "muted");
			if (run.error) appendText(card, run.error, "run-error");
			if (run.status === "succeeded" && capabilityToken) {
				const result = document.createElement("a");
				result.href = `/runs/${encodeURIComponent(run.id)}/result?token=${encodeURIComponent(capabilityToken)}`;
				result.target = "_blank";
				result.rel = "noreferrer";
				result.textContent = "Open result";
				card.append(result);
			}
			if (run.status === "starting" || run.status === "running") {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = "Abort";
				button.addEventListener("click", () => void abortRun(run.id));
				card.append(button);
			}
			return card;
		}),
	);
}

function isRunList(value: unknown): value is { runs: RunSummary[] } {
	if (typeof value !== "object" || value === null || !("runs" in value) || !Array.isArray(value.runs)) return false;
	return value.runs.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"agentId" in entry &&
			typeof entry.agentId === "string" &&
			"prompt" in entry &&
			typeof entry.prompt === "string" &&
			"status" in entry &&
			typeof entry.status === "string" &&
			"createdAt" in entry &&
			typeof entry.createdAt === "number" &&
			(!("error" in entry) || entry.error === undefined || typeof entry.error === "string"),
	);
}

async function abortRun(runId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/runs/${encodeURIComponent(runId)}/abort?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
		},
	);
	if (!response.ok) throw new Error(`Could not abort run: HTTP ${response.status}`);
	await loadRuns();
}

async function loadExternalRuns(): Promise<void> {
	if (!capabilityToken || !selectedExternalConnectionId) return;
	const response = await fetch(`/external-runs.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load external runs: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isExternalRunList(payload)) throw new Error("External run manager returned an invalid response");
	const runs = payload.runs.filter((run) => run.connectionId === selectedExternalConnectionId);
	externalRunList.replaceChildren(
		...runs.map((run) => {
			const card = document.createElement("div");
			card.className = "card run-card";
			appendText(card, `${run.status} · ${run.model.provider}/${run.model.id}`);
			appendText(card, run.prompt, "muted");
			if (run.error) appendText(card, run.error, "run-error");
			const actions = document.createElement("div");
			actions.className = "result-actions";
			if (run.status === "starting" || run.status === "running") {
				const abort = document.createElement("button");
				abort.type = "button";
				abort.className = "abort";
				abort.textContent = "Stop";
				abort.addEventListener("click", () => void abortExternalRun(run.id));
				actions.append(abort);
			}
			if (run.status === "succeeded") {
				const open = document.createElement("button");
				open.type = "button";
				open.textContent = "View result";
				open.addEventListener("click", () => void showExternalResult(run, card));
				const use = document.createElement("button");
				use.type = "button";
				use.textContent = "Send to Pi";
				use.addEventListener("click", () => void sendExternalResultToPi(run));
				actions.append(open, use);
			}
			if (actions.childElementCount > 0) card.append(actions);
			return card;
		}),
	);
}

function isExternalRunList(value: unknown): value is { runs: ExternalRunSummary[] } {
	if (typeof value !== "object" || value === null || !("runs" in value) || !Array.isArray(value.runs)) return false;
	return value.runs.every(
		(run) =>
			typeof run === "object" &&
			run !== null &&
			"id" in run &&
			typeof run.id === "string" &&
			"connectionId" in run &&
			typeof run.connectionId === "string" &&
			"prompt" in run &&
			typeof run.prompt === "string" &&
			"cwd" in run &&
			typeof run.cwd === "string" &&
			"model" in run &&
			typeof run.model === "object" &&
			run.model !== null &&
			"provider" in run.model &&
			typeof run.model.provider === "string" &&
			"id" in run.model &&
			typeof run.model.id === "string" &&
			"status" in run &&
			typeof run.status === "string" &&
			"createdAt" in run &&
			typeof run.createdAt === "number",
	);
}

async function externalResult(runId: string): Promise<string> {
	if (!capabilityToken) throw new Error("The capability token is missing");
	const response = await fetch(
		`/external-runs/${encodeURIComponent(runId)}/result?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(`Could not load delegated result: HTTP ${response.status}`);
	return response.text();
}

async function showExternalResult(run: ExternalRunSummary, card: HTMLElement): Promise<void> {
	try {
		const existing = card.querySelector(".external-result");
		if (existing) {
			existing.remove();
			return;
		}
		const result = document.createElement("div");
		result.className = "external-result";
		result.textContent = await externalResult(run.id);
		card.append(result);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	}
}

async function sendExternalResultToPi(run: ExternalRunSummary): Promise<void> {
	if (!session) return;
	if (session.snapshot?.phase !== "idle") {
		setStatus("Wait for the current Pi turn to finish before importing a delegated result", true);
		return;
	}
	try {
		const result = await externalResult(run.id);
		await session.prompt(
			`Delegated result from ${run.connectionId} for task "${run.prompt}":\n\n${result}\n\nUse this returned data in our current work.`,
		);
		setStatus(`Sent ${run.connectionId} result to Pi`);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	}
}

async function abortExternalRun(runId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/external-runs/${encodeURIComponent(runId)}/abort?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST" },
	);
	if (!response.ok) throw new Error(`Could not stop delegated run: HTTP ${response.status}`);
	await loadExternalRuns();
}

interface RoutineSummary {
	id: string;
	name: string;
	prompt: string;
	enabled: boolean;
	intervalMinutes: number;
	target:
		| { kind: "agent"; agentId: string }
		| { kind: "acp"; connectionId: string }
		| { kind: "skill"; skillName: string };
	model?: { provider: string; id: string };
	cwd?: string;
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunId?: string;
	activeRunId?: string;
	lastError?: string;
}

let routines: RoutineSummary[] = [];

function routineTargetLabel(routine: RoutineSummary): string {
	switch (routine.target.kind) {
		case "agent": {
			const agentId = routine.target.agentId;
			return `Agent · ${agents.find((agent) => agent.id === agentId)?.name ?? agentId}`;
		}
		case "acp": {
			const connectionId = routine.target.connectionId;
			return `ACP · ${externalConnections.find((entry) => entry.id === connectionId)?.name ?? connectionId}`;
		}
		case "skill":
			return `Skill · $${routine.target.skillName}`;
	}
}

function refreshRoutineEditorOptions(): void {
	const selectedAgent = routineEditor.agent.value;
	const selectedAcp = routineEditor.acp.value;
	routineEditor.agent.replaceChildren(
		...agents.map((entry) => {
			const option = document.createElement("option");
			option.value = entry.id;
			option.textContent = entry.name;
			return option;
		}),
	);
	if (agents.some((entry) => entry.id === selectedAgent)) routineEditor.agent.value = selectedAgent;
	routineEditor.acp.replaceChildren(
		...externalConnections.map((entry) => {
			const option = document.createElement("option");
			option.value = entry.id;
			option.textContent = entry.name;
			option.disabled = !entry.available;
			return option;
		}),
	);
	if (externalConnections.some((entry) => entry.id === selectedAcp)) routineEditor.acp.value = selectedAcp;
	refreshRoutineModels();
}

function refreshRoutineModels(selected = routineEditor.model.value): void {
	const inherit = document.createElement("option");
	inherit.value = "";
	inherit.textContent = "Use target default";
	const targetModels =
		routineEditor.targetKind.value === "acp"
			? (externalConnections.find((entry) => entry.id === routineEditor.acp.value)?.models ?? [])
			: availableModels;
	routineEditor.model.replaceChildren(
		inherit,
		...targetModels.map((entry) => {
			const option = document.createElement("option");
			option.value = `${entry.provider}/${entry.id}`;
			option.textContent = `${entry.provider} / ${entry.name}`;
			return option;
		}),
	);
	if ([...routineEditor.model.options].some((option) => option.value === selected)) {
		routineEditor.model.value = selected;
	}
	routineModelPicker.refresh();
}

function updateRoutineTargetFields(): void {
	const kind = routineEditor.targetKind.value;
	routineEditor.agentLabel.classList.toggle("hidden", kind !== "agent");
	routineEditor.acpLabel.classList.toggle("hidden", kind !== "acp");
	routineEditor.skillLabel.classList.toggle("hidden", kind !== "skill");
	routineEditor.cwdLabel.classList.toggle("hidden", kind === "agent");
	refreshRoutineModels("");
}

function clearRoutineEditor(): void {
	routineEditor.form.reset();
	routineEditor.id.value = "";
	routineEditor.interval.value = "60";
	routineEditor.deleteButton.disabled = true;
	routineEditor.runButton.disabled = true;
	element("routine-editor-title").textContent = "New routine";
	routineList.querySelectorAll(".routine-card").forEach((card) => {
		card.classList.remove("active");
	});
	updateRoutineTargetFields();
}

function editRoutine(routine: RoutineSummary): void {
	routineEditor.id.value = routine.id;
	routineEditor.name.value = routine.name;
	routineEditor.prompt.value = routine.prompt;
	routineEditor.enabled.checked = routine.enabled;
	routineEditor.interval.value = String(routine.intervalMinutes);
	routineEditor.targetKind.value = routine.target.kind;
	if (routine.target.kind === "agent") routineEditor.agent.value = routine.target.agentId;
	else if (routine.target.kind === "acp") routineEditor.acp.value = routine.target.connectionId;
	else routineEditor.skill.value = routine.target.skillName;
	routineEditor.cwd.value = routine.cwd ?? session?.snapshot?.cwd ?? "";
	updateRoutineTargetFields();
	routineEditor.model.value = routine.model ? `${routine.model.provider}/${routine.model.id}` : "";
	routineModelPicker.refresh();
	routineEditor.deleteButton.disabled = false;
	routineEditor.runButton.disabled = routine.activeRunId !== undefined;
	element("routine-editor-title").textContent = routine.name;
	routineList.querySelectorAll<HTMLElement>(".routine-card").forEach((card) => {
		card.classList.toggle("active", card.dataset.routineId === routine.id);
	});
}

async function loadRoutines(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/routines.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) return;
	const payload: unknown = await response.json();
	if (!isRoutineList(payload)) throw new Error("Routine service returned an invalid response");
	routines = payload.routines;
	routineList.replaceChildren(
		...payload.routines.map((routine) => {
			const card = document.createElement("div");
			card.className = "card routine-card";
			card.dataset.routineId = routine.id;
			const state = document.createElement("div");
			state.className = "routine-state";
			appendText(state, routine.name);
			appendText(state, routine.activeRunId ? "Running" : routine.enabled ? "Active" : "Paused", "routine-target");
			card.append(state);
			appendText(card, routineTargetLabel(routine), "routine-target");
			appendText(
				card,
				routine.nextRunAt
					? `Every ${routine.intervalMinutes} minutes · next ${new Date(routine.nextRunAt).toLocaleString()}`
					: `Every ${routine.intervalMinutes} minutes`,
				"muted",
			);
			appendText(card, routine.prompt, "muted");
			if (routine.lastError) appendText(card, routine.lastError, "run-error");
			card.addEventListener("click", () => editRoutine(routine));
			return card;
		}),
	);
	const selected = routines.find((routine) => routine.id === routineEditor.id.value);
	if (selected) editRoutine(selected);
}

function isRoutineList(value: unknown): value is { routines: RoutineSummary[] } {
	if (typeof value !== "object" || value === null || !("routines" in value) || !Array.isArray(value.routines)) {
		return false;
	}
	return value.routines.every((entry) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("id" in entry) ||
			typeof entry.id !== "string" ||
			!("name" in entry) ||
			typeof entry.name !== "string" ||
			!("prompt" in entry) ||
			typeof entry.prompt !== "string" ||
			!("enabled" in entry) ||
			typeof entry.enabled !== "boolean" ||
			!("intervalMinutes" in entry) ||
			typeof entry.intervalMinutes !== "number" ||
			!("target" in entry) ||
			typeof entry.target !== "object" ||
			entry.target === null ||
			!("kind" in entry.target)
		) {
			return false;
		}
		return entry.target.kind === "agent" || entry.target.kind === "acp" || entry.target.kind === "skill";
	});
}

async function reconnect(entry: ConnectionEntry): Promise<void> {
	if (reconnecting.has(entry.id)) return;
	reconnecting.add(entry.id);
	const activeSessionId = activeTargetKey?.startsWith(`${entry.id}:`) ? session?.id : undefined;
	setStatus("Disconnected. Reconnecting…", true);
	while (!entry.client.disposed) {
		await new Promise((resolve) => window.setTimeout(resolve, 1000));
		try {
			await entry.client.reconnect();
			await refreshSessionTargets();
			const target = sessionTargets().find(
				(candidate) => candidate.connectionId === entry.id && candidate.session.id === activeSessionId,
			);
			if (target) {
				activeTargetKey = undefined;
				await switchSession(target);
			}
			setStatus(`Reconnected to ${entry.label}`);
			reconnecting.delete(entry.id);
			return;
		} catch {
			// Retry until this local Pi process returns or the connection is removed.
		}
	}
	reconnecting.delete(entry.id);
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	void submitComposer().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});

async function submitComposer(): Promise<void> {
	if (!session) return;
	if (session.snapshot?.phase !== "idle") {
		await session.abort();
		return;
	}
	const text = input.value.trim();
	const attachments = [...activeAttachments()];
	if (!text && attachments.length === 0) return;
	if (attachments.length > 0) {
		if (!activeConnectionIsPrimary()) throw new Error("Attachments require a session hosted by this Pi console");
		const response = await fetch(`/session-prompts?token=${encodeURIComponent(capabilityToken ?? "")}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: session.id, text, attachmentIds: attachments.map((entry) => entry.id) }),
		});
		if (!response.ok) throw new Error(await responseError(response, "Could not send attachment prompt"));
		attachmentsBySession.set(session.id, []);
		renderAttachments();
	} else {
		await session.prompt(text);
	}
	input.value = "";
	resizeComposer();
}

input.addEventListener("input", resizeComposer);
attachmentButton.addEventListener("click", () => attachmentInput.click());
attachmentInput.addEventListener("change", () => {
	const files = [...(attachmentInput.files ?? [])];
	attachmentInput.value = "";
	if (files.length === 0) return;
	void uploadFiles(files).catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
previewForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const url = previewAddress.value.trim();
	if (!url) return;
	void navigatePreview(url).catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewReload.addEventListener("click", () => {
	void previewAction("reload").catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewBack.addEventListener("click", () => {
	void previewAction("back").catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewForward.addEventListener("click", () => {
	void previewAction("forward").catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewControl.addEventListener("click", () => {
	void setPreviewControl(activePreviewSession?.controlOwner === "user" ? "agent" : "user").catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewTypeForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = previewType.value;
	if (!text) return;
	void sendPreviewInput({ kind: "type", text })
		.then(() => {
			previewType.value = "";
		})
		.catch((error: unknown) => setPreviewMessage(error instanceof Error ? error.message : String(error), true));
});
previewImage.addEventListener("click", (event) => {
	if (activePreviewSession?.controlOwner !== "user") return;
	const bounds = previewImage.getBoundingClientRect();
	if (bounds.width === 0 || bounds.height === 0) return;
	const x = ((event.clientX - bounds.left) / bounds.width) * activePreviewSession.viewport.width;
	const y = ((event.clientY - bounds.top) / bounds.height) * activePreviewSession.viewport.height;
	void sendPreviewInput({ kind: "click", x, y }).catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewImage.addEventListener(
	"wheel",
	(event) => {
		if (activePreviewSession?.controlOwner !== "user") return;
		event.preventDefault();
		void sendPreviewInput({ kind: "scroll", deltaX: event.deltaX, deltaY: event.deltaY }).catch((error: unknown) =>
			setPreviewMessage(error instanceof Error ? error.message : String(error), true),
		);
	},
	{ passive: false },
);
input.addEventListener("paste", (event) => {
	const files = [...(event.clipboardData?.files ?? [])];
	if (files.length > 0) {
		event.preventDefault();
		void uploadFiles(files).catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		);
		return;
	}
	const text = event.clipboardData?.getData("text/plain") ?? "";
	if (text.length <= 12_000 && text.split(/\r?\n/).length <= 200) return;
	event.preventDefault();
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	void uploadFiles([new File([text], `paste-${timestamp}.md`, { type: "text/markdown" })]).catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
form.addEventListener("dragover", (event) => {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	form.classList.add("composer-drop");
});
form.addEventListener("dragleave", () => form.classList.remove("composer-drop"));
form.addEventListener("drop", (event) => {
	form.classList.remove("composer-drop");
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	event.preventDefault();
	void uploadFiles(files).catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
input.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing || session?.snapshot?.phase !== "idle") return;
	event.preventDefault();
	form.requestSubmit();
});

model.addEventListener("change", () => {
	if (!session) return;
	const separator = model.value.indexOf("/");
	if (separator < 1) return;
	void session
		.setModel({ provider: model.value.slice(0, separator), id: model.value.slice(separator + 1) })
		.catch((error: unknown) => setStatus(String(error), true));
});

thinking.addEventListener("change", () => {
	if (session)
		void session
			.setThinking(thinking.value as ThinkingLevel)
			.catch((error: unknown) => setStatus(String(error), true));
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
	button.addEventListener("click", () => {
		const tab = button.dataset.tab ?? "overview";
		activateTab(tab);
		if (tab === "capabilities") {
			void loadCapabilities().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		}
		if (tab === "preview") {
			void loadPreview().catch((error: unknown) =>
				setPreviewMessage(error instanceof Error ? error.message : String(error), true),
			);
		}
	});
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-rail-tab]")) {
	button.addEventListener("click", () => {
		const tab = button.dataset.railTab ?? "sessions";
		activateRailTab(tab);
		if (tab === "agents") {
			void loadExternalConnections().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		}
	});
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-builder-tab]")) {
	button.addEventListener("click", () => activateBuilderTab(button.dataset.builderTab ?? "builder-chat-panel"));
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preview-tab]")) {
	button.addEventListener("click", () => {
		const tab = button.dataset.previewTab ?? "page";
		document.querySelectorAll("[data-preview-tab]").forEach((entry) => {
			entry.classList.toggle("active", entry.getAttribute("data-preview-tab") === tab);
		});
		document.querySelectorAll("[data-preview-panel]").forEach((entry) => {
			entry.classList.toggle("hidden", entry.getAttribute("data-preview-panel") !== tab);
		});
		if (tab !== "page") {
			void loadPreviewDiagnostics().catch((error: unknown) =>
				setPreviewMessage(error instanceof Error ? error.message : String(error), true),
			);
		}
	});
}

newAgent.addEventListener("click", () => {
	activateRailTab("agents");
	void openAgent();
});

showConnectionForm.addEventListener("click", () => {
	connectionForm.classList.toggle("hidden");
	if (!connectionForm.classList.contains("hidden")) connectionUrl.focus();
});

connectionForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const controlUrl = connectionUrl.value.trim();
	if (!controlUrl) return;
	void addConnection(controlUrl)
		.then(async (entry) => {
			connectionForm.reset();
			connectionForm.classList.add("hidden");
			const target = sessionTargets().find((candidate) => candidate.connectionId === entry.id);
			if (target) await switchSession(target);
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

agentForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const id = requiredElement<HTMLInputElement>("agent-id").value;
	const value = (field: string) =>
		requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(field).value;
	const selectedModel = value("agent-model");
	const modelSeparator = selectedModel.indexOf("/");
	const definition = {
		name: value("agent-name"),
		description: value("agent-description"),
		tools: value("agent-tools")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
		memory: value("agent-memory"),
		persona: value("agent-persona"),
		executor: value("agent-executor"),
		permissionPolicy: value("agent-permissions"),
		browser: {
			access: value("agent-browser-access"),
			profile: { kind: "ephemeral" },
		},
		model:
			modelSeparator > 0
				? {
						provider: selectedModel.slice(0, modelSeparator),
						id: selectedModel.slice(modelSeparator + 1),
					}
				: undefined,
		schedules: activeSidebarAgent?.schedules ?? [],
	};
	const path = id ? `/agents/${encodeURIComponent(id)}` : "/agents";
	void fetch(`${path}?token=${encodeURIComponent(capabilityToken)}`, {
		method: id ? "PUT" : "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(definition),
	})
		.then(async (response) => {
			if (!response.ok) {
				const payload: unknown = await response.json();
				throw new Error(
					typeof payload === "object" &&
						payload !== null &&
						"error" in payload &&
						typeof payload.error === "string"
						? payload.error
						: `HTTP ${response.status}`,
				);
			}
			await loadAgents();
			await loadRoutines();
			agentForm.reset();
			setStatus("Agent definition saved");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

builderChatForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (activeSidebarAgent && builderSession?.snapshot && builderSession.snapshot.phase !== "idle") {
		void builderSession.abort().catch((error: unknown) => {
			setStatus(error instanceof Error ? error.message : String(error), true);
		});
		return;
	}
	const prompt = builderPrompt.value.trim();
	const chatSession = builderSession;
	if (!prompt || !chatSession) return;
	builderPrompt.value = "";
	const message = activeSidebarAgent
		? prompt
		: [
				`You are helping configure a local Pi agent. Ask concise questions and recommend values for the visible form.`,
				`Current name: ${requiredElement<HTMLInputElement>("agent-name").value || "not set"}`,
				`Current description: ${requiredElement<HTMLTextAreaElement>("agent-description").value || "not set"}`,
				`Current persona: ${requiredElement<HTMLTextAreaElement>("agent-persona").value || "not set"}`,
				`User: ${prompt}`,
			].join("\n");
	void chatSession.prompt(message).catch((error: unknown) => {
		setStatus(error instanceof Error ? error.message : String(error), true);
	});
});

runForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const prompt = requiredElement<HTMLTextAreaElement>("run-prompt").value.trim();
	if (!runAgent.value || !prompt) return;
	void fetch(`/runs?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agentId: runAgent.value, prompt }),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(`Could not start run: HTTP ${response.status}`);
			requiredElement<HTMLTextAreaElement>("run-prompt").value = "";
			activateTab("activity");
			await loadRuns();
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

externalRunForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const connectionId = requiredElement<HTMLInputElement>("external-id").value;
	const prompt = requiredElement<HTMLTextAreaElement>("external-prompt").value.trim();
	const cwd = requiredElement<HTMLInputElement>("external-cwd").value.trim();
	const separator = externalModel.value.indexOf("/");
	if (!connectionId || !prompt || !cwd || separator < 1) return;
	void fetch(`/external-runs?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			connectionId,
			prompt,
			cwd,
			model: { provider: externalModel.value.slice(0, separator), id: externalModel.value.slice(separator + 1) },
		}),
	})
		.then(async (response) => {
			if (!response.ok) {
				const payload: unknown = await response.json();
				throw new Error(
					typeof payload === "object" &&
						payload !== null &&
						"error" in payload &&
						typeof payload.error === "string"
						? payload.error
						: `Could not start delegated run: HTTP ${response.status}`,
				);
			}
			requiredElement<HTMLTextAreaElement>("external-prompt").value = "";
			await loadExternalRuns();
			setStatus(`Delegated to ${connectionId}`);
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

routineEditor.targetKind.addEventListener("change", updateRoutineTargetFields);
routineEditor.acp.addEventListener("change", () => refreshRoutineModels(""));
routineEditor.clearButton.addEventListener("click", clearRoutineEditor);

routineEditor.form.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const kind = routineEditor.targetKind.value;
	const target =
		kind === "agent"
			? { kind: "agent" as const, agentId: routineEditor.agent.value }
			: kind === "acp"
				? { kind: "acp" as const, connectionId: routineEditor.acp.value }
				: { kind: "skill" as const, skillName: routineEditor.skill.value.trim() };
	const separator = routineEditor.model.value.indexOf("/");
	const definition = {
		name: routineEditor.name.value,
		prompt: routineEditor.prompt.value,
		enabled: routineEditor.enabled.checked,
		intervalMinutes: Number(routineEditor.interval.value),
		target,
		model:
			separator > 0
				? {
						provider: routineEditor.model.value.slice(0, separator),
						id: routineEditor.model.value.slice(separator + 1),
					}
				: undefined,
		cwd: kind === "agent" ? undefined : routineEditor.cwd.value.trim() || undefined,
	};
	const id = routineEditor.id.value;
	void fetch(
		`${id ? `/routines/${encodeURIComponent(id)}` : "/routines"}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: id ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(definition),
		},
	)
		.then(async (response) => {
			if (!response.ok) {
				const payload: unknown = await response.json();
				throw new Error(
					typeof payload === "object" &&
						payload !== null &&
						"error" in payload &&
						typeof payload.error === "string"
						? payload.error
						: `Could not save routine: HTTP ${response.status}`,
				);
			}
			const saved: unknown = await response.json();
			await loadRoutines();
			if (typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string") {
				const routine = routines.find((entry) => entry.id === saved.id);
				if (routine) editRoutine(routine);
			}
			setStatus("Routine saved");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

routineEditor.runButton.addEventListener("click", () => {
	if (!capabilityToken || !routineEditor.id.value) return;
	void fetch(
		`/routines/${encodeURIComponent(routineEditor.id.value)}/run?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST" },
	)
		.then(async (response) => {
			if (!response.ok) throw new Error(`Could not start routine: HTTP ${response.status}`);
			await loadRoutines();
			setStatus("Routine started");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

routineEditor.deleteButton.addEventListener("click", () => {
	const id = routineEditor.id.value;
	if (!capabilityToken || !id || !window.confirm(`Delete routine "${routineEditor.name.value}"?`)) return;
	void fetch(`/routines/${encodeURIComponent(id)}?token=${encodeURIComponent(capabilityToken)}`, { method: "DELETE" })
		.then(async (response) => {
			if (!response.ok) throw new Error(`Could not delete routine: HTTP ${response.status}`);
			clearRoutineEditor();
			await loadRoutines();
			setStatus("Routine deleted");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

window.setInterval(() => {
	void loadRuns().catch(() => {});
	void loadRoutines().catch(() => {});
	void loadExternalRuns().catch(() => {});
	if (document.querySelector('[data-tab="preview"]')?.classList.contains("active")) void loadPreview().catch(() => {});
}, 1500);
void loadRuns().catch(() => {});

installPanelResizer("left-resizer", "--rail-width", "pi-serve-rail-width", 1, 190, 420);
installPanelResizer("right-resizer", "--details-width", "pi-serve-details-width", -1, 280, 560);
for (const id of ["routine-id", "routine-interval", "routine-prompt", "routine-enabled"]) {
	document.getElementById(id)?.closest("label")?.remove();
}
for (const heading of agentForm.querySelectorAll<HTMLElement>(".section-title")) {
	if (heading.textContent === "Optional routine") heading.remove();
}
resizeComposer();
clearRoutineEditor();
void connect().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
