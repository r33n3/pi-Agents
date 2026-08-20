import { PiClient, type PiSessionHandle, type Unsubscribe } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	SessionMetadata,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { createBrowserWebSocketTransport } from "./websocket-transport.ts";

const status = element("status");
const transcript = element("transcript");
const form = requiredElement<HTMLFormElement>("composer");
const input = requiredElement<HTMLTextAreaElement>("prompt");
const send = requiredElement<HTMLButtonElement>("composer-action");
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
const builderChat = element("builder-chat");
const builderChatForm = requiredElement<HTMLFormElement>("builder-chat-form");
const builderPrompt = requiredElement<HTMLTextAreaElement>("builder-prompt");
const sessionTabs = element("session-tabs");
const connectionList = element("connection-list");
const connectionForm = requiredElement<HTMLFormElement>("connection-form");
const connectionUrl = requiredElement<HTMLInputElement>("connection-url");
const showConnectionForm = requiredElement<HTMLButtonElement>("show-connection-form");
const externalConnectionList = element("external-connection-list");
const externalRunForm = requiredElement<HTMLFormElement>("external-run-form");
const externalRunList = element("external-run-list");
const externalModel = requiredElement<HTMLSelectElement>("external-model");
const capabilityToken = new URL(location.href).searchParams.get("token");

let client: PiClient | undefined;
let session: PiSessionHandle | undefined;
let unsubscribeSession: Unsubscribe | undefined;
let builderSession: PiSessionHandle | undefined;
let unsubscribeBuilder: Unsubscribe | undefined;
let activeTargetKey: string | undefined;
let selectedExternalConnectionId: string | undefined;

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
}

function render(snapshot: SessionSnapshot): void {
	const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	const previousScrollTop = transcript.scrollTop;
	transcript.replaceChildren(...snapshot.transcript.map(renderItem));
	setBusy(snapshot);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
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
	const options = models.map((entry) => {
		const option = document.createElement("option");
		option.value = `${entry.provider}/${entry.id}`;
		option.textContent = `${entry.provider} / ${entry.name}`;
		return option;
	});
	model.replaceChildren(...options);
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
			.filter((metadata) => !metadata.sessionName?.startsWith("builder:"))
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
	setStatus(`Connected to ${entry.label}`);
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
		loadExternalConnections().catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		),
	]);
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
	schedules: Array<{ id: string; prompt: string; intervalMinutes: number; enabled: boolean }>;
}

async function loadAgents(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/agents.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load agents: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isAgentList(payload)) throw new Error("Agent registry returned an invalid response");
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
	externalConnectionList.replaceChildren(
		...externalConnections.map((connection) => {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "nav-item external-connection-entry";
			button.classList.toggle("active", connection.id === selectedExternalConnectionId);
			button.disabled = !connection.available;
			const name = document.createElement("strong");
			name.textContent = connection.name;
			const state = document.createElement("span");
			state.className = "muted";
			state.textContent = connection.available
				? `${connection.defaultModel.provider}/${connection.defaultModel.id}`
				: "Unavailable";
			button.append(name, state);
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
	agentModel.value = agent?.model ? `${agent.model.provider}/${agent.model.id}` : "";
	const routine = agent?.schedules[0];
	requiredElement<HTMLInputElement>("routine-id").value = routine?.id ?? "routine";
	requiredElement<HTMLInputElement>("routine-interval").value = String(routine?.intervalMinutes ?? 60);
	requiredElement<HTMLTextAreaElement>("routine-prompt").value = routine?.prompt ?? "";
	requiredElement<HTMLInputElement>("routine-enabled").checked = routine?.enabled ?? false;
	element("builder-title").textContent = agent
		? catalogAgent
			? `${agent.name} · Pi agent catalog`
			: `Configure ${agent.name}`
		: "Build a new agent";
	activateTab("configure");
	activateBuilderTab("builder-chat-panel");
	unsubscribeBuilder?.();
	await builderSession?.dispose().catch(() => {});
	builderChat.replaceChildren();
	if (!client) return;
	builderSession = await client.createSession({ name: `builder:${agent?.id ?? "new"}` });
	unsubscribeBuilder = builderSession.subscribe((snapshot) => {
		builderChat.replaceChildren(...snapshot.transcript.map(renderItem));
		builderChat.scrollTop = builderChat.scrollHeight;
		builderPrompt.disabled = snapshot.phase !== "idle";
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
	agentId: string;
	routineId: string;
	prompt: string;
	intervalMinutes: number;
	nextRunAt: number;
	lastError?: string;
}

async function loadRoutines(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/routines.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) return;
	const payload: unknown = await response.json();
	if (!isRoutineList(payload)) return;
	routineList.replaceChildren(
		...payload.routines.map((routine) => {
			const card = document.createElement("div");
			card.className = "card";
			appendText(card, `${routine.agentId} · ${routine.routineId}`);
			appendText(
				card,
				`Every ${routine.intervalMinutes} minutes · next ${new Date(routine.nextRunAt).toLocaleString()}`,
				"muted",
			);
			appendText(card, routine.prompt, "muted");
			if (routine.lastError) appendText(card, routine.lastError, "run-error");
			return card;
		}),
	);
}

function isRoutineList(value: unknown): value is { routines: RoutineSummary[] } {
	if (typeof value !== "object" || value === null || !("routines" in value) || !Array.isArray(value.routines)) {
		return false;
	}
	return value.routines.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"agentId" in entry &&
			typeof entry.agentId === "string" &&
			"routineId" in entry &&
			typeof entry.routineId === "string" &&
			"prompt" in entry &&
			typeof entry.prompt === "string" &&
			"intervalMinutes" in entry &&
			typeof entry.intervalMinutes === "number" &&
			"nextRunAt" in entry &&
			typeof entry.nextRunAt === "number" &&
			(!("lastError" in entry) || entry.lastError === undefined || typeof entry.lastError === "string"),
	);
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
	if (!session) return;
	if (session.snapshot?.phase !== "idle") {
		void session.abort().catch((error: unknown) => setStatus(String(error), true));
		return;
	}
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	resizeComposer();
	void session
		.prompt(text)
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

input.addEventListener("input", resizeComposer);
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
		activateTab(button.dataset.tab ?? "overview");
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
		model:
			modelSeparator > 0
				? {
						provider: selectedModel.slice(0, modelSeparator),
						id: selectedModel.slice(modelSeparator + 1),
					}
				: undefined,
		schedules: value("routine-prompt").trim()
			? [
					{
						id: value("routine-id"),
						prompt: value("routine-prompt"),
						intervalMinutes: Number(value("routine-interval")),
						enabled: requiredElement<HTMLInputElement>("routine-enabled").checked,
					},
				]
			: [],
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
	const prompt = builderPrompt.value.trim();
	if (!prompt || !builderSession) return;
	builderPrompt.value = "";
	const formContext = [
		`You are helping configure a local Pi agent. Ask concise questions and recommend values for the visible form.`,
		`Current name: ${requiredElement<HTMLInputElement>("agent-name").value || "not set"}`,
		`Current description: ${requiredElement<HTMLTextAreaElement>("agent-description").value || "not set"}`,
		`Current persona: ${requiredElement<HTMLTextAreaElement>("agent-persona").value || "not set"}`,
		`User: ${prompt}`,
	].join("\n");
	void builderSession.prompt(formContext).catch((error: unknown) => {
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

window.setInterval(() => {
	void loadRuns().catch(() => {});
	void loadRoutines().catch(() => {});
	void loadExternalRuns().catch(() => {});
}, 1500);
void loadRuns().catch(() => {});

installPanelResizer("left-resizer", "--rail-width", "pi-serve-rail-width", 1, 190, 420);
installPanelResizer("right-resizer", "--details-width", "pi-serve-details-width", -1, 280, 560);
resizeComposer();
void connect().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
