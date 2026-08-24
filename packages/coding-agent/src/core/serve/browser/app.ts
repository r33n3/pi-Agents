import { PiClient, type PiSessionHandle, type Unsubscribe } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	SessionMetadata,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { createBrowserId } from "./browser-id.ts";
import { installThemedSelect } from "./themed-select.ts";
import { selectTranscriptWindow } from "./transcript-window.ts";
import { createBrowserWebSocketTransport } from "./websocket-transport.ts";

const pageUrl = new URL(location.href);
const capabilityToken = pageUrl.searchParams.get("token");
const browserPopoutMode = pageUrl.searchParams.get("browserPopout") === "1";
const requestedPreviewSessionId = pageUrl.searchParams.get("browserSession") ?? undefined;
const recommendedAgentModel = { provider: "openai", id: "gpt-5.6-luna" } as const;
document.body.classList.toggle("browser-popout", browserPopoutMode);
if (browserPopoutMode) document.title = "Pi Browser";

const status = element("status");
const sessionPath = element("session-path");
const sessionStats = element("session-stats");
const transcript = element("transcript");
const form = requiredElement<HTMLFormElement>("composer");
const input = requiredElement<HTMLTextAreaElement>("prompt");
const send = requiredElement<HTMLButtonElement>("composer-action");
const mobilePanelNone = requiredElement<HTMLInputElement>("mobile-panel-none");
const attachmentInput = requiredElement<HTMLInputElement>("attachment-input");
const attachmentButton = requiredElement<HTMLButtonElement>("attachment-button");
const attachmentList = element("attachment-list");
attachmentInput.classList.remove("hidden");
attachmentInput.classList.add("file-picker-input");
const model = requiredElement<HTMLSelectElement>("model");
const agentModel = requiredElement<HTMLSelectElement>("agent-model");
const thinking = requiredElement<HTMLSelectElement>("thinking");
const phase = element("phase");
const agentList = element("agent-list");
const newAgent = requiredElement<HTMLButtonElement>("new-agent");
const agentForm = requiredElement<HTMLFormElement>("agent-form");
const selectedAgentPanel = element("selected-agent");
const selectedAgentTitle = element("selected-agent-title");
const selectedAgentMeta = element("selected-agent-meta");
const agentTaskList = element("agent-task-list");
const routineList = element("routine-list");
const routineEditor = createRoutineEditor();
const workflowList = element("workflow-list");
const workflowEditor = createWorkflowEditor();
const personaSelect = requiredElement<HTMLSelectElement>("agent-persona-select");
const personaImage = requiredElement<HTMLImageElement>("agent-persona-image");
const pluginForm = requiredElement<HTMLFormElement>("plugin-form");
const capabilityConnectionForm = requiredElement<HTMLFormElement>("capability-connection-form");
const capabilityConnectionList = element("capability-connection-list");
const capabilityApprovalList = element("capability-approval-list");
const inboundRouteForm = requiredElement<HTMLFormElement>("inbound-route-form");
const inboundRouteList = element("inbound-route-list");
const siteMonitorForm = requiredElement<HTMLFormElement>("site-monitor-form");
const siteMonitorList = element("site-monitor-list");
const financeWatchlistForm = requiredElement<HTMLFormElement>("finance-watchlist-form");
const financeWatchlistList = element("finance-watchlist-list");
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
const previewFrame = (() => {
	const value = previewImage.closest<HTMLElement>(".preview-frame");
	if (!value) throw new Error("Missing browser preview frame");
	return value;
})();
const { tabs: previewSessionTabs, popout: previewPopout } = installPreviewBrowserChrome();
const { record: previewRecord, send: previewSendRecording, status: previewRecordingStatus } = createPreviewRecorder();
const browserWorkflowList = createBrowserWorkflowReviewPanel();
const browserProfileList = createBrowserProfilePanel();
const agentBrowserWorkflowGrants = createAgentBrowserWorkflowGrants();
installAgentBuilderToolsLayout(agentBrowserWorkflowGrants);
const modelPicker = installThemedSelect(model);
const agentModelPicker = installThemedSelect(agentModel);
const externalModelPicker = installThemedSelect(externalModel);
const routineModelPicker = installThemedSelect(routineEditor.model);

let client: PiClient | undefined;
let session: PiSessionHandle | undefined;
let unsubscribeSession: Unsubscribe | undefined;
let builderSession: PiSessionHandle | undefined;
let unsubscribeBuilder: Unsubscribe | undefined;
let builderActive = false;
let builderLabel = "Agent Builder";
let activeSidebarAgent: AgentSummary | undefined;
let activeTargetKey: string | undefined;
let activeAgentId: string | undefined;
let activeSubagentKey: string | undefined;
const openAgentIds: string[] = [];
const openSubagentKeys: string[] = [];
const subagentActivityByKey = new Map<string, SubagentActivity>();
const agentConversationIds = new Map<string, string>();
const agentTasksByAgent = new Map<string, AgentTaskSummary[]>();
let activePreviewSessionId: string | undefined;
let activePreviewSession: BrowserSessionSummary | undefined;
let selectedPreviewSessionId = requestedPreviewSessionId;
let previewStream: WebSocket | undefined;
let previewStreamSessionId: string | undefined;
let previewFrameUrl: string | undefined;
let previewRefreshPromise: Promise<void> | undefined;
let previewRefreshRequested = false;
let cachedBrowserStatus: BrowserConsoleStatus | undefined;
let periodicRefreshPromise: Promise<void> | undefined;
let previewCapture: BrowserCaptureSummary | undefined;
let recordedBrowserWorkflows: BrowserWorkflowSummary[] = [];
let browserWorkflowRuns: BrowserWorkflowRunSummary[] = [];
let lastBrowserWorkflowLoadAt = 0;
const browserWorkflowReviews = new Map<string, BrowserWorkflowReview>();
let selectedExternalConnectionId: string | undefined;
let availableModels: ModelMetadata[] = [];
let agentModelsInitialized = false;
let agents: AgentSummary[] = [];
let personas: PersonaSummary[] = [];
let agentEvents: EventSource | undefined;
let capabilitySearchTimer: number | undefined;
let capabilityConnections: CapabilityConnectionSummary[] = [];
let capabilitySnapshot: CapabilitySnapshot["broker"] | undefined;
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
	plugins: CapabilityEntry[];
	mcpServers: CapabilityEntry[];
	acpConnections: CapabilityEntry[];
	modelProviders: CapabilityEntry[];
	broker: {
		capabilities: BrokeredCapability[];
		providers: CapabilityProvider[];
	};
}

interface AgentCapabilityGrant {
	capabilityId: string;
	capabilityVersion: number;
	providerId?: string;
	approval?: "never" | "per-run" | "always";
	connectionId?: string;
}

interface BrokeredCapability {
	id: string;
	version: number;
	name: string;
	description: string;
	category: string;
	effect: "read" | "write" | "execute" | "external-side-effect";
	defaultApproval: "never" | "per-run" | "always";
	defaultProviderId?: string;
	providers: string[];
	status: "active" | "available" | "unavailable";
}

interface CapabilityProvider {
	id: string;
	name: string;
	source: string;
	version: string;
	trust: "unreviewed" | "quarantined" | "reviewed" | "enabled";
	enabled: boolean;
	health: "ready" | "degraded" | "missing-tools" | "passive";
	missingTools: string[];
	permissions: string[];
	connectionRequired?: boolean;
}

interface CapabilityConnectionSummary {
	id: string;
	providerId: string;
	accountLabel: string;
	secretRef: string;
	scopes: string[];
	capabilityIds: string[];
	status: "active" | "unhealthy" | "revoked";
}

interface CapabilityApprovalSummary {
	id: string;
	capabilityId: string;
	providerId: string;
	connectionId: string;
	action: string;
	target: string;
	expiresAt: string;
	state: "approved" | "started" | "completed" | "failed";
}

interface InboundRouteSummary {
	id: string;
	connectionId: string;
	destination: { kind: "agent" | "session" | "coordinator"; id: string };
	allowedSenders: string[];
	maxEventsPerMinute: number;
	enabled: boolean;
}

interface SiteMonitorSummary {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
}

interface FinanceWatchlistSummary {
	id: string;
	name: string;
	symbols: string[];
	providerId?: string;
	connectionId?: string;
	enabled: boolean;
}

interface PersonaSummary {
	id: string;
	name: string;
	category: string;
	description: string;
	instructions: string;
	image?: string;
}

interface AgentTaskSummary {
	id: string;
	conversationId: string;
	agentId: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	prompt: string;
	createdAt: number;
	result?: string;
	error?: string;
}

interface AgentMessageSummary {
	id: string;
	conversationId: string;
	role: "user" | "agent";
	text: string;
	taskId: string;
	createdAt: number;
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
	installedChrome: boolean;
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
	runtime: "managed-chromium" | "installed-chrome";
	viewport: { width: number; height: number; deviceScaleFactor: number };
	canGoBack: boolean;
	canGoForward: boolean;
}

interface BrowserCaptureSummary {
	id: string;
	sessionId: string;
	status: "recording" | "stopped" | "interrupted";
	steps: Array<{
		action: {
			kind: "navigate" | "back" | "forward" | "reload" | "click" | "type" | "scroll";
			url?: string;
			target?: { role: string; name: string; label?: string; testId?: string; id?: string };
			textLength?: number;
			sensitive?: boolean;
		};
	}>;
}

interface BrowserWorkflowSummary {
	id: string;
	version: number;
	name: string;
	status: "draft" | "needs-input" | "compiled" | "validated" | "active" | "superseded" | "invalid" | "disabled";
	source: { kind: "recording" | "manual"; captureId?: string };
	parameters: Array<{
		name: string;
		description: string;
		type: "string" | "number" | "boolean" | "url" | "choice" | "secret-ref";
		required: boolean;
		sensitive: boolean;
		choices?: string[];
	}>;
	compileIssues: Array<{ stepId: string; code: string; message: string }>;
	policy: { deadlineMs: number; approval: "inherit" | "always" };
}

interface BrowserWorkflowReview {
	workflow: BrowserWorkflowSummary;
	issues: Array<{
		stepId: string;
		code: string;
		message: string;
		candidates: Array<{ index: number; role: string; name: string; label?: string; testId?: string; id?: string }>;
	}>;
}

interface BrowserWorkflowRunSummary {
	id: string;
	kind: "validation" | "execution";
	workflowId: string;
	workflowVersion: number;
	status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
	startedAt: number;
	error?: string;
	steps: Array<{
		stepId: string;
		status: "completed" | "failed";
		url?: string;
		error?: string;
		artifacts: Array<{ id: string; kind: "screenshot"; size: number; phase: "before" | "after" | "failure" }>;
	}>;
}

interface BrowserProfileSummary {
	id: string;
	createdAt: number;
	updatedAt: number;
}

let externalConnections: ExternalConnectionSummary[] = [];

const connections = new Map<string, ConnectionEntry>();
const reconnecting = new Set<string>();
const sessionAliases = readSessionAliases();
const expandedThinking = new Map<string, boolean>();
const thinkingCollapseTimers = new Map<string, number>();
const streamingThinking = new Set<string>();
const expandedToolActivity = new Map<string, boolean>();
const promptHistoryBySession = new Map<string, PromptHistory>();
const MAX_PROMPT_HISTORY = 5;
const transcriptVisibleCountBySession = new Map<string, number>();
const TRANSCRIPT_WINDOW_SIZE = 80;

interface PromptHistory {
	entries: string[];
	index: number;
	draft: string;
}

interface SubagentActivity {
	key: string;
	sessionId: string;
	item: Extract<TranscriptItem, { role: "tool" }>;
}

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
	return (
		sessionAliases[target.key] ?? target.session.sessionName ?? sessionFolderName(target.session.cwd) ?? "Pi session"
	);
}

function sessionFolderName(cwd: string | undefined): string | undefined {
	const normalized = cwd?.replace(/[\\/]+$/, "");
	const folder = normalized?.split(/[\\/]/).at(-1);
	if (!folder) return undefined;
	return folder.length > 6 ? `${folder.slice(0, 6)}…` : folder;
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

function installPreviewBrowserChrome(): { tabs: HTMLElement; popout: HTMLButtonElement } {
	const tabs = document.querySelector<HTMLElement>(".preview-tabs");
	if (!tabs) throw new Error("Missing browser session tabs");
	tabs.className = "browser-session-tabs";
	tabs.setAttribute("aria-label", "Active browsers");
	tabs.replaceChildren();
	for (const kind of ["console", "network"]) {
		document.querySelector(`[data-preview-panel="${kind}"]`)?.remove();
	}
	previewForm.className = "browser-toolbar";
	const navigation = document.createElement("div");
	navigation.className = "browser-nav-actions";
	setBrowserAction(previewBack, "back", "Back", "Go back");
	setBrowserAction(previewForward, "forward", "Forward", "Go forward");
	setBrowserAction(previewReload, "reload", "Reload", "Reload page");
	navigation.append(previewBack, previewForward, previewReload);
	const omnibox = document.createElement("div");
	omnibox.className = "browser-omnibox";
	const security = document.createElement("span");
	security.className = "browser-address-icon";
	security.textContent = "◎";
	security.title = "Managed browser address";
	const go = document.createElement("button");
	go.type = "submit";
	setBrowserAction(go, "go", "Go", "Open address");
	omnibox.append(security, previewAddress, go);
	previewForm.replaceChildren(navigation, omnibox);
	previewFrame.tabIndex = 0;
	previewFrame.setAttribute("aria-label", "Interactive managed browser viewport");
	setBrowserAction(previewControl, "human", "Take control", "Take control from the agent");
	const title = document.querySelector<HTMLElement>(".preview-card > strong");
	if (!title) throw new Error("Missing browser preview title");
	const heading = document.createElement("div");
	heading.className = "browser-window-heading";
	const label = document.createElement("strong");
	label.textContent = "Browser";
	const popout = document.createElement("button");
	popout.id = "preview-popout";
	popout.type = "button";
	setBrowserAction(
		popout,
		browserPopoutMode ? "close" : "popout",
		browserPopoutMode ? "Close browser window" : "Pop out browser",
		browserPopoutMode ? "Close browser window" : "Open this browser session in its own window",
	);
	heading.append(label, popout);
	title.replaceWith(heading);
	return { tabs, popout };
}

type BrowserActionIcon =
	| "back"
	| "forward"
	| "reload"
	| "go"
	| "human"
	| "agent"
	| "record"
	| "stop"
	| "pi-send"
	| "popout"
	| "close";

function setBrowserAction(
	button: HTMLButtonElement,
	iconKind: BrowserActionIcon,
	labelText: string,
	tooltip: string,
): void {
	const icon = browserActionIcon(iconKind);
	const label = document.createElement("span");
	label.className = "browser-action-label hidden";
	label.textContent = labelText;
	button.replaceChildren(icon, label);
	button.dataset.browserIcon = iconKind;
	button.title = tooltip;
	button.setAttribute("aria-label", labelText);
}

function browserActionIcon(kind: BrowserActionIcon): SVGSVGElement {
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.classList.add("browser-action-icon");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	const pathData: Partial<Record<BrowserActionIcon, string>> = {
		back: "M15 18l-6-6 6-6",
		forward: "m9 18 6-6-6-6",
		reload: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
		go: "M5 12h13m-5-5 5 5-5 5",
		human: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c.8-4 3.1-6 7-6s6.2 2 7 6",
		agent: "M5 12h14M12 5v14m-6.5-3.5 13-7",
		stop: "M7 7h10v10H7z",
		popout: "M14 4h6v6m0-6-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6",
		close: "M6 6l12 12M18 6 6 18",
	};
	if (kind === "record") {
		const outer = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		outer.setAttribute("cx", "12");
		outer.setAttribute("cy", "12");
		outer.setAttribute("r", "8");
		const inner = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		inner.setAttribute("class", "browser-action-icon-fill");
		inner.setAttribute("cx", "12");
		inner.setAttribute("cy", "12");
		inner.setAttribute("r", "3.5");
		icon.append(outer, inner);
		return icon;
	}
	if (kind === "pi-send") {
		const pi = document.createElementNS("http://www.w3.org/2000/svg", "text");
		pi.setAttribute("x", "3");
		pi.setAttribute("y", "18");
		pi.setAttribute("class", "browser-action-pi");
		pi.textContent = "π";
		const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
		arrow.setAttribute("d", "M14 15 21 8m-5 0h5v5");
		icon.append(pi, arrow);
		return icon;
	}
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", pathData[kind] ?? "");
	icon.append(path);
	return icon;
}

function createPreviewRecorder(): {
	record: HTMLButtonElement;
	send: HTMLButtonElement;
	status: HTMLSpanElement;
} {
	const actions = document.createElement("div");
	actions.className = "browser-utility-actions";
	const record = document.createElement("button");
	record.id = "preview-record";
	record.type = "button";
	record.disabled = true;
	setBrowserAction(record, "record", "Record", "Record a browser walkthrough");
	record.setAttribute("aria-pressed", "false");
	const send = document.createElement("button");
	send.id = "preview-send-recording";
	send.type = "button";
	send.disabled = true;
	setBrowserAction(send, "pi-send", "Send to Pi", "Send recorded steps to the selected Pi session");
	actions.append(previewControl, record, send);
	previewForm.append(actions);
	const status = document.createElement("span");
	status.id = "preview-recording-status";
	status.className = "preview-recording-status";
	actions.after(status);
	return { record, send, status };
}

function createBrowserWorkflowReviewPanel(): HTMLElement {
	const browserPanel = element("browser");
	const section = document.createElement("section");
	section.className = "browser-workflow-section";
	const heading = document.createElement("div");
	heading.className = "browser-workflow-heading";
	const title = document.createElement("strong");
	title.textContent = "Recorded workflows";
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.title = "Refresh recorded workflows";
	refresh.setAttribute("aria-label", "Refresh recorded workflows");
	refresh.textContent = "↻";
	refresh.addEventListener("click", () => {
		void loadBrowserWorkflows(true).catch((error: unknown) =>
			setPreviewMessage(error instanceof Error ? error.message : String(error), true),
		);
	});
	heading.append(title, refresh);
	const list = document.createElement("div");
	list.className = "browser-workflow-list";
	section.append(heading, list);
	browserPanel.append(section);
	return list;
}

function createAgentBrowserWorkflowGrants(): HTMLElement {
	const capabilityList = element("capability-list");
	const details = document.createElement("details");
	details.className = "capability-section";
	const summary = document.createElement("summary");
	const title = document.createElement("strong");
	title.textContent = "Browser workflows";
	summary.append(title);
	const input = document.createElement("input");
	input.id = "agent-browser-workflows";
	input.type = "hidden";
	input.setAttribute("form", "agent-form");
	const list = document.createElement("div");
	list.className = "agent-browser-workflow-grants";
	details.append(summary, input, list);
	capabilityList.after(details);
	return list;
}

function installAgentBuilderToolsLayout(browserWorkflowGrants: HTMLElement): void {
	const panel = element("builder-tools-panel");
	const capabilityList = element("capability-list");
	const pluginSection = pluginForm.closest("details");
	const browserWorkflowSection = browserWorkflowGrants.closest("details");
	if (!pluginSection || !browserWorkflowSection) throw new Error("Agent Builder tool sections are incomplete");
	const stack = document.createElement("div");
	stack.className = "builder-settings-stack";
	stack.append(
		builderSettingsGroup(
			"Runtime",
			"Choose the model and reasoning depth.",
			[fieldLabel("agent-model"), fieldLabel("agent-thinking")],
			true,
		),
		builderSettingsGroup(
			"Execution",
			"Control isolation and file access.",
			[fieldLabel("agent-executor"), fieldLabel("agent-permissions")],
			false,
		),
		builderSettingsGroup(
			"Browser",
			"Configure web access, profiles, and recorded workflows.",
			[
				fieldLabel("agent-browser-access"),
				fieldLabel("agent-browser-runtime"),
				fieldLabel("agent-browser-profile-kind"),
				fieldLabel("agent-browser-profile-id"),
				browserWorkflowSection,
			],
			false,
		),
		builderSettingsGroup(
			"Capabilities",
			"Grant only the tools this agent needs.",
			[capabilityList],
			true,
			"agent-capability-summary",
		),
		builderSettingsGroup("Plugins", "Install and manage optional capability packages.", [pluginSection], false),
	);
	panel.prepend(stack);
}

function builderSettingsGroup(
	title: string,
	description: string,
	contents: HTMLElement[],
	open: boolean,
	statusId?: string,
): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "builder-settings-group";
	details.open = open;
	const summary = document.createElement("summary");
	const copy = document.createElement("span");
	copy.className = "builder-settings-summary-copy";
	appendText(copy, title, "builder-settings-title");
	appendText(copy, description, "builder-settings-description");
	summary.append(copy);
	if (statusId) {
		const status = document.createElement("span");
		status.id = statusId;
		status.className = "builder-settings-status";
		status.textContent = "0 selected";
		summary.append(status);
	}
	const body = document.createElement("div");
	body.className = "builder-settings-body";
	const grid = document.createElement("div");
	grid.className = "builder-settings-grid";
	grid.append(...contents);
	body.append(grid);
	details.append(summary, body);
	return details;
}

function fieldLabel(id: string): HTMLLabelElement {
	const label = requiredElement<HTMLElement>(id).closest("label");
	if (!(label instanceof HTMLLabelElement)) throw new Error(`Agent Builder field ${id} is missing its label`);
	return label;
}

function createBrowserProfilePanel(): HTMLElement {
	const browserPanel = element("browser");
	const details = document.createElement("details");
	details.className = "card browser-profiles";
	const summary = document.createElement("summary");
	summary.textContent = "Named browser profiles";
	summary.title = "Dedicated Pi sign-in profiles; one live session may use each profile";
	const list = document.createElement("div");
	details.append(summary, list);
	browserPanel.append(details);
	details.addEventListener("toggle", () => {
		if (details.open) void loadBrowserProfiles().catch((error: unknown) => setPreviewMessage(String(error), true));
	});
	return list;
}

async function loadBrowserProfiles(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/browser/profiles?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser profiles"));
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null || !("profiles" in value) || !Array.isArray(value.profiles)) {
		throw new Error("Browser profile response is invalid");
	}
	const profiles = value.profiles.filter(
		(entry): entry is BrowserProfileSummary =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"createdAt" in entry &&
			typeof entry.createdAt === "number" &&
			"updatedAt" in entry &&
			typeof entry.updatedAt === "number",
	);
	browserProfileList.replaceChildren(
		...profiles.map((profile) => {
			const row = document.createElement("div");
			row.className = "browser-profile-row";
			const name = document.createElement("span");
			name.textContent = profile.id;
			name.title = `Last updated ${new Date(profile.updatedAt).toLocaleString()}`;
			const clear = document.createElement("button");
			clear.type = "button";
			clear.textContent = "×";
			clear.title = `Clear sign-in data for ${profile.id}`;
			clear.setAttribute("aria-label", clear.title);
			clear.addEventListener("click", () => {
				if (!window.confirm(`Clear the dedicated browser profile "${profile.id}"?`)) return;
				void clearBrowserProfile(profile.id).catch((error: unknown) => setPreviewMessage(String(error), true));
			});
			row.append(name, clear);
			return row;
		}),
	);
}

async function clearBrowserProfile(id: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/browser/profiles/${encodeURIComponent(id)}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "DELETE",
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not clear browser profile"));
	await loadBrowserProfiles();
	setPreviewMessage(`Cleared browser profile ${id}`);
}

function renderAgentBrowserWorkflowGrants(): void {
	const selected = new Set(
		requiredElement<HTMLInputElement>("agent-browser-workflows")
			.value.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
	agentBrowserWorkflowGrants.replaceChildren(
		...recordedBrowserWorkflows
			.filter((workflow) => workflow.status === "active")
			.map((workflow) => {
				const label = document.createElement("label");
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				const reference = `${workflow.id}@${workflow.version}`;
				checkbox.checked = selected.has(reference);
				checkbox.disabled = activeSidebarAgent?.source === "pi-agent";
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) selected.add(reference);
					else selected.delete(reference);
					requiredElement<HTMLInputElement>("agent-browser-workflows").value = [...selected].sort().join(",");
					if (selected.size > 0) {
						requiredElement<HTMLSelectElement>("agent-browser-access").value = "loopback";
						updateAgentToolGrant("browser", true);
					}
				});
				label.append(checkbox, `${workflow.name} · v${workflow.version}`);
				return label;
			}),
	);
}

function updateAgentBrowserProfileFields(): void {
	const kind = requiredElement<HTMLSelectElement>("agent-browser-profile-kind").value;
	const label = element("agent-browser-profile-id-label");
	const input = requiredElement<HTMLInputElement>("agent-browser-profile-id");
	label.classList.toggle("hidden", kind !== "named");
	input.required = kind === "named";
}

function createRoutineEditor(): {
	form: HTMLFormElement;
	id: HTMLInputElement;
	name: HTMLInputElement;
	targetKind: HTMLSelectElement;
	agent: HTMLSelectElement;
	workflow: HTMLSelectElement;
	browserWorkflow: HTMLSelectElement;
	browserParameters: HTMLTextAreaElement;
	acp: HTMLSelectElement;
	skill: HTMLInputElement;
	prompt: HTMLTextAreaElement;
	cwd: HTMLInputElement;
	model: HTMLSelectElement;
	preset: HTMLSelectElement;
	time: HTMLInputElement;
	cron: HTMLInputElement;
	timezone: HTMLInputElement;
	maxDuration: HTMLInputElement;
	preview: HTMLDivElement;
	enabled: HTMLInputElement;
	agentLabel: HTMLLabelElement;
	workflowLabel: HTMLLabelElement;
	browserWorkflowLabel: HTMLLabelElement;
	browserParametersLabel: HTMLLabelElement;
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
		["workflow", "Workflow"],
		["browser-workflow", "Browser workflow"],
		["acp", "ACP target"],
		["skill", "Skill"],
	] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		targetKind.append(option);
	}
	const agent = document.createElement("select");
	const workflow = document.createElement("select");
	const browserWorkflow = document.createElement("select");
	const browserParameters = document.createElement("textarea");
	browserParameters.value = "{}";
	browserParameters.placeholder = '{ "projectId": "example" }';
	const acp = document.createElement("select");
	const skill = document.createElement("input");
	skill.placeholder = "skill-name";
	const prompt = document.createElement("textarea");
	prompt.required = true;
	const cwd = document.createElement("input");
	const model = document.createElement("select");
	const preset = document.createElement("select");
	for (const [value, text] of [
		["weekdays", "Weekdays"],
		["daily", "Every day"],
		["hourly", "Every hour"],
		["weekly", "Every week"],
		["custom", "Advanced cron"],
	] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = text;
		preset.append(option);
	}
	const time = document.createElement("input");
	time.type = "time";
	time.value = "09:00";
	const cron = document.createElement("input");
	cron.value = "0 9 * * 1-5";
	cron.required = true;
	const timezone = document.createElement("input");
	timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
	timezone.required = true;
	const maxDuration = document.createElement("input");
	maxDuration.type = "number";
	maxDuration.min = "1";
	maxDuration.value = "60";
	maxDuration.required = true;
	const enabled = document.createElement("input");
	enabled.type = "checkbox";
	const preview = document.createElement("div");
	preview.className = "muted routine-preview";
	const label = (text: string, control: HTMLElement) => {
		const wrapper = document.createElement("label");
		wrapper.append(text, control);
		return wrapper;
	};
	const agentLabel = label("Agent", agent);
	const workflowLabel = label("Workflow", workflow);
	const browserWorkflowLabel = label("Browser workflow", browserWorkflow);
	const browserParametersLabel = label("Parameters (JSON)", browserParameters);
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
		workflowLabel,
		browserWorkflowLabel,
		browserParametersLabel,
		acpLabel,
		skillLabel,
		label("Instructions", prompt),
		cwdLabel,
		label("Model", model),
		label("Schedule", preset),
		label("Start time", time),
		label("Cron schedule", cron),
		label("Timezone", timezone),
		label("Maximum duration (minutes)", maxDuration),
		enabledLabel,
		preview,
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
		workflow,
		browserWorkflow,
		browserParameters,
		acp,
		skill,
		prompt,
		cwd,
		model,
		preset,
		time,
		cron,
		timezone,
		maxDuration,
		preview,
		enabled,
		agentLabel,
		workflowLabel,
		browserWorkflowLabel,
		browserParametersLabel,
		acpLabel,
		skillLabel,
		cwdLabel,
		deleteButton,
		runButton,
		clearButton,
	};
}

function createWorkflowEditor(): {
	form: HTMLFormElement;
	id: HTMLInputElement;
	name: HTMLInputElement;
	pattern: HTMLSelectElement;
	nodes: HTMLTextAreaElement;
	edges: HTMLTextAreaElement;
	supervisor: HTMLSelectElement;
	maxConcurrency: HTMLInputElement;
	maxDepth: HTMLInputElement;
	failurePolicy: HTMLSelectElement;
	runPrompt: HTMLTextAreaElement;
	deleteButton: HTMLButtonElement;
	runButton: HTMLButtonElement;
	clearButton: HTMLButtonElement;
} {
	const panel = element("workflows");
	const card = document.createElement("details");
	card.className = "card workflow-editor";
	const summary = document.createElement("summary");
	summary.id = "workflow-editor-title";
	summary.textContent = "New workflow";
	const form = document.createElement("form");
	form.id = "workflow-editor";
	const id = document.createElement("input");
	id.type = "hidden";
	const name = document.createElement("input");
	name.required = true;
	const pattern = document.createElement("select");
	for (const value of ["sequential", "parallel", "supervisor"] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value[0]?.toUpperCase() + value.slice(1);
		pattern.append(option);
	}
	const nodes = document.createElement("textarea");
	nodes.required = true;
	nodes.placeholder = '[{"id":"research","agentId":"researcher","prompt":"Research the goal"}]';
	const edges = document.createElement("textarea");
	edges.placeholder = '[{"from":"research","to":"review"}]';
	const supervisor = document.createElement("select");
	const maxConcurrency = document.createElement("input");
	maxConcurrency.type = "number";
	maxConcurrency.min = "1";
	maxConcurrency.max = "16";
	maxConcurrency.value = "4";
	const maxDepth = document.createElement("input");
	maxDepth.type = "number";
	maxDepth.min = "1";
	maxDepth.max = "8";
	maxDepth.value = "4";
	const failurePolicy = document.createElement("select");
	for (const value of ["stop", "continue", "supervisor-decides"] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value;
		failurePolicy.append(option);
	}
	const runPrompt = document.createElement("textarea");
	runPrompt.placeholder = "Goal for this run";
	const label = (text: string, control: HTMLElement) => {
		const wrapper = document.createElement("label");
		wrapper.append(text, control);
		return wrapper;
	};
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
		label("Pattern", pattern),
		label("Agent steps (JSON)", nodes),
		label("Dependencies (JSON)", edges),
		label("Supervisor", supervisor),
		label("Maximum parallel tasks", maxConcurrency),
		label("Maximum delegation depth", maxDepth),
		label("Failure policy", failurePolicy),
		label("Run goal", runPrompt),
		actions,
	);
	card.append(summary, form);
	panel.insertBefore(card, workflowList);
	return {
		form,
		id,
		name,
		pattern,
		nodes,
		edges,
		supervisor,
		maxConcurrency,
		maxDepth,
		failurePolicy,
		runPrompt,
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
	send.disabled = false;
	phase.textContent = snapshot.phase;
	send.classList.toggle("is-stopping", busy);
	send.setAttribute("aria-label", busy ? "Stop response" : "Send message");
	model.disabled = busy;
	thinking.disabled = busy;
	attachmentButton.disabled = busy || !activeConnectionIsPrimary();
	attachmentInput.disabled = busy || !activeConnectionIsPrimary();
	renderPreviewRecording();
}

function render(snapshot: SessionSnapshot): void {
	projectSubagentActivity(snapshot);
	if (activeSubagentKey) {
		const activity = subagentActivityByKey.get(activeSubagentKey);
		if (activity) renderSubagentInspector(activity);
		else closeSubagentTab(activeSubagentKey);
		return;
	}
	if (builderActive) return;
	if (activeAgentId) return;
	const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	const previousScrollTop = transcript.scrollTop;
	const window = selectTranscriptWindow(
		snapshot.transcript,
		transcriptVisibleCountBySession.get(snapshot.id) ?? TRANSCRIPT_WINDOW_SIZE,
		TRANSCRIPT_WINDOW_SIZE,
	);
	const earlier =
		window.hiddenCount > 0 ? renderEarlierMessages(snapshot, window.hiddenCount, window.visibleCount) : [];
	transcript.replaceChildren(...earlier, ...window.items.map(renderItem));
	setBusy(snapshot);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
	modelPicker.refresh();
	thinking.value = snapshot.thinkingLevel;
	input.disabled = false;
	input.placeholder = "Message Pi…";
	input.setAttribute("aria-label", "Message Pi");
	sessionPath.textContent = formatWorkingDirectory(snapshot.cwd);
	sessionPath.title = snapshot.cwd;
	renderSessionStats(snapshot);
	transcript.scrollTop = nearBottom ? transcript.scrollHeight : previousScrollTop;
}

function renderBuilderConversation(snapshot: SessionSnapshot): void {
	if (!builderActive) return;
	const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	transcript.replaceChildren(...snapshot.transcript.map(renderItem));
	setBusy(snapshot);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
	modelPicker.refresh();
	thinking.value = snapshot.thinkingLevel;
	input.disabled = false;
	input.placeholder = `Message ${builderLabel}…`;
	input.setAttribute("aria-label", `Message ${builderLabel}`);
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	attachmentButton.title = "Agent Builder attachments are not available yet";
	attachmentList.replaceChildren();
	const projectRoot = requiredElement<HTMLInputElement>("agent-project-root").value;
	sessionPath.textContent = projectRoot ? formatWorkingDirectory(projectRoot) : "Agent Builder";
	sessionPath.title = projectRoot;
	renderSessionStats(snapshot);
	setStatus(projectRoot || "Configure and deploy a local agent");
	if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
}

function renderEarlierMessages(
	snapshot: SessionSnapshot,
	hiddenCount: number,
	visibleCount: number,
): [HTMLButtonElement] {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "transcript-earlier";
	button.textContent = `Show ${Math.min(hiddenCount, TRANSCRIPT_WINDOW_SIZE)} earlier messages`;
	button.title = `${hiddenCount} earlier messages are retained in this session`;
	button.addEventListener("click", () => {
		transcriptVisibleCountBySession.set(snapshot.id, visibleCount + TRANSCRIPT_WINDOW_SIZE);
		render(snapshot);
	});
	return [button];
}

function renderSessionStats(snapshot: SessionSnapshot): void {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let latestAssistantUsage: Extract<TranscriptItem, { role: "assistant" }>["usage"];
	for (const item of snapshot.transcript) {
		if ((item.role !== "assistant" && item.role !== "tool") || !item.usage) continue;
		totals.input += item.usage.input;
		totals.output += item.usage.output;
		totals.cacheRead += item.usage.cacheRead;
		totals.cacheWrite += item.usage.cacheWrite;
		totals.cost += item.usage.cost.total;
		if (item.role === "assistant" && item.status !== "error" && item.status !== "aborted") {
			latestAssistantUsage = item.usage;
		}
	}
	const totalsLabel = document.createElement("span");
	totalsLabel.className = "session-stat-totals";
	const appendStat = (symbol: string, value: string, title: string, className?: string): void => {
		const stat = document.createElement("span");
		stat.className = `session-stat${className ? ` ${className}` : ""}`;
		stat.title = title;
		const prefix = document.createElement("span");
		prefix.className = "session-stat-symbol";
		prefix.textContent = symbol;
		stat.append(prefix, document.createTextNode(value));
		totalsLabel.append(stat);
	};
	if (totals.input) appendStat("↑", formatTokens(totals.input), "Input tokens", "session-stat-input");
	if (totals.output) appendStat("↓", formatTokens(totals.output), "Output tokens", "session-stat-output");
	if (totals.cacheRead) appendStat("R", formatTokens(totals.cacheRead), "Cache-read tokens");
	if (totals.cacheWrite) appendStat("W", formatTokens(totals.cacheWrite), "Cache-write tokens");
	if (latestAssistantUsage && (totals.cacheRead > 0 || totals.cacheWrite > 0)) {
		const promptTokens =
			latestAssistantUsage.input + latestAssistantUsage.cacheRead + latestAssistantUsage.cacheWrite;
		if (promptTokens > 0) {
			appendStat(
				"CH",
				`${((latestAssistantUsage.cacheRead / promptTokens) * 100).toFixed(1)}%`,
				"Latest request cache-hit rate",
			);
		}
	}
	if (totals.cost)
		appendStat("$", totals.cost.toFixed(3), "Estimated session cost in US dollars", "session-stat-cost");
	const children: HTMLElement[] = [];
	if (totalsLabel.childElementCount > 0) children.push(totalsLabel);
	const currentModel = availableModels.find(
		(entry) => entry.provider === snapshot.model.provider && entry.id === snapshot.model.id,
	);
	if (currentModel) {
		const contextTokens = latestAssistantUsage
			? latestAssistantUsage.totalTokens ||
				latestAssistantUsage.input +
					latestAssistantUsage.output +
					latestAssistantUsage.cacheRead +
					latestAssistantUsage.cacheWrite
			: 0;
		const contextPercent = Math.min(100, (contextTokens / currentModel.contextWindow) * 100);
		const remainingTokens = Math.max(0, currentModel.contextWindow - contextTokens);
		const contextMeter = document.createElement("span");
		contextMeter.className = "context-meter";
		contextMeter.style.setProperty("--context-used", `${contextPercent}%`);
		contextMeter.dataset.level = contextPercent >= 90 ? "critical" : contextPercent >= 70 ? "warning" : "normal";
		contextMeter.title = `${formatTokens(remainingTokens)} tokens remaining · ${formatTokens(contextTokens)} used · ${contextPercent.toFixed(1)}% of ${formatTokens(currentModel.contextWindow)} · automatic compaction`;
		contextMeter.setAttribute("role", "progressbar");
		contextMeter.setAttribute("aria-label", contextMeter.title);
		contextMeter.setAttribute("aria-valuemin", "0");
		contextMeter.setAttribute("aria-valuemax", currentModel.contextWindow.toString());
		contextMeter.setAttribute("aria-valuenow", Math.min(contextTokens, currentModel.contextWindow).toString());
		contextMeter.tabIndex = 0;
		children.push(contextMeter);
	}
	sessionStats.replaceChildren(...children);
	sessionStats.title = "";
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function formatWorkingDirectory(cwd: string): string {
	const windowsHome = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)(?:\\|$)/)?.[1];
	if (windowsHome) return cwd.replace(windowsHome, "~");
	const unixHome = cwd.match(/^\/(?:home|Users)\/[^/]+(?:\/|$)/)?.[0].replace(/\/$/, "");
	return unixHome ? cwd.replace(unixHome, "~") : cwd;
}

function renderItem(item: TranscriptItem): HTMLElement {
	const article = document.createElement("article");
	article.className = `message ${item.role}`;
	if (item.role === "tool") {
		article.classList.add(`tool-${item.status}`);
		article.append(renderToolActivity(item));
		return article;
	}
	const label = document.createElement("div");
	label.className = "message-label";
	label.textContent = item.role === "assistant" ? "π" : item.role;
	article.append(label);

	for (const [index, content] of item.content.entries()) {
		if (content.type === "text") appendText(article, content.text);
		else if (item.role === "assistant" && content.type === "thinking") {
			article.append(renderThinkingActivity(item, content.thinking, index));
		} else if (content.type === "toolCall" && content.toolName !== "subagent") {
			appendText(article, `Using ${content.toolName}`, "tool-call");
		} else if (content.type === "image") appendText(article, `[image: ${content.mimeType}]`);
	}
	return article;
}

function renderThinkingActivity(
	item: Extract<TranscriptItem, { role: "assistant" }>,
	content: string,
	index: number,
): HTMLDetailsElement {
	const thinkingId = `${item.id}:${index}`;
	const details = document.createElement("details");
	details.className = `thinking-activity${item.status === "streaming" ? " is-streaming" : ""}`;
	details.dataset.thinkingId = thinkingId;
	if (item.status === "streaming") {
		streamingThinking.add(thinkingId);
	}
	details.open = expandedThinking.get(thinkingId) ?? false;
	details.addEventListener("toggle", () => expandedThinking.set(thinkingId, details.open));

	const summary = document.createElement("summary");
	const label = document.createElement("span");
	label.textContent = item.status === "streaming" ? "Thinking" : "Thought process";
	const dots = document.createElement("span");
	dots.className = "thinking-dots";
	dots.setAttribute("aria-hidden", "true");
	dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
	summary.append(label, dots);

	const body = document.createElement("div");
	body.className = "thinking-body";
	body.textContent = content;
	details.append(summary, body);

	if (item.status !== "streaming" && streamingThinking.delete(thinkingId) && !thinkingCollapseTimers.has(thinkingId)) {
		thinkingCollapseTimers.set(
			thinkingId,
			window.setTimeout(() => {
				expandedThinking.set(thinkingId, false);
				thinkingCollapseTimers.delete(thinkingId);
				for (const current of document.querySelectorAll<HTMLDetailsElement>(".thinking-activity")) {
					if (current.dataset.thinkingId === thinkingId) current.open = false;
				}
			}, 3000),
		);
	}
	return details;
}

function renderToolActivity(item: Extract<TranscriptItem, { role: "tool" }>): HTMLElement {
	if (item.toolName === "subagent") return renderSubagentCard(item);
	const details = document.createElement("details");
	details.className = "tool-activity";
	details.open = expandedToolActivity.get(item.toolCallId) ?? false;
	details.addEventListener("toggle", () => expandedToolActivity.set(item.toolCallId, details.open));

	const summary = document.createElement("summary");
	summary.className = "tool-activity-summary";
	const name = document.createElement("strong");
	name.textContent = item.toolName;
	const target = toolActivityTarget(item.input);
	if (target) {
		const targetLabel = document.createElement("span");
		targetLabel.className = "tool-activity-target";
		targetLabel.textContent = target;
		summary.append(name, targetLabel);
	} else {
		summary.append(name);
	}
	const state = document.createElement("span");
	state.className = "tool-activity-state";
	state.textContent = item.status === "complete" ? "Completed" : item.status === "error" ? "Failed" : "Running";
	summary.append(state);

	const body = document.createElement("div");
	body.className = "tool-activity-body";
	appendToolActivitySection(body, "Input", JSON.stringify(item.input, undefined, 2));
	for (const content of item.content) {
		appendToolActivitySection(
			body,
			"Output",
			content.type === "text" ? content.text : `[image: ${content.mimeType}]`,
		);
	}
	if (item.details !== undefined) {
		appendToolActivitySection(body, "Details", JSON.stringify(item.details, undefined, 2));
	}
	details.append(summary, body);
	return details;
}

function projectSubagentActivity(snapshot: SessionSnapshot): void {
	for (const item of snapshot.transcript) {
		if (item.role !== "tool" || item.toolName !== "subagent") continue;
		const key = `${snapshot.id}:${item.toolCallId}`;
		subagentActivityByKey.set(key, { key, sessionId: snapshot.id, item });
	}
}

function renderSubagentCard(item: Extract<TranscriptItem, { role: "tool" }>): HTMLElement {
	const key = `${session?.id ?? "session"}:${item.toolCallId}`;
	const card = document.createElement("section");
	card.className = "subagent-card";
	card.dataset.status = item.status;
	const header = document.createElement("div");
	header.className = "subagent-card-header";
	const indicator = document.createElement("i");
	indicator.className = "subagent-status-dot";
	const identity = document.createElement("div");
	identity.className = "subagent-identity";
	const name = document.createElement("strong");
	name.textContent = subagentName(item.input);
	const state = document.createElement("span");
	state.textContent = item.status === "running" ? "Running" : item.status === "error" ? "Failed" : "Completed";
	identity.append(name, state);
	const actions = document.createElement("div");
	actions.className = "subagent-card-actions";
	const inspect = document.createElement("button");
	inspect.type = "button";
	const inspectorOpen = openSubagentKeys.includes(key);
	inspect.className = "subagent-inspect";
	inspect.title = inspectorOpen ? "Close agent run" : "Inspect agent run";
	inspect.setAttribute("aria-label", inspect.title);
	inspect.append(eyeIcon(inspectorOpen));
	inspect.addEventListener("click", () => toggleSubagentInspector(key, item));
	actions.append(inspect);
	if (item.status === "running") {
		const stop = document.createElement("button");
		stop.type = "button";
		stop.className = "subagent-stop";
		stop.title = "Stop this delegation and the current Pi turn";
		stop.setAttribute("aria-label", stop.title);
		stop.textContent = "■";
		stop.addEventListener("click", () => void session?.abort());
		actions.append(stop);
	}
	header.append(indicator, identity, actions);
	const task = document.createElement("div");
	task.className = "subagent-task";
	task.textContent = subagentTask(item.input);
	const latest = document.createElement("div");
	latest.className = "subagent-latest";
	latest.textContent = subagentLatestAction(item) ?? (item.status === "running" ? "Starting agent…" : "Run finished");
	card.append(header, task, latest);
	return card;
}

function eyeIcon(open: boolean): SVGSVGElement {
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	const eye = document.createElementNS("http://www.w3.org/2000/svg", "path");
	eye.setAttribute("d", "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z");
	icon.append(eye);
	if (!open) {
		const slash = document.createElementNS("http://www.w3.org/2000/svg", "path");
		slash.setAttribute("d", "M4 4l16 16");
		icon.append(slash);
	}
	return icon;
}

function subagentName(input: unknown): string {
	const record = objectRecord(input);
	if (typeof record?.agent === "string") return record.agent;
	if (Array.isArray(record?.tasks)) return `${record.tasks.length} agents · parallel`;
	if (Array.isArray(record?.chain)) return `${record.chain.length} agents · sequential`;
	return "Subagent";
}

function subagentTask(input: unknown): string {
	const record = objectRecord(input);
	if (typeof record?.task === "string") return record.task;
	const entries = Array.isArray(record?.tasks) ? record.tasks : Array.isArray(record?.chain) ? record.chain : [];
	const tasks = entries.flatMap((entry) => {
		const candidate = objectRecord(entry);
		return typeof candidate?.task === "string" ? [candidate.task] : [];
	});
	return tasks.join(" · ") || "Delegated task";
}

function subagentLatestAction(item: Extract<TranscriptItem, { role: "tool" }>): string | undefined {
	const details = objectRecord(item.details);
	if (!Array.isArray(details?.results)) return item.content.find((part) => part.type === "text")?.text;
	for (let resultIndex = details.results.length - 1; resultIndex >= 0; resultIndex--) {
		const result = objectRecord(details.results[resultIndex]);
		if (!Array.isArray(result?.messages)) continue;
		for (let messageIndex = result.messages.length - 1; messageIndex >= 0; messageIndex--) {
			const message = objectRecord(result.messages[messageIndex]);
			if (message?.role === "toolResult" && typeof message.toolName === "string") {
				return `Completed ${message.toolName}`;
			}
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
				const part = objectRecord(message.content[contentIndex]);
				if (part?.type === "toolCall" && typeof part.name === "string") return `Using ${part.name}`;
				if (part?.type === "text" && typeof part.text === "string") return compactText(part.text);
			}
		}
	}
	return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function compactText(value: string): string {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}

function toolActivityTarget(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
	const record = input as Record<string, unknown>;
	for (const key of ["path", "filePath", "url", "command", "query", "pattern", "name"]) {
		const value = record[key];
		if (typeof value !== "string" || value.trim().length === 0) continue;
		const compact = value.replace(/\s+/g, " ").trim();
		return compact.length > 88 ? `${compact.slice(0, 85)}…` : compact;
	}
	return undefined;
}

function appendToolActivitySection(parent: HTMLElement, label: string, value: string): void {
	const section = document.createElement("section");
	const heading = document.createElement("div");
	heading.className = "tool-activity-heading";
	heading.textContent = label;
	const content = document.createElement("pre");
	content.textContent = value;
	section.append(heading, content);
	parent.append(section);
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
			const recommended = entry.provider === recommendedAgentModel.provider && entry.id === recommendedAgentModel.id;
			option.textContent = `${entry.provider} / ${entry.name}${recommended ? " · Recommended" : ""}`;
			return option;
		}),
	);
	if (!agentModelsInitialized) {
		const recommendedModelValue = `${recommendedAgentModel.provider}/${recommendedAgentModel.id}`;
		agentModel.value = models.some(
			(entry) => entry.provider === recommendedAgentModel.provider && entry.id === recommendedAgentModel.id,
		)
			? recommendedModelValue
			: "";
		agentModelsInitialized = true;
	}
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
	const id = connectedClient.snapshot?.serverId ?? createBrowserId();
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
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle(
				"active",
				!builderActive && !activeAgentId && !activeSubagentKey && target.key === activeTargetKey,
			);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab";
			button.classList.toggle(
				"active",
				!builderActive && !activeAgentId && !activeSubagentKey && target.key === activeTargetKey,
			);
			const sessionName = sessionDisplayName(target);
			const connection = connections.get(target.connectionId);
			button.textContent = connections.size > 1 && connection ? `${connection.label} · ${sessionName}` : sessionName;
			button.title = target.session.cwd ?? target.session.id;
			button.addEventListener("click", () => void switchSession(target));
			button.addEventListener("dblclick", () => renameSession(target));
			wrapper.append(button);
			return wrapper;
		}),
		...(builderSession ? [renderBuilderSessionTab()] : []),
		...openAgentIds.flatMap((agentId) => {
			const agent = agents.find((entry) => entry.id === agentId);
			if (!agent) return [];
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle("active", agent.id === activeAgentId);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab agent-session-tab";
			button.textContent = agent.name;
			button.title = `${agent.name} · ${agent.projectRoot}`;
			button.addEventListener("click", () => void openAgent(agent));
			const close = document.createElement("button");
			close.type = "button";
			close.className = "session-tab-close";
			close.textContent = "×";
			close.title = `Close ${agent.name} chat`;
			close.setAttribute("aria-label", `Close ${agent.name} chat`);
			close.addEventListener("click", () => closeAgentTab(agent.id));
			wrapper.append(button, close);
			return [wrapper];
		}),
		...openSubagentKeys.flatMap((key) => {
			const activity = subagentActivityByKey.get(key);
			if (!activity) return [];
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle("active", key === activeSubagentKey);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab subagent-session-tab";
			button.textContent = subagentName(activity.item.input);
			button.title = `Inspect ${subagentName(activity.item.input)}`;
			button.addEventListener("click", () => openSubagentInspector(key));
			const close = document.createElement("button");
			close.type = "button";
			close.className = "session-tab-close";
			close.textContent = "×";
			close.title = `Close ${subagentName(activity.item.input)} inspector`;
			close.setAttribute("aria-label", close.title);
			close.addEventListener("click", () => closeSubagentTab(key));
			wrapper.append(button, close);
			return [wrapper];
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
				button.classList.toggle("active", !builderActive && target.key === activeTargetKey);
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

function renderBuilderSessionTab(): HTMLDivElement {
	const wrapper = document.createElement("div");
	wrapper.className = "session-tab-wrap";
	wrapper.classList.toggle("active", builderActive);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "session-tab builder-session-tab";
	button.textContent = builderLabel;
	button.title = "Continue configuring this agent";
	button.addEventListener("click", openBuilderChat);
	const close = document.createElement("button");
	close.type = "button";
	close.className = "session-tab-close";
	close.textContent = "×";
	close.title = "Close Agent Builder";
	close.setAttribute("aria-label", close.title);
	close.addEventListener("click", () => void closeBuilderChat());
	wrapper.append(button, close);
	return wrapper;
}

async function switchSession(target: SessionTarget): Promise<void> {
	if (target.key === activeTargetKey && session?.attached) {
		builderActive = false;
		activeAgentId = undefined;
		activeSubagentKey = undefined;
		if (session.snapshot) render(session.snapshot);
		renderSessionNavigation();
		renderAttachments();
		return;
	}
	const entry = connections.get(target.connectionId);
	if (!entry) throw new Error("Pi connection is unavailable");
	setStatus(`Connecting to ${sessionDisplayName(target)}…`);
	phase.textContent = "connecting";
	input.disabled = true;
	unsubscribeSession?.();
	unsubscribeSession = undefined;
	await session?.dispose().catch(() => {});
	session = await entry.client.attachSession(target.session.id);
	activeTargetKey = target.key;
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	populateModels(entry.client.snapshot?.models ?? []);
	unsubscribeSession = session.subscribe(render);
	if (session.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
	void loadPreview().catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
	const cwd = session.snapshot?.cwd ?? target.session.cwd;
	setStatus(cwd ? formatWorkingDirectory(cwd) : entry.label);
}

function setPreviewMessage(message: string, error = false): void {
	previewStatus.textContent = message;
	previewStatus.classList.toggle("error", error);
}

function setPreviewControls(browserSession: BrowserSessionSummary | undefined): void {
	const sessionId = browserSession?.id;
	if (previewCapture && previewCapture.sessionId !== sessionId) previewCapture = undefined;
	const userControls = browserSession?.controlOwner === "user";
	activePreviewSessionId = sessionId;
	activePreviewSession = browserSession;
	previewAddress.value = browserSession?.url ?? "";
	previewAddress.disabled = !userControls;
	previewBack.disabled = !userControls || !browserSession?.canGoBack;
	previewForward.disabled = !userControls || !browserSession?.canGoForward;
	previewReload.disabled = !userControls || !browserSession?.url;
	previewControl.disabled = sessionId === undefined;
	previewPopout.disabled = !browserPopoutMode && sessionId === undefined;
	setBrowserAction(
		previewControl,
		userControls ? "agent" : "human",
		userControls ? "Return to agent" : "Take control",
		userControls ? "Return browser control to the agent" : "Take browser control from the agent",
	);
	renderPreviewRecording();
}

function renderPreviewRecording(): void {
	const stepCount = previewCapture?.steps.length ?? 0;
	const previewRecording = previewCapture?.status === "recording";
	previewRecord.disabled = activePreviewSessionId === undefined;
	previewRecord.classList.toggle("recording", previewRecording);
	setBrowserAction(
		previewRecord,
		previewRecording ? "stop" : "record",
		previewRecording ? "Stop" : "Record",
		previewRecording ? "Stop recording the walkthrough" : "Record a browser walkthrough",
	);
	previewRecord.setAttribute("aria-pressed", String(previewRecording));
	previewSendRecording.disabled = stepCount === 0 || session?.snapshot?.phase !== "idle";
	previewRecordingStatus.textContent = previewRecording
		? `Recording · ${stepCount} step${stepCount === 1 ? "" : "s"}`
		: stepCount > 0
			? `${stepCount} recorded step${stepCount === 1 ? "" : "s"} ready for Pi`
			: "";
}

async function togglePreviewRecording(): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/capture?token=${encodeURIComponent(capabilityToken)}`,
		{ method: previewCapture?.status === "recording" ? "DELETE" : "POST" },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not update browser recording"));
	const value: unknown = await response.json();
	const capture = isBrowserCaptureSummary(value)
		? value
		: isBrowserCaptureStopResult(value)
			? value.capture
			: undefined;
	if (!capture) throw new Error("Browser recording response is invalid");
	previewCapture = capture;
	if (isBrowserCaptureStopResult(value) && value.workflow) {
		setPreviewMessage(
			value.workflow.status === "compiled"
				? `Workflow ${value.workflow.name} compiled and ready to validate`
				: `Workflow ${value.workflow.name} needs ${value.workflow.compileIssues.length} clarification${value.workflow.compileIssues.length === 1 ? "" : "s"}`,
			value.workflow.status === "needs-input",
		);
	}
	renderPreviewRecording();
	await loadBrowserWorkflows(true);
}

async function loadPreviewCapture(): Promise<void> {
	if (!capabilityToken || !activePreviewSessionId) return;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/capture?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (response.status === 404) {
		if (previewCapture?.status === "recording") previewCapture = undefined;
		renderPreviewRecording();
		return;
	}
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser recording"));
	const value: unknown = await response.json();
	if (!isBrowserCaptureSummary(value)) throw new Error("Browser recording response is invalid");
	previewCapture = value;
	renderPreviewRecording();
}

function recordedStepText(step: BrowserCaptureSummary["steps"][number], index: number): string {
	const prefix = `${index + 1}.`;
	const action = step.action;
	switch (action.kind) {
		case "navigate":
			return `${prefix} navigate to ${action.url ?? "the current page"}`;
		case "click":
			return `${prefix} click ${browserTargetText(action.target)}`;
		case "type":
			return `${prefix} type a ${action.sensitive ? "sensitive " : ""}parameter (${action.textLength ?? 0} characters) into ${browserTargetText(action.target)}`;
		case "scroll":
		case "back":
		case "forward":
		case "reload":
			return `${prefix} ${action.kind}`;
	}
}

function browserTargetText(target: BrowserCaptureSummary["steps"][number]["action"]["target"]): string {
	if (!target) return "an unresolved element";
	const name = target.name || target.label || target.testId || target.id;
	return name ? `${target.role} "${name}"` : target.role;
}

async function sendPreviewRecordingToPi(): Promise<void> {
	if (!session || session.snapshot?.phase !== "idle" || !previewCapture || previewCapture.steps.length === 0) return;
	if (activePreviewSession?.controlOwner === "user") await setPreviewControl("agent");
	const workflow = recordedBrowserWorkflows.find((entry) => entry.source.captureId === previewCapture?.id);
	const steps = previewCapture.steps.map(recordedStepText).join("\n");
	previewCapture = undefined;
	renderPreviewRecording();
	await session.prompt(
		[
			workflow
				? `Review canonical browser workflow ${workflow.id} version ${workflow.version} (${workflow.status}).`
				: "Review this recorded managed-browser walkthrough and its compiled workflow.",
			"Use browser_workflow_list to inspect the canonical definition. Resolve any needs-input items before validation.",
			"Do not replace semantic targets with viewport coordinates. Typed values are parameters and secrets remain references.",
			"When it is ready, validate it in a fresh browser and ask before activating it.",
			"",
			steps,
		].join("\n"),
	);
}

async function loadBrowserWorkflows(force = false): Promise<void> {
	if (!capabilityToken) return;
	if (!force && Date.now() - lastBrowserWorkflowLoadAt < 5_000) return;
	const [response, runResponse] = await Promise.all([
		fetch(`/browser/workflows?token=${encodeURIComponent(capabilityToken)}`),
		fetch(`/browser/workflow-runs?token=${encodeURIComponent(capabilityToken)}`),
	]);
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser workflows"));
	if (!runResponse.ok) throw new Error(await responseError(runResponse, "Could not load browser workflow runs"));
	const value: unknown = await response.json();
	const runValue: unknown = await runResponse.json();
	if (!isBrowserWorkflowList(value)) throw new Error("Browser workflow response is invalid");
	if (!isBrowserWorkflowRunList(runValue)) throw new Error("Browser workflow run response is invalid");
	recordedBrowserWorkflows = value.workflows;
	browserWorkflowRuns = runValue.runs;
	lastBrowserWorkflowLoadAt = Date.now();
	if (force) browserWorkflowReviews.clear();
	await renderBrowserWorkflows();
	renderAgentBrowserWorkflowGrants();
	refreshRoutineEditorOptions();
}

async function renderBrowserWorkflows(): Promise<void> {
	const openWorkflowKeys = new Set(
		[...browserWorkflowList.querySelectorAll<HTMLDetailsElement>(".browser-workflow-card[open]")]
			.map((entry) => entry.dataset.workflowKey)
			.filter((entry): entry is string => entry !== undefined),
	);
	const cards: HTMLElement[] = [];
	for (const workflow of recordedBrowserWorkflows) {
		const card = document.createElement("details");
		card.className = "browser-workflow-card";
		card.dataset.workflowKey = `${workflow.id}@${workflow.version}`;
		card.open = openWorkflowKeys.has(card.dataset.workflowKey);
		const summary = document.createElement("summary");
		const name = document.createElement("span");
		name.textContent = workflow.name;
		const state = document.createElement("span");
		state.className = `browser-workflow-state state-${workflow.status}`;
		state.textContent = workflow.status;
		summary.append(name, state);
		const body = document.createElement("div");
		body.className = "browser-workflow-body";
		const latestRun = browserWorkflowRuns.find(
			(run) => run.workflowId === workflow.id && run.workflowVersion === workflow.version,
		);
		if (latestRun) {
			const evidence = document.createElement("details");
			evidence.className = "browser-workflow-evidence";
			const evidenceSummary = document.createElement("summary");
			evidenceSummary.textContent = `${latestRun.kind} · ${latestRun.status}`;
			const evidenceBody = document.createElement("div");
			if (latestRun.error) appendText(evidenceBody, latestRun.error, "run-error");
			for (const step of latestRun.steps) {
				appendText(
					evidenceBody,
					`${step.stepId} · ${step.status}${step.error ? ` · ${step.error}` : ""}${step.url ? ` · ${step.url}` : ""}`,
					step.status === "failed" ? "run-error" : "muted",
				);
				for (const artifact of step.artifacts) {
					const link = document.createElement("a");
					link.href = `/browser/workflow-runs/${encodeURIComponent(latestRun.id)}/artifacts/${encodeURIComponent(artifact.id)}?token=${encodeURIComponent(capabilityToken ?? "")}`;
					link.target = "_blank";
					link.rel = "noopener";
					link.textContent = `${step.stepId} ${artifact.phase} screenshot`;
					link.title = "Open browser workflow evidence";
					evidenceBody.append(link);
				}
			}
			evidence.append(evidenceSummary, evidenceBody);
			body.append(evidence);
		}
		if (workflow.compileIssues.length > 0) {
			const review = await loadBrowserWorkflowReview(workflow.id, workflow.version);
			for (const issue of review.issues) body.append(renderBrowserWorkflowIssue(workflow, issue));
		}
		const values = document.createElement("div");
		values.className = "browser-workflow-values";
		for (const parameter of workflow.parameters) {
			const label = document.createElement("label");
			label.textContent = parameter.name;
			const field = document.createElement("input");
			field.dataset.workflowParameter = parameter.name;
			field.type = parameter.sensitive ? "password" : parameter.type === "number" ? "number" : "text";
			field.placeholder = parameter.description;
			field.required = parameter.required;
			label.append(field);
			values.append(label);
		}
		body.append(values);
		const actions = document.createElement("div");
		actions.className = "browser-workflow-actions";
		if (workflow.status === "compiled") {
			actions.append(
				browserWorkflowAction("✓", "Validate workflow in a fresh browser", () =>
					browserWorkflowRequest(workflow, "validate", workflowParameterValues(body)),
				),
			);
		}
		if (workflow.status === "validated") {
			actions.append(
				browserWorkflowAction("●", "Activate validated workflow", () =>
					browserWorkflowRequest(workflow, "activate", {}),
				),
			);
		}
		if (workflow.status === "active") {
			actions.append(
				browserWorkflowAction("▶", "Run active workflow", () =>
					browserWorkflowRequest(workflow, "run", workflowParameterValues(body)),
				),
				browserWorkflowAction("◇", "Create a reusable Pi skill reference", () =>
					browserWorkflowReferenceRequest(workflow, "create-skill"),
				),
				browserWorkflowAction("⊞", "Use as a frontend test for this project", () =>
					browserWorkflowReferenceRequest(workflow, "frontend-test"),
				),
			);
		}
		body.append(actions);
		card.append(summary, body);
		cards.push(card);
	}
	browserWorkflowList.replaceChildren(...cards);
}

function renderBrowserWorkflowIssue(
	workflow: BrowserWorkflowSummary,
	issue: BrowserWorkflowReview["issues"][number],
): HTMLElement {
	const row = document.createElement("div");
	row.className = "browser-workflow-issue";
	const label = document.createElement("span");
	label.textContent = issue.message;
	const select = document.createElement("select");
	select.setAttribute("aria-label", `Target for ${issue.stepId}`);
	const empty = document.createElement("option");
	empty.value = "";
	empty.textContent = "Select page element";
	select.append(empty);
	for (const candidate of issue.candidates) {
		const option = document.createElement("option");
		option.value = String(candidate.index);
		option.textContent = `${candidate.role} · ${candidate.name || candidate.label || candidate.testId || candidate.id || "unnamed"}`;
		select.append(option);
	}
	const apply = browserWorkflowAction("✓", "Use selected semantic target", async () => {
		if (select.value === "") throw new Error("Select a page element first");
		await browserWorkflowResolveTarget(workflow, issue.stepId, Number(select.value));
	});
	row.append(label, select, apply);
	return row;
}

function browserWorkflowAction(label: string, title: string, action: () => Promise<void>): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.setAttribute("aria-label", title);
	button.addEventListener("click", () => {
		button.disabled = true;
		void action()
			.then(() => loadBrowserWorkflows(true))
			.catch((error: unknown) => setPreviewMessage(error instanceof Error ? error.message : String(error), true))
			.finally(() => {
				button.disabled = false;
			});
	});
	return button;
}

function workflowParameterValues(container: HTMLElement): Record<string, string | number | boolean> {
	const values: Record<string, string | number | boolean> = {};
	for (const field of container.querySelectorAll<HTMLInputElement>("[data-workflow-parameter]")) {
		if (!field.dataset.workflowParameter || field.value === "") continue;
		values[field.dataset.workflowParameter] = field.type === "number" ? Number(field.value) : field.value;
	}
	return values;
}

async function browserWorkflowRequest(
	workflow: BrowserWorkflowSummary,
	action: "validate" | "activate" | "run",
	parameters: Record<string, string | number | boolean>,
): Promise<void> {
	if (!capabilityToken) return;
	const approved =
		action !== "run" ||
		workflow.policy.approval !== "always" ||
		window.confirm(`Run browser workflow "${workflow.name}"? It is configured to require approval.`);
	if (!approved) return;
	const response = await fetch(
		`/browser/workflows/${encodeURIComponent(workflow.id)}/${action}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: workflow.version, parameters, approved: action === "run" && approved }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, `Could not ${action} browser workflow`));
	setPreviewMessage(`${workflow.name}: ${action} completed`);
}

async function browserWorkflowReferenceRequest(
	workflow: BrowserWorkflowSummary,
	action: "create-skill" | "frontend-test",
): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/browser/workflows/${encodeURIComponent(workflow.id)}/${action}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: workflow.version }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not create browser workflow reference"));
	setPreviewMessage(action === "create-skill" ? "Skill reference created" : "Frontend test attached to this project");
}

async function browserWorkflowResolveTarget(
	workflow: BrowserWorkflowSummary,
	stepId: string,
	elementIndex: number,
): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/browser/workflows/${encodeURIComponent(workflow.id)}/resolve-target?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ version: workflow.version, stepId, elementIndex }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not resolve browser workflow target"));
}

async function loadBrowserWorkflowReview(id: string, version: number): Promise<BrowserWorkflowReview> {
	const key = `${id}:${version}`;
	const cached = browserWorkflowReviews.get(key);
	if (cached) return cached;
	const response = await fetch(
		`/browser/workflows/${encodeURIComponent(id)}/review?version=${version}&token=${encodeURIComponent(capabilityToken ?? "")}`,
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser workflow review"));
	const value: unknown = await response.json();
	if (!isBrowserWorkflowReview(value)) throw new Error("Browser workflow review response is invalid");
	browserWorkflowReviews.set(key, value);
	return value;
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

function loadPreview(): Promise<void> {
	previewRefreshRequested = true;
	if (previewRefreshPromise) return previewRefreshPromise;
	previewRefreshPromise = (async () => {
		do {
			previewRefreshRequested = false;
			await loadPreviewOnce();
		} while (previewRefreshRequested);
	})().finally(() => {
		previewRefreshPromise = undefined;
	});
	return previewRefreshPromise;
}

async function loadPreviewOnce(): Promise<void> {
	if (!capabilityToken) return;
	await loadBrowserWorkflows();
	if (!session) {
		previewSession.textContent = "No Pi session selected";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		renderPreviewSessionTabs([], undefined);
		setPreviewMessage("Select a Pi session to inspect its managed browsers.");
		previewStream?.close();
		return;
	}
	let browserStatus = cachedBrowserStatus;
	if (!browserStatus?.installed) {
		const statusResponse = await fetch(`/browser/status?token=${encodeURIComponent(capabilityToken)}`);
		if (!statusResponse.ok) throw new Error(await responseError(statusResponse, "Could not load browser status"));
		const value: unknown = await statusResponse.json();
		if (!isBrowserConsoleStatus(value)) throw new Error("Browser status response is invalid");
		browserStatus = value;
		cachedBrowserStatus = value;
	}
	if (!browserStatus.installed) {
		previewSession.textContent = "Managed Chromium is not installed";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		setPreviewMessage("Run `pi browser install chromium`, then ask Pi to open a local URL.");
		return;
	}
	const sessionsResponse = await fetch(`/browser/sessions?token=${encodeURIComponent(capabilityToken)}`);
	if (!sessionsResponse.ok) throw new Error(await responseError(sessionsResponse, "Could not load browser sessions"));
	const payload: unknown = await sessionsResponse.json();
	if (!isBrowserSessionList(payload)) throw new Error("Browser session response is invalid");
	const browserSessions = payload.sessions
		.filter((entry) => entry.status !== "closed")
		.sort((left, right) => right.updatedAt - left.updatedAt);
	const browserSession = selectPreviewSession(browserSessions);
	renderPreviewSessionTabs(browserSessions, browserSession?.id);
	if (!browserSession) {
		previewSession.textContent = "";
		previewImage.removeAttribute("src");
		setPreviewControls(undefined);
		setPreviewMessage("");
		previewStream?.close();
		return;
	}
	previewSession.textContent = `${browserOwnerLabel(browserSession)} · ${browserSession.controlOwner === "user" ? "User control" : "Agent control"}`;
	setPreviewControls(browserSession);
	await loadPreviewCapture();
	if (browserSession.status === "failed") {
		previewImage.removeAttribute("src");
		setPreviewMessage(browserSession.lastError ?? "Browser session failed", true);
		return;
	}
	if (!ensurePreviewStream(browserSession.id)) {
		previewImage.src = `/browser/sessions/${encodeURIComponent(browserSession.id)}/screenshot?token=${encodeURIComponent(capabilityToken)}&at=${browserSession.updatedAt}`;
	}
	setPreviewMessage(`${browserSession.status} · managed Chromium · live`);
}

function selectPreviewSession(browserSessions: BrowserSessionSummary[]): BrowserSessionSummary | undefined {
	const selected = browserSessions.find((entry) => entry.id === selectedPreviewSessionId);
	if (selected) return selected;
	selectedPreviewSessionId = undefined;
	if (activeConnectionIsPrimary()) {
		const currentPiBrowser = browserSessions.find(
			(entry) => entry.owner.kind === "pi-session" && entry.owner.id === session?.id,
		);
		if (currentPiBrowser) return currentPiBrowser;
	}
	return browserSessions[0];
}

function renderPreviewSessionTabs(browserSessions: BrowserSessionSummary[], selectedId: string | undefined): void {
	if (browserSessions.length === 0) {
		previewSessionTabs.replaceChildren();
		return;
	}
	previewSessionTabs.replaceChildren(
		...browserSessions.map((browserSession) => {
			const button = document.createElement("button");
			button.type = "button";
			button.classList.toggle("active", browserSession.id === selectedId);
			const icon = document.createElement("span");
			icon.className = "browser-tab-icon";
			icon.textContent = browserSession.owner.kind === "pi-session" ? "π" : "◎";
			const label = document.createElement("span");
			label.textContent = browserSession.title ?? browserOwnerLabel(browserSession);
			button.append(icon, label);
			button.title = [browserOwnerLabel(browserSession), browserSession.title, browserSession.url]
				.filter(Boolean)
				.join(" · ");
			button.addEventListener("click", () => {
				selectedPreviewSessionId = browserSession.id;
				void loadPreview().catch((error: unknown) =>
					setPreviewMessage(error instanceof Error ? error.message : String(error), true),
				);
			});
			return button;
		}),
	);
}

function browserOwnerLabel(browserSession: BrowserSessionSummary): string {
	if (browserSession.owner.kind === "pi-session") {
		return browserSession.owner.id === session?.id ? "Current Pi" : `Pi · ${shortId(browserSession.owner.id)}`;
	}
	if (browserSession.owner.kind === "agent-run") return `Agent · ${shortId(browserSession.owner.id)}`;
	return `External · ${shortId(browserSession.owner.id)}`;
}

function shortId(value: string): string {
	return value.length > 8 ? `${value.slice(0, 8)}…` : value;
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
	const pendingMessage = {
		back: "Going back in managed browser…",
		forward: "Going forward in managed browser…",
		reload: "Reloading managed browser…",
	}[action];
	setPreviewMessage(pendingMessage);
	previewBack.disabled = true;
	previewForward.disabled = true;
	previewReload.disabled = true;
	try {
		const response = await fetch(
			`/browser/sessions/${encodeURIComponent(activePreviewSessionId)}/${action}?token=${encodeURIComponent(capabilityToken)}`,
			{ method: "POST" },
		);
		if (!response.ok) throw new Error(await responseError(response, `Could not ${action} managed browser`));
		await loadPreview();
	} finally {
		setPreviewControls(activePreviewSession);
	}
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
			JSON.stringify({ type: "input", sessionId: activePreviewSessionId, requestId: createBrowserId(), input }),
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
		"installedChrome" in value &&
		typeof value.installedChrome === "boolean" &&
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
			"owner" in entry &&
			typeof entry.owner === "object" &&
			entry.owner !== null &&
			"kind" in entry.owner &&
			(entry.owner.kind === "pi-session" ||
				entry.owner.kind === "agent-run" ||
				entry.owner.kind === "external-run") &&
			"id" in entry.owner &&
			typeof entry.owner.id === "string" &&
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

function isBrowserCaptureSummary(value: unknown): value is BrowserCaptureSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"status" in value &&
		(value.status === "recording" || value.status === "stopped" || value.status === "interrupted") &&
		"steps" in value &&
		Array.isArray(value.steps) &&
		value.steps.every(
			(step) =>
				typeof step === "object" &&
				step !== null &&
				"action" in step &&
				typeof step.action === "object" &&
				step.action !== null &&
				"kind" in step.action &&
				typeof step.action.kind === "string",
		)
	);
}

function isBrowserCaptureStopResult(value: unknown): value is {
	capture: BrowserCaptureSummary;
	workflow?: { name: string; status: string; compileIssues: unknown[] };
} {
	if (
		typeof value !== "object" ||
		value === null ||
		!("capture" in value) ||
		!isBrowserCaptureSummary(value.capture)
	) {
		return false;
	}
	if (!("workflow" in value) || value.workflow === undefined) return true;
	return (
		typeof value.workflow === "object" &&
		value.workflow !== null &&
		"name" in value.workflow &&
		typeof value.workflow.name === "string" &&
		"status" in value.workflow &&
		typeof value.workflow.status === "string" &&
		"compileIssues" in value.workflow &&
		Array.isArray(value.workflow.compileIssues)
	);
}

function isBrowserWorkflowList(value: unknown): value is { workflows: BrowserWorkflowSummary[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"workflows" in value &&
		Array.isArray(value.workflows) &&
		value.workflows.every(isBrowserWorkflowSummary)
	);
}

function isBrowserWorkflowRunList(value: unknown): value is { runs: BrowserWorkflowRunSummary[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"runs" in value &&
		Array.isArray(value.runs) &&
		value.runs.every(
			(run) =>
				typeof run === "object" &&
				run !== null &&
				"id" in run &&
				typeof run.id === "string" &&
				"workflowId" in run &&
				typeof run.workflowId === "string" &&
				"workflowVersion" in run &&
				typeof run.workflowVersion === "number" &&
				"status" in run &&
				typeof run.status === "string" &&
				"steps" in run &&
				Array.isArray(run.steps) &&
				run.steps.every(
					(step: unknown) =>
						typeof step === "object" && step !== null && "artifacts" in step && Array.isArray(step.artifacts),
				),
		)
	);
}

function isBrowserWorkflowSummary(value: unknown): value is BrowserWorkflowSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"version" in value &&
		typeof value.version === "number" &&
		"name" in value &&
		typeof value.name === "string" &&
		"status" in value &&
		typeof value.status === "string" &&
		"source" in value &&
		typeof value.source === "object" &&
		value.source !== null &&
		"parameters" in value &&
		Array.isArray(value.parameters) &&
		"compileIssues" in value &&
		Array.isArray(value.compileIssues)
	);
}

function isBrowserWorkflowReview(value: unknown): value is BrowserWorkflowReview {
	return (
		typeof value === "object" &&
		value !== null &&
		"workflow" in value &&
		isBrowserWorkflowSummary(value.workflow) &&
		"issues" in value &&
		Array.isArray(value.issues) &&
		value.issues.every(
			(issue) =>
				typeof issue === "object" &&
				issue !== null &&
				"stepId" in issue &&
				typeof issue.stepId === "string" &&
				"message" in issue &&
				typeof issue.message === "string" &&
				"candidates" in issue &&
				Array.isArray(issue.candidates),
		)
	);
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
	setStatus("Connecting to Pi…");
	const primary = await addConnection(location.href, true);
	client = primary.client;
	populateModels(primary.client.snapshot?.models ?? [], true);
	const initial = sessionTargets().find((target) => target.connectionId === primary.id);
	if (!initial) throw new Error("The active Pi session is unavailable");
	await switchSession(initial);
	installAgentEvents();
	window.setTimeout(() => {
		void Promise.all([
			loadAgents().catch(() => {}),
			loadPersonas().catch(() => {}),
			loadRoutines().catch(() => {}),
			loadWorkflows().catch(() => {}),
			loadCapabilityConnections()
				.then(() => Promise.all([loadCapabilities(), loadWaveTwoControls()]))
				.catch(() => {}),
			loadExternalConnections().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			),
		]);
	}, 0);
}

function installAgentEvents(): void {
	agentEvents?.close();
	if (!capabilityToken) return;
	agentEvents = new EventSource(`/agent-events?token=${encodeURIComponent(capabilityToken)}`);
	agentEvents.addEventListener("message", () => {
		void loadAgents().catch(() => {});
		if (activeSidebarAgent) void loadSelectedAgent().catch(() => {});
		void loadRoutines().catch(() => {});
		void loadWorkflows().catch(() => {});
	});
}

window.addEventListener("beforeunload", () => agentEvents?.close());

async function loadCapabilities(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/capabilities.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load capabilities: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isCapabilitySnapshot(payload)) throw new Error("Capability catalog returned an invalid response");
	capabilitySnapshot = payload.broker;
	const query = ensureCapabilitySearch().value.trim().toLowerCase();
	const groups: Array<["local" | "remote", string, CapabilityEntry[], boolean]> = [
		["local", "Tools", payload.tools, false],
		["local", "Skills", payload.skills, false],
		["local", "Plugins", payload.plugins, false],
		["local", "Extensions", payload.extensions, false],
		["remote", "MCP servers", payload.mcpServers, false],
		["remote", "ACP connectors", payload.acpConnections, false],
		["remote", "Model providers", payload.modelProviders, false],
	];
	element("capability-list").replaceChildren(
		...renderBrokeredCapabilities(payload.broker, query),
		...groups.map(([location, label, entries, open]) => {
			const visibleEntries = entries.filter((entry) =>
				[entry.name, entry.description, entry.scope, entry.source ?? ""].some((value) =>
					value.toLowerCase().includes(query),
				),
			);
			const section = document.createElement("details");
			section.className = "capability-section";
			section.open = open;
			const heading = document.createElement("summary");
			const headingLabel = document.createElement("strong");
			headingLabel.textContent = label;
			const locationLabel = document.createElement("span");
			locationLabel.className = `capability-location ${location}`;
			locationLabel.textContent = location;
			const count = document.createElement("span");
			count.className = "capability-count";
			count.textContent = String(visibleEntries.length);
			heading.append(headingLabel, locationLabel, count);
			section.append(heading);
			if (visibleEntries.length === 0) {
				appendText(section, `No ${label.toLowerCase()} configured`, "muted");
				return section;
			}
			for (const entry of [...visibleEntries].sort((left, right) => left.name.localeCompare(right.name))) {
				const card = document.createElement("details");
				card.className = "card capability-card";
				const title = document.createElement("summary");
				const name = document.createElement("span");
				name.textContent = entry.name;
				const state = document.createElement("span");
				state.className = "capability-status";
				state.textContent = entry.status;
				title.append(name, state);
				const body = document.createElement("div");
				body.className = "capability-body";
				appendText(body, entry.description, "muted");
				const meta = document.createElement("div");
				meta.className = "capability-meta";
				meta.textContent = [entry.scope, entry.source, entry.path].filter(Boolean).join(" · ");
				body.append(meta);
				if (label === "Tools") {
					const grant = document.createElement("label");
					const checkbox = document.createElement("input");
					checkbox.type = "checkbox";
					checkbox.checked = selectedAgentTools().has(entry.id);
					const harness = requiredElement<HTMLSelectElement>("agent-executor").value === "harness";
					checkbox.disabled = harness && !["read", "ls", "list", "write"].includes(entry.id);
					checkbox.title = checkbox.disabled ? "Use the Pi session executor for extension and remote tools" : "";
					checkbox.addEventListener("change", () => updateAgentToolGrant(entry.id, checkbox.checked));
					grant.append(checkbox, " Grant to this agent");
					body.append(grant);
				}
				if (label === "Plugins" && entry.source) {
					const actions = document.createElement("div");
					actions.className = "routine-actions";
					const update = document.createElement("button");
					update.type = "button";
					update.textContent = "Update";
					update.addEventListener("click", () => void changePlugin("update", entry.source ?? "", entry.scope));
					const remove = document.createElement("button");
					remove.type = "button";
					remove.className = "danger";
					remove.textContent = "Remove";
					remove.addEventListener("click", () => void changePlugin("remove", entry.source ?? "", entry.scope));
					actions.append(update, remove);
					body.append(actions);
				}
				card.append(title, body);
				section.append(card);
			}
			return section;
		}),
	);
	updateBuilderCapabilitySummary();
}

async function loadCapabilityConnections(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/capability-connections.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load provider accounts"));
	const payload: unknown = await response.json();
	if (!isCapabilityConnectionList(payload)) throw new Error("Provider accounts returned an invalid response");
	capabilityConnections = payload.connections;
	capabilityConnectionList.replaceChildren(
		...capabilityConnections.map((connection) => {
			const card = document.createElement("div");
			card.className = "card capability-connection-card";
			const summary = document.createElement("div");
			summary.className = "capability-connection-summary";
			appendText(summary, connection.accountLabel);
			appendText(summary, `${connection.providerId} · ${connection.status}`, "capability-status");
			card.append(summary);
			appendText(card, `${connection.capabilityIds.length} grants · ${connection.secretRef}`, "capability-meta");
			if (connection.status !== "revoked") {
				const actions = document.createElement("div");
				actions.className = "routine-actions";
				const edit = document.createElement("button");
				edit.type = "button";
				edit.textContent = connection.status === "unhealthy" ? "Reconnect" : "Edit";
				edit.addEventListener("click", () => editCapabilityConnection(connection));
				const revoke = document.createElement("button");
				revoke.type = "button";
				revoke.className = "danger";
				revoke.textContent = "Revoke";
				revoke.addEventListener("click", () => void revokeCapabilityConnection(connection));
				actions.append(edit, revoke);
				card.append(actions);
			}
			return card;
		}),
	);
	refreshConnectionSelectors();
}

function isCapabilityConnectionList(value: unknown): value is { connections: CapabilityConnectionSummary[] } {
	if (typeof value !== "object" || value === null || !("connections" in value) || !Array.isArray(value.connections)) {
		return false;
	}
	return value.connections.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"providerId" in entry &&
			typeof entry.providerId === "string" &&
			"capabilityIds" in entry &&
			Array.isArray(entry.capabilityIds),
	);
}

async function revokeCapabilityConnection(connection: CapabilityConnectionSummary): Promise<void> {
	if (!capabilityToken || !window.confirm(`Revoke ${connection.accountLabel}? Agents and routines will lose access.`))
		return;
	const response = await fetch(
		`/capability-connections/${encodeURIComponent(connection.id)}?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not revoke provider account"));
	await Promise.all([loadCapabilityConnections(), loadCapabilities()]);
}

function editCapabilityConnection(connection: CapabilityConnectionSummary): void {
	requiredElement<HTMLInputElement>("capability-connection-id").value = connection.id;
	requiredElement<HTMLInputElement>("capability-connection-provider").value = connection.providerId;
	requiredElement<HTMLInputElement>("capability-connection-label").value = connection.accountLabel;
	requiredElement<HTMLInputElement>("capability-connection-secret-ref").value = connection.secretRef;
	requiredElement<HTMLSelectElement>("capability-connection-status").value =
		connection.status === "unhealthy" ? "active" : connection.status;
	requiredElement<HTMLInputElement>("capability-connection-scopes").value = connection.scopes.join(", ");
	requiredElement<HTMLInputElement>("capability-connection-capabilities").value = connection.capabilityIds.join(", ");
	requiredElement<HTMLInputElement>("capability-connection-provider").focus();
}

function clearCapabilityConnectionForm(): void {
	capabilityConnectionForm.reset();
	requiredElement<HTMLInputElement>("capability-connection-id").value = "";
}

function refreshConnectionSelectors(): void {
	const inbound = requiredElement<HTMLSelectElement>("inbound-route-connection");
	const finance = requiredElement<HTMLSelectElement>("finance-watchlist-connection");
	const selectedInbound = inbound.value;
	const selectedFinance = finance.value;
	inbound.replaceChildren();
	finance.replaceChildren(new Option("None", ""));
	for (const connection of capabilityConnections.filter((entry) => entry.status === "active")) {
		const label = `${connection.accountLabel} · ${connection.providerId}`;
		if (connection.capabilityIds.some((id) => id.startsWith("messaging.") || id.startsWith("email."))) {
			inbound.append(new Option(label, connection.id));
		}
		if (connection.capabilityIds.some((id) => id.startsWith("finance."))) {
			finance.append(new Option(label, connection.id));
		}
	}
	if ([...inbound.options].some((option) => option.value === selectedInbound)) inbound.value = selectedInbound;
	if ([...finance.options].some((option) => option.value === selectedFinance)) finance.value = selectedFinance;
}

async function loadWaveTwoControls(): Promise<void> {
	await Promise.all([loadCapabilityApprovals(), loadInboundRoutes(), loadEverydayConfigurations()]);
}

async function loadCapabilityApprovals(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/capability-approvals.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load approvals"));
	const payload: unknown = await response.json();
	if (!isApprovalList(payload)) throw new Error("Approval history returned an invalid response");
	capabilityApprovalList.replaceChildren(
		...payload.approvals.slice(0, 20).map((approval) => {
			const card = document.createElement("div");
			card.className = "card capability-connection-card";
			appendText(card, `${approval.action} · ${approval.target}`);
			appendText(card, `${approval.capabilityId} · ${approval.state}`, "capability-meta");
			appendText(card, `Expires ${new Date(approval.expiresAt).toLocaleString()}`, "muted");
			return card;
		}),
	);
	if (payload.approvals.length === 0) appendText(capabilityApprovalList, "No approval receipts", "muted");
}

async function loadInboundRoutes(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/capability-inbound-routes.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load inbound routes"));
	const payload: unknown = await response.json();
	if (!isInboundRouteList(payload)) throw new Error("Inbound routes returned an invalid response");
	inboundRouteList.replaceChildren(
		...payload.routes.map((route) => {
			const card = document.createElement("div");
			card.className = "card capability-connection-card";
			appendText(card, route.id);
			appendText(
				card,
				`${route.destination.kind}:${route.destination.id} · ${route.enabled ? "enabled" : "disabled"}`,
				"capability-meta",
			);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "danger";
			remove.textContent = "Delete";
			remove.addEventListener(
				"click",
				() => void deleteWaveTwoConfiguration("capability-inbound-routes", route.id, loadInboundRoutes),
			);
			card.append(remove);
			return card;
		}),
	);
}

async function loadEverydayConfigurations(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/everyday-configurations.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load monitor configuration"));
	const payload: unknown = await response.json();
	if (!isEverydayConfigurationList(payload)) throw new Error("Everyday configuration returned an invalid response");
	siteMonitorList.replaceChildren(
		...payload.monitors.map((monitor) =>
			configurationCard(
				monitor.name,
				`${monitor.url} · ${monitor.enabled ? "enabled" : "disabled"}`,
				() =>
					void deleteWaveTwoConfiguration(
						"everyday-configurations/monitors",
						monitor.id,
						loadEverydayConfigurations,
					),
			),
		),
	);
	const financeReady = capabilitySnapshot?.capabilities.some(
		(capability) => capability.id === "finance.quotes" && capability.status === "active",
	);
	financeWatchlistList.replaceChildren(
		...payload.watchlists.map((watchlist) =>
			configurationCard(
				watchlist.name,
				`${watchlist.symbols.join(", ")} · ${watchlist.enabled ? "enabled" : "disabled"}${financeReady ? "" : " · quote provider unavailable"}`,
				() =>
					void deleteWaveTwoConfiguration(
						"everyday-configurations/watchlists",
						watchlist.id,
						loadEverydayConfigurations,
					),
			),
		),
	);
}

function configurationCard(name: string, description: string, removeAction: () => void): HTMLElement {
	const card = document.createElement("div");
	card.className = "card capability-connection-card";
	appendText(card, name);
	appendText(card, description, "capability-meta");
	const remove = document.createElement("button");
	remove.type = "button";
	remove.className = "danger";
	remove.textContent = "Delete";
	remove.addEventListener("click", removeAction);
	card.append(remove);
	return card;
}

async function deleteWaveTwoConfiguration(path: string, id: string, reload: () => Promise<void>): Promise<void> {
	if (!capabilityToken || !window.confirm(`Delete ${id}?`)) return;
	const response = await fetch(`/${path}/${encodeURIComponent(id)}?token=${encodeURIComponent(capabilityToken)}`, {
		method: "DELETE",
	});
	if (!response.ok) throw new Error(await responseError(response, `Could not delete ${id}`));
	await reload();
}

function isApprovalList(value: unknown): value is { approvals: CapabilityApprovalSummary[] } {
	return objectList(value, "approvals", ["id", "capabilityId", "target", "state", "expiresAt"]);
}

function isInboundRouteList(value: unknown): value is { routes: InboundRouteSummary[] } {
	return objectList(value, "routes", ["id", "connectionId", "destination"]);
}

function isEverydayConfigurationList(
	value: unknown,
): value is { monitors: SiteMonitorSummary[]; watchlists: FinanceWatchlistSummary[] } {
	return (
		objectList(value, "monitors", ["id", "name", "url", "enabled"]) &&
		objectList(value, "watchlists", ["id", "name", "symbols", "enabled"])
	);
}

function objectList(value: unknown, key: string, fields: string[]): boolean {
	if (typeof value !== "object" || value === null || !(key in value)) return false;
	const list = (value as Record<string, unknown>)[key];
	return (
		Array.isArray(list) &&
		list.every((entry) => typeof entry === "object" && entry !== null && fields.every((field) => field in entry))
	);
}

function ensureCapabilitySearch(): HTMLInputElement {
	const existing = document.getElementById("capability-search");
	if (existing instanceof HTMLInputElement) return existing;
	const label = document.createElement("label");
	label.textContent = "Find capabilities";
	const input = document.createElement("input");
	input.id = "capability-search";
	input.type = "search";
	input.placeholder = "Search capabilities and providers";
	input.addEventListener("input", () => {
		if (capabilitySearchTimer !== undefined) window.clearTimeout(capabilitySearchTimer);
		capabilitySearchTimer = window.setTimeout(() => {
			capabilitySearchTimer = undefined;
			void loadCapabilities().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		}, 150);
	});
	label.append(input);
	element("capability-list").before(label);
	return input;
}

async function changePlugin(action: "install" | "update" | "remove", source: string, scope: string): Promise<void> {
	if (!capabilityToken || !source) return;
	if (!window.confirm(`${action[0]?.toUpperCase()}${action.slice(1)} plugin ${source}?`)) return;
	const response = await fetch(`/plugins/${action}?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source, scope: scope === "project" ? "project" : "user", approved: true }),
	});
	if (!response.ok) throw new Error(await responseError(response, `Could not ${action} plugin`));
	await loadCapabilities();
	setStatus(`Plugin ${action} complete`);
}

function isCapabilitySnapshot(value: unknown): value is CapabilitySnapshot {
	if (typeof value !== "object" || value === null) return false;
	return (
		["tools", "skills", "extensions", "plugins", "mcpServers", "acpConnections", "modelProviders"].every(
			(key) => key in value && Array.isArray(value[key as keyof typeof value]),
		) &&
		"broker" in value &&
		typeof value.broker === "object" &&
		value.broker !== null &&
		"capabilities" in value.broker &&
		Array.isArray(value.broker.capabilities) &&
		"providers" in value.broker &&
		Array.isArray(value.broker.providers)
	);
}

function renderBrokeredCapabilities(broker: CapabilitySnapshot["broker"], query: string): HTMLElement[] {
	const grants = selectedAgentCapabilities();
	const capabilities = broker.capabilities.filter((capability) =>
		[capability.name, capability.description, capability.category, capability.id].some((value) =>
			value.toLowerCase().includes(query),
		),
	);
	const providers = broker.providers.filter((provider) =>
		[provider.name, provider.source, provider.id].some((value) => value.toLowerCase().includes(query)),
	);
	const capabilitySection = document.createElement("details");
	capabilitySection.className = "capability-section";
	capabilitySection.open = true;
	const capabilityHeading = document.createElement("summary");
	capabilityHeading.innerHTML = `<strong>Agent capabilities</strong><span class="capability-count">${capabilities.length}</span>`;
	capabilitySection.append(capabilityHeading);
	for (const capability of capabilities) {
		const card = document.createElement("details");
		card.className = "card capability-card";
		const summary = document.createElement("summary");
		const grant = document.createElement("label");
		grant.className = "capability-grant";
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.checked = grants.some((entry) => entry.capabilityId === capability.id);
		const defaultProvider = broker.providers.find((provider) => provider.id === capability.defaultProviderId);
		const connectionReady =
			!defaultProvider?.connectionRequired ||
			capabilityConnections.some(
				(connection) =>
					connection.status === "active" &&
					connection.providerId === defaultProvider.id &&
					connection.capabilityIds.includes(capability.id),
			);
		checkbox.disabled = capability.status !== "active" || !connectionReady;
		checkbox.title =
			capability.status !== "active"
				? "Review and enable a healthy provider first"
				: !connectionReady
					? "Configure an active provider account with this grant"
					: "Grant capability";
		checkbox.addEventListener("change", () => updateAgentCapabilityGrant(capability, checkbox.checked));
		checkbox.addEventListener("click", (event) => event.stopPropagation());
		const label = document.createElement("span");
		label.textContent = capability.name;
		grant.append(checkbox, label);
		const state = document.createElement("span");
		state.className = "capability-status";
		state.textContent = capability.status;
		summary.append(grant, state);
		const body = document.createElement("div");
		body.className = "capability-body";
		appendText(body, capability.description, "muted");
		appendText(
			body,
			`${capability.category} · ${capability.effect} · ${capability.defaultProviderId ?? "no default provider"}`,
			"capability-meta",
		);
		const availableProviders = capability.providers
			.map((id) => broker.providers.find((provider) => provider.id === id))
			.filter((provider): provider is CapabilityProvider => provider?.enabled === true);
		if (availableProviders.length > 0) {
			const providerLabel = document.createElement("label");
			providerLabel.textContent = "Default provider";
			const providerSelect = document.createElement("select");
			for (const provider of availableProviders) {
				const option = document.createElement("option");
				option.value = provider.id;
				option.textContent = `${provider.name} · ${provider.health}`;
				option.selected = provider.id === capability.defaultProviderId;
				providerSelect.append(option);
			}
			providerSelect.addEventListener(
				"change",
				() => void changeDefaultCapabilityProvider(capability.id, providerSelect.value),
			);
			providerLabel.append(providerSelect);
			body.append(providerLabel);
		}
		card.append(summary, body);
		capabilitySection.append(card);
	}

	const providerSection = document.createElement("details");
	providerSection.className = "capability-section";
	const providerHeading = document.createElement("summary");
	providerHeading.innerHTML = `<strong>Providers</strong><span class="capability-count">${providers.length}</span>`;
	providerSection.append(providerHeading);
	for (const provider of providers) {
		const card = document.createElement("details");
		card.className = "card capability-card";
		const summary = document.createElement("summary");
		summary.textContent = `${provider.name} · ${provider.trust}`;
		const body = document.createElement("div");
		body.className = "capability-body";
		appendText(body, `${provider.source}@${provider.version}`, "muted");
		appendText(body, `Health: ${provider.health}`, "capability-meta");
		appendText(body, `Permissions: ${provider.permissions.join(", ")}`, "capability-meta");
		if (provider.missingTools.length > 0) appendText(body, `Missing: ${provider.missingTools.join(", ")}`, "muted");
		const actions = document.createElement("div");
		actions.className = "routine-actions";
		if (provider.trust === "quarantined" || provider.trust === "unreviewed") {
			actions.append(capabilityProviderButton("Review", () => changeCapabilityProvider(provider.id, "review")));
		} else if (provider.enabled) {
			actions.append(capabilityProviderButton("Disable", () => changeCapabilityProvider(provider.id, "disable")));
		} else {
			const enable = capabilityProviderButton("Enable", () => changeCapabilityProvider(provider.id, "enable"));
			enable.disabled = provider.health === "missing-tools";
			actions.append(enable);
		}
		body.append(actions);
		card.append(summary, body);
		providerSection.append(card);
	}
	return [capabilitySection, providerSection];
}

function capabilityProviderButton(label: string, action: () => void): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.addEventListener("click", action);
	return button;
}

async function changeCapabilityProvider(providerId: string, operation: "review" | "enable" | "disable"): Promise<void> {
	if (!capabilityToken || !window.confirm(`${operation} capability provider ${providerId}?`)) return;
	const response = await fetch(
		`/capability-providers/${encodeURIComponent(providerId)}/${operation}?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: true }) },
	);
	if (!response.ok) throw new Error(await responseError(response, `Could not ${operation} provider`));
	await loadCapabilities();
}

async function changeDefaultCapabilityProvider(capabilityId: string, providerId: string): Promise<void> {
	if (!capabilityToken || !window.confirm(`Use ${providerId} by default for ${capabilityId}?`)) return;
	const response = await fetch(
		`/capability-providers/${encodeURIComponent(providerId)}/default?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capabilityId, approved: true }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not change the default provider"));
	await loadCapabilities();
}

function selectedAgentCapabilities(): AgentCapabilityGrant[] {
	const value = requiredElement<HTMLInputElement>("agent-capabilities").value;
	if (!value) return [];
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("Agent capability grants are invalid");
	return parsed.filter(
		(entry): entry is AgentCapabilityGrant =>
			typeof entry === "object" &&
			entry !== null &&
			"capabilityId" in entry &&
			typeof entry.capabilityId === "string" &&
			"capabilityVersion" in entry &&
			typeof entry.capabilityVersion === "number",
	);
}

function updateAgentCapabilityGrant(capability: BrokeredCapability, enabled: boolean): void {
	const grants = selectedAgentCapabilities().filter((entry) => entry.capabilityId !== capability.id);
	if (enabled) {
		const connection = capabilityConnections.find(
			(entry) =>
				entry.status === "active" &&
				entry.providerId === capability.defaultProviderId &&
				entry.capabilityIds.includes(capability.id),
		);
		grants.push({
			capabilityId: capability.id,
			capabilityVersion: capability.version,
			providerId: capability.defaultProviderId,
			approval: capability.defaultApproval,
			connectionId: connection?.id,
		});
	}
	requiredElement<HTMLInputElement>("agent-capabilities").value = JSON.stringify(grants);
	updateBuilderCapabilitySummary();
}

function selectedAgentTools(): Set<string> {
	return new Set(
		requiredElement<HTMLInputElement>("agent-tools")
			.value.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function updateAgentToolGrant(tool: string, enabled: boolean): void {
	const tools = selectedAgentTools();
	if (enabled) tools.add(tool);
	else tools.delete(tool);
	requiredElement<HTMLInputElement>("agent-tools").value = [...tools].sort().join(",");
	updateBuilderCapabilitySummary();
}

function updateBuilderCapabilitySummary(): void {
	const summary = document.getElementById("agent-capability-summary");
	if (!summary) return;
	const count = selectedAgentCapabilities().length + selectedAgentTools().size;
	summary.textContent = `${count} selected`;
}

interface AgentSummary {
	id: string;
	revision: number;
	source: "managed" | "pi-agent";
	personaId?: string;
	name: string;
	description: string;
	tools: string[];
	capabilities: AgentCapabilityGrant[];
	memory: "none" | "notes";
	persona: string;
	executor: "session" | "harness";
	permissionPolicy: "read-only" | "workspace-write";
	model?: { provider: string; id: string };
	thinking?: ThinkingLevel;
	projectRoot: string;
	delegateAgentIds: string[];
	a2a: { enabled: boolean };
	browser?: {
		access: "disabled" | "loopback" | "public-web" | "private-network";
		runtime: "managed-chromium" | "installed-chrome";
		profile: { kind: "ephemeral" } | { kind: "named"; id: string };
	};
	browserWorkflows: Array<{ id: string; version: number }>;
	schedules: Array<{ id: string; prompt: string; intervalMinutes: number; enabled: boolean }>;
}

async function loadAgents(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/agents.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load agents: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isAgentList(payload)) throw new Error("Agent registry returned an invalid response");
	agents = payload.agents;
	for (let index = openAgentIds.length - 1; index >= 0; index -= 1) {
		if (!agents.some((agent) => agent.id === openAgentIds[index])) openAgentIds.splice(index, 1);
	}
	agentList.replaceChildren(
		...payload.agents.map((agent) => {
			const card = document.createElement("div");
			card.className = "agent-entry-card";
			const button = document.createElement("button");
			button.type = "button";
			button.className = "nav-item agent-entry";
			const icon = agent.personaId ? document.createElement("img") : document.createElement("span");
			icon.className = "agent-icon";
			if (icon instanceof HTMLImageElement) {
				icon.src = `/personas/${encodeURIComponent(agent.personaId ?? "")}/image?token=${encodeURIComponent(capabilityToken ?? "")}`;
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
			const menu = document.createElement("details");
			menu.className = "agent-menu";
			const menuButton = document.createElement("summary");
			menuButton.textContent = "⋯";
			menuButton.title = "Agent actions";
			const actions = document.createElement("div");
			const edit = document.createElement("button");
			edit.type = "button";
			edit.textContent = "Edit";
			edit.addEventListener("click", () => void openAgentBuilder(agent));
			const duplicate = document.createElement("button");
			duplicate.type = "button";
			duplicate.textContent = "Duplicate";
			duplicate.disabled = agent.source === "pi-agent";
			duplicate.addEventListener(
				"click",
				() => void openAgentBuilder({ ...agent, id: "", name: `${agent.name} copy`, revision: 0 }),
			);
			const remove = document.createElement("button");
			remove.type = "button";
			remove.textContent = "Delete";
			remove.className = "danger";
			remove.disabled = agent.source === "pi-agent";
			remove.addEventListener(
				"click",
				() =>
					void deleteAgent(agent).catch((error: unknown) =>
						setStatus(error instanceof Error ? error.message : String(error), true),
					),
			);
			actions.append(edit, duplicate, remove);
			menu.append(menuButton, actions);
			card.append(button, menu);
			return card;
		}),
	);
	refreshRoutineEditorOptions();
	refreshWorkflowEditorOptions();
	renderSessionNavigation();
}

async function deleteAgent(agent: AgentSummary): Promise<void> {
	if (!capabilityToken || !window.confirm(`Delete agent "${agent.name}"? Its project files will not be deleted.`))
		return;
	const response = await fetch(
		`/agents/${encodeURIComponent(agent.id)}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "DELETE",
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not delete agent"));
	if (activeSidebarAgent?.id === agent.id) {
		activeSidebarAgent = undefined;
		selectedAgentPanel.classList.add("hidden");
	}
	const openIndex = openAgentIds.indexOf(agent.id);
	if (openIndex >= 0) openAgentIds.splice(openIndex, 1);
	if (activeAgentId === agent.id) activeAgentId = undefined;
	await loadAgents();
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	setStatus("Agent deleted");
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
			"revision" in entry &&
			typeof entry.revision === "number" &&
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
			"projectRoot" in entry &&
			typeof entry.projectRoot === "string" &&
			"delegateAgentIds" in entry &&
			Array.isArray(entry.delegateAgentIds) &&
			"browserWorkflows" in entry &&
			Array.isArray(entry.browserWorkflows) &&
			entry.browserWorkflows.every(
				(workflow: unknown) =>
					typeof workflow === "object" &&
					workflow !== null &&
					"id" in workflow &&
					typeof workflow.id === "string" &&
					"version" in workflow &&
					typeof workflow.version === "number",
			) &&
			"a2a" in entry &&
			typeof entry.a2a === "object" &&
			entry.a2a !== null &&
			"schedules" in entry &&
			Array.isArray(entry.schedules),
	);
}

async function loadPersonas(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/personas.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) return;
	const payload: unknown = await response.json();
	if (!isPersonaList(payload)) throw new Error("Persona catalog returned an invalid response");
	personas = payload.personas;
	const selected = personaSelect.value;
	const custom = document.createElement("option");
	custom.value = "";
	custom.textContent = "Custom";
	personaSelect.replaceChildren(
		custom,
		...personas.map((persona) => {
			const option = document.createElement("option");
			option.value = persona.id;
			option.textContent = `${persona.name} · ${persona.category}`;
			return option;
		}),
	);
	if (personas.some((entry) => entry.id === selected)) personaSelect.value = selected;
	updatePersonaPreview();
}

function updatePersonaPreview(applyInstructions = false): void {
	const persona = personas.find((entry) => entry.id === personaSelect.value);
	if (applyInstructions && persona) requiredElement<HTMLTextAreaElement>("agent-persona").value = persona.instructions;
	personaImage.classList.toggle("hidden", !persona?.image);
	personaImage.src = persona?.image
		? `/personas/${encodeURIComponent(persona.id)}/image?token=${encodeURIComponent(capabilityToken ?? "")}`
		: "";
	personaImage.alt = persona ? persona.name : "";
}

function isPersonaList(value: unknown): value is { personas: PersonaSummary[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"personas" in value &&
		Array.isArray(value.personas) &&
		value.personas.every(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"id" in entry &&
				typeof entry.id === "string" &&
				"name" in entry &&
				typeof entry.name === "string" &&
				"instructions" in entry &&
				typeof entry.instructions === "string",
		)
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
	element("external-delegate").classList.remove("hidden");
	activateTab("agents-workspace");
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

function activePromptHistory(): PromptHistory | undefined {
	const key = builderActive ? builderSession?.id : activeAgentId ? `agent:${activeAgentId}` : session?.id;
	if (!key) return undefined;
	let history = promptHistoryBySession.get(key);
	if (!history) {
		history = { entries: [], index: 0, draft: "" };
		promptHistoryBySession.set(key, history);
	}
	return history;
}

function recordPromptHistory(text: string): void {
	if (!text) return;
	const history = activePromptHistory();
	if (!history) return;
	if (history.entries.at(-1) !== text) history.entries.push(text);
	if (history.entries.length > MAX_PROMPT_HISTORY)
		history.entries.splice(0, history.entries.length - MAX_PROMPT_HISTORY);
	history.index = history.entries.length;
	history.draft = "";
}

function navigatePromptHistory(direction: -1 | 1): boolean {
	const history = activePromptHistory();
	if (!history || history.entries.length === 0 || input.selectionStart !== input.selectionEnd) return false;
	const singleLine = !input.value.includes("\n");
	if (direction === -1 && !singleLine && input.selectionStart !== 0) return false;
	if (direction === 1 && !singleLine && input.selectionEnd !== input.value.length) return false;
	if (direction === -1) {
		if (history.index === history.entries.length) history.draft = input.value;
		if (history.index === 0) return false;
		history.index -= 1;
		input.value = history.entries[history.index] ?? "";
	} else {
		if (history.index >= history.entries.length) return false;
		history.index += 1;
		input.value = history.index === history.entries.length ? history.draft : (history.entries[history.index] ?? "");
	}
	input.setSelectionRange(input.value.length, input.value.length);
	resizeComposer();
	return true;
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
	if (!agent) {
		await openAgentBuilder();
		return;
	}
	activeSidebarAgent = agent;
	builderActive = false;
	activeAgentId = agent.id;
	activeSubagentKey = undefined;
	if (!openAgentIds.includes(agent.id)) openAgentIds.push(agent.id);
	selectedAgentTitle.textContent = agent.name;
	selectedAgentMeta.textContent = `${agent.model ? `${agent.model.provider}/${agent.model.id}` : "Current Pi model"} · ${formatWorkingDirectory(agent.projectRoot)}`;
	selectedAgentMeta.title = agent.projectRoot;
	selectedAgentPanel.classList.remove("hidden");
	activateTab("agents-workspace");
	mobilePanelNone.checked = true;
	renderSessionNavigation();
	await loadSelectedAgent();
}

function toggleSubagentInspector(key: string, item: Extract<TranscriptItem, { role: "tool" }>): void {
	if (openSubagentKeys.includes(key)) {
		closeSubagentTab(key);
		return;
	}
	subagentActivityByKey.set(key, { key, sessionId: session?.id ?? "", item });
	openSubagentKeys.push(key);
	openSubagentInspector(key);
}

function openSubagentInspector(key: string): void {
	const activity = subagentActivityByKey.get(key);
	if (!activity) return;
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = key;
	mobilePanelNone.checked = true;
	renderSubagentInspector(activity);
	renderSessionNavigation();
}

function closeSubagentTab(key: string): void {
	const index = openSubagentKeys.indexOf(key);
	if (index >= 0) openSubagentKeys.splice(index, 1);
	if (activeSubagentKey !== key) {
		renderSessionNavigation();
		return;
	}
	activeSubagentKey = undefined;
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

function renderSubagentInspector(activity: SubagentActivity): void {
	const { item } = activity;
	const heading = document.createElement("section");
	heading.className = "subagent-inspector-heading";
	const title = document.createElement("strong");
	title.textContent = subagentName(item.input);
	const state = document.createElement("span");
	state.textContent = item.status === "running" ? "Running" : item.status === "error" ? "Failed" : "Completed";
	const task = document.createElement("p");
	task.textContent = subagentTask(item.input);
	heading.append(title, state, task);
	const timeline = document.createElement("section");
	timeline.className = "subagent-timeline";
	const details = objectRecord(item.details);
	const results = Array.isArray(details?.results) ? details.results : [];
	for (const entry of results) {
		const result = objectRecord(entry);
		if (!result) continue;
		const agent = typeof result.agent === "string" ? result.agent : subagentName(item.input);
		const group = document.createElement("section");
		group.className = "subagent-result";
		const agentLabel = document.createElement("strong");
		agentLabel.textContent = agent;
		group.append(agentLabel);
		if (Array.isArray(result.messages)) appendSubagentMessages(group, result.messages);
		if (typeof result.errorMessage === "string") appendText(group, result.errorMessage, "run-error");
		timeline.append(group);
	}
	if (timeline.childElementCount === 0) {
		const starting = document.createElement("div");
		starting.className = "agent-running";
		starting.append(document.createElement("i"), document.createTextNode("Starting agent…"));
		timeline.append(starting);
	}
	transcript.replaceChildren(heading, timeline);
	transcript.scrollTop = transcript.scrollHeight;
	phase.textContent = item.status;
	input.disabled = true;
	input.placeholder = "Subagent inspector is read-only";
	send.disabled = true;
	model.disabled = true;
	modelPicker.refresh();
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	sessionStats.textContent = `${subagentName(item.input)} · ${item.status}`;
	sessionStats.title = "Observable subagent activity";
	setStatus("pi-coordinator delegation");
}

function appendSubagentMessages(parent: HTMLElement, messages: unknown[]): void {
	for (const entry of messages) {
		const message = objectRecord(entry);
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const contentEntry of message.content) {
				const part = objectRecord(contentEntry);
				if (part?.type === "text" && typeof part.text === "string") {
					const body = document.createElement("div");
					body.className = "agent-message-content";
					appendAgentMarkdown(body, part.text);
					parent.append(body);
				} else if (part?.type === "toolCall" && typeof part.name === "string") {
					parent.append(subagentEventDetails(`Using ${part.name}`, part.arguments));
				}
			}
		} else if (message.role === "toolResult" && typeof message.toolName === "string") {
			parent.append(subagentEventDetails(`Completed ${message.toolName}`, message.content));
		}
	}
}

function subagentEventDetails(label: string, value: unknown): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = "subagent-event";
	const summary = document.createElement("summary");
	summary.textContent = label;
	const pre = document.createElement("pre");
	pre.textContent = JSON.stringify(value, undefined, 2);
	details.append(summary, pre);
	return details;
}

function closeAgentTab(agentId: string): void {
	const index = openAgentIds.indexOf(agentId);
	if (index >= 0) openAgentIds.splice(index, 1);
	if (activeAgentId !== agentId) {
		renderSessionNavigation();
		return;
	}
	const fallbackId = openAgentIds.at(-1);
	const fallback = fallbackId ? agents.find((entry) => entry.id === fallbackId) : undefined;
	if (fallback) {
		void openAgent(fallback);
		return;
	}
	activeAgentId = undefined;
	activeSidebarAgent = undefined;
	selectedAgentPanel.classList.add("hidden");
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

async function openAgentBuilder(agent?: AgentSummary, showConversation = true): Promise<void> {
	activeSidebarAgent = agent;
	agentForm.reset();
	const catalogAgent = agent?.source === "pi-agent";
	for (const id of [
		"agent-name",
		"agent-description",
		"agent-project-root",
		"agent-persona-select",
		"agent-persona",
		"agent-model",
		"agent-thinking",
		"agent-executor",
		"agent-permissions",
		"agent-browser-access",
		"agent-browser-runtime",
		"agent-browser-profile-kind",
		"agent-browser-profile-id",
		"agent-delegates",
		"agent-a2a",
	]) {
		requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).disabled = catalogAgent;
	}
	requiredElement<HTMLInputElement>("agent-id").value = agent?.id ?? "";
	requiredElement<HTMLInputElement>("agent-name").value = agent?.name ?? "";
	requiredElement<HTMLTextAreaElement>("agent-description").value = agent?.description ?? "";
	requiredElement<HTMLInputElement>("agent-project-root").value = agent?.projectRoot ?? session?.snapshot?.cwd ?? "";
	personaSelect.value = agent?.personaId ?? "";
	requiredElement<HTMLTextAreaElement>("agent-persona").value = agent?.persona ?? "";
	requiredElement<HTMLInputElement>("agent-tools").value = agent?.tools.join(",") ?? "";
	requiredElement<HTMLInputElement>("agent-capabilities").value = JSON.stringify(agent?.capabilities ?? []);
	updateBuilderCapabilitySummary();
	requiredElement<HTMLSelectElement>("agent-memory").value = agent?.memory ?? "none";
	requiredElement<HTMLSelectElement>("agent-executor").value = agent?.executor ?? "harness";
	requiredElement<HTMLSelectElement>("agent-permissions").value = agent?.permissionPolicy ?? "read-only";
	requiredElement<HTMLSelectElement>("agent-browser-access").value = agent?.browser?.access ?? "disabled";
	requiredElement<HTMLSelectElement>("agent-browser-runtime").value = agent?.browser?.runtime ?? "managed-chromium";
	requiredElement<HTMLSelectElement>("agent-browser-profile-kind").value = agent?.browser?.profile.kind ?? "ephemeral";
	requiredElement<HTMLInputElement>("agent-browser-profile-id").value =
		agent?.browser?.profile.kind === "named" ? agent.browser.profile.id : "";
	updateAgentBrowserProfileFields();
	requiredElement<HTMLInputElement>("agent-browser-workflows").value =
		agent?.browserWorkflows.map((workflow) => `${workflow.id}@${workflow.version}`).join(",") ?? "";
	renderAgentBrowserWorkflowGrants();
	requiredElement<HTMLSelectElement>("agent-thinking").value = agent?.thinking ?? "high";
	requiredElement<HTMLInputElement>("agent-delegates").value = agent?.delegateAgentIds.join(", ") ?? "";
	requiredElement<HTMLInputElement>("agent-a2a").checked = agent?.a2a.enabled ?? false;
	const recommendedModelValue = `${recommendedAgentModel.provider}/${recommendedAgentModel.id}`;
	agentModel.value = agent
		? agent.model
			? `${agent.model.provider}/${agent.model.id}`
			: ""
		: availableModels.some(
					(entry) => entry.provider === recommendedAgentModel.provider && entry.id === recommendedAgentModel.id,
				)
			? recommendedModelValue
			: "";
	agentModelPicker.refresh();
	updatePersonaPreview();
	element("builder-title").textContent = agent
		? catalogAgent
			? `${agent.name} · Pi agent catalog`
			: agent.name
		: "Build a new agent";
	builderLabel = agent ? `Edit ${agent.name}` : "Agent Builder";
	activateTab("agent-builder");
	activateBuilderTab("builder-profile-panel");
	await closeBuilderChat(false);
	if (!client) return;
	builderSession = await client.createSession({ name: agent ? `builder:${agent.id}` : "builder:new" });
	builderActive = showConversation;
	if (showConversation) {
		activeAgentId = undefined;
		activeSubagentKey = undefined;
	}
	unsubscribeBuilder = builderSession.subscribe((snapshot) => {
		if (builderActive) renderBuilderConversation(snapshot);
	});
	if (showConversation && builderSession.snapshot) renderBuilderConversation(builderSession.snapshot);
	if (showConversation) mobilePanelNone.checked = true;
	renderSessionNavigation();
	await loadCapabilities().catch(() => {});
}

function openBuilderChat(): void {
	if (!builderSession?.snapshot) return;
	builderActive = true;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activateTab("agent-builder");
	mobilePanelNone.checked = true;
	renderBuilderConversation(builderSession.snapshot);
	renderSessionNavigation();
}

async function closeBuilderChat(restoreMainChat = true): Promise<void> {
	const closingSession = builderSession;
	builderSession = undefined;
	builderActive = false;
	unsubscribeBuilder?.();
	unsubscribeBuilder = undefined;
	if (closingSession && closingSession.snapshot?.phase !== "idle") await closingSession.abort().catch(() => {});
	await closingSession?.dispose().catch(() => {});
	if (!restoreMainChat) {
		renderSessionNavigation();
		return;
	}
	activeSidebarAgent = undefined;
	activateTab("agents-workspace");
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

async function loadSelectedAgent(): Promise<void> {
	if (!capabilityToken || !activeSidebarAgent) return;
	const agent = activeSidebarAgent;
	const conversationsResponse = await fetch(
		`/agent-conversations.json?agentId=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!conversationsResponse.ok)
		throw new Error(await responseError(conversationsResponse, "Could not load agent conversation"));
	const conversationsPayload: unknown = await conversationsResponse.json();
	const conversationId = conversationIdFromPayload(conversationsPayload);
	let messages: AgentMessageSummary[] = [];
	if (conversationId) {
		const messagesResponse = await fetch(
			`/agent-conversations/${encodeURIComponent(conversationId)}/messages?token=${encodeURIComponent(capabilityToken)}`,
		);
		if (!messagesResponse.ok) throw new Error(await responseError(messagesResponse, "Could not load agent messages"));
		const payload: unknown = await messagesResponse.json();
		messages = messagesFromPayload(payload);
	}
	if (conversationId) agentConversationIds.set(agent.id, conversationId);
	else agentConversationIds.delete(agent.id);
	const tasks = await loadAgentTasks(agent);
	if (activeAgentId === agent.id) renderAgentConversation(agent, messages, tasks);
}

function renderAgentConversation(
	agent: AgentSummary,
	messages: AgentMessageSummary[],
	tasks: AgentTaskSummary[],
): void {
	const activeTask = tasks.find((task) => task.status === "queued" || task.status === "running");
	const items = messages.map((message) => renderAgentMessage(agent, message));
	if (activeTask) {
		const running = document.createElement("article");
		running.className = "message assistant agent-running";
		const dot = document.createElement("i");
		const label = document.createElement("span");
		label.textContent = `${agent.name} is working`;
		running.append(dot, label);
		items.push(running);
	}
	transcript.replaceChildren(...items);
	transcript.scrollTop = transcript.scrollHeight;
	phase.textContent = activeTask?.status ?? "idle";
	send.classList.toggle("is-stopping", Boolean(activeTask));
	send.setAttribute("aria-label", activeTask ? `Stop ${agent.name}` : `Message ${agent.name}`);
	input.placeholder = `Message ${agent.name}…`;
	input.disabled = false;
	send.disabled = false;
	input.setAttribute("aria-label", `Message ${agent.name}`);
	model.disabled = true;
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	attachmentButton.title = "Agent chat attachments are not available yet";
	attachmentList.replaceChildren();
	const selectedModel = agent.model ?? session?.snapshot?.model;
	if (selectedModel) {
		model.value = `${selectedModel.provider}/${selectedModel.id}`;
		modelPicker.refresh();
	}
	thinking.value = agent.thinking ?? session?.snapshot?.thinkingLevel ?? "off";
	sessionPath.textContent = formatWorkingDirectory(agent.projectRoot);
	sessionPath.title = agent.projectRoot;
	sessionStats.textContent = activeTask ? `${agent.name} · ${activeTask.status}` : agent.name;
	sessionStats.title = "Active agent conversation";
	setStatus(activeTask ? `${agent.name} is running a task` : agent.projectRoot);
}

function renderAgentMessage(agent: AgentSummary, message: AgentMessageSummary): HTMLElement {
	const article = document.createElement("article");
	article.className = `message ${message.role === "agent" ? "assistant" : "user"}`;
	const label = document.createElement("div");
	label.className = "message-label";
	label.textContent = message.role === "agent" ? agent.name : "you";
	const body = document.createElement("div");
	body.className = "agent-message-content";
	appendAgentMarkdown(body, message.text);
	article.append(label, body);
	return article;
}

function appendAgentMarkdown(parent: HTMLElement, text: string): void {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let code: string[] | undefined;
	let list: HTMLUListElement | HTMLOListElement | undefined;
	const flushCode = () => {
		if (!code) return;
		const pre = document.createElement("pre");
		const codeElement = document.createElement("code");
		codeElement.textContent = code.join("\n");
		pre.append(codeElement);
		parent.append(pre);
		code = undefined;
	};
	for (const line of lines) {
		if (line.trim().startsWith("```")) {
			if (code) flushCode();
			else code = [];
			list = undefined;
			continue;
		}
		if (code) {
			code.push(line);
			continue;
		}
		const listMatch = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
		if (listMatch) {
			const ordered = listMatch[1]?.endsWith(".") ?? false;
			if (
				!list ||
				(ordered && !(list instanceof HTMLOListElement)) ||
				(!ordered && !(list instanceof HTMLUListElement))
			) {
				list = ordered ? document.createElement("ol") : document.createElement("ul");
				parent.append(list);
			}
			const item = document.createElement("li");
			appendAgentInline(item, listMatch[2] ?? "");
			list.append(item);
			continue;
		}
		list = undefined;
		if (!line.trim()) continue;
		const heading = line.match(/^(#{1,3})\s+(.+)$/);
		const block = heading
			? document.createElement(heading[1]?.length === 1 ? "h2" : "h3")
			: document.createElement("p");
		appendAgentInline(block, heading?.[2] ?? line);
		parent.append(block);
	}
	flushCode();
}

function appendAgentInline(parent: HTMLElement, text: string): void {
	const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
	let offset = 0;
	for (const match of text.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > offset) parent.append(document.createTextNode(text.slice(offset, index)));
		if (match[2]) {
			const strong = document.createElement("strong");
			strong.textContent = match[2];
			parent.append(strong);
		} else if (match[3]) {
			const code = document.createElement("code");
			code.textContent = match[3];
			parent.append(code);
		} else {
			const link = document.createElement("a");
			link.textContent = match[4] ?? match[5] ?? "link";
			link.href = match[5] ?? "";
			link.target = "_blank";
			link.rel = "noreferrer";
			parent.append(link);
		}
		offset = index + match[0].length;
	}
	if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

function conversationIdFromPayload(value: unknown): string | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!("conversations" in value) ||
		!Array.isArray(value.conversations)
	)
		return undefined;
	const first = value.conversations[0];
	return typeof first === "object" && first !== null && "id" in first && typeof first.id === "string"
		? first.id
		: undefined;
}

function messagesFromPayload(value: unknown): AgentMessageSummary[] {
	if (typeof value !== "object" || value === null || !("messages" in value) || !Array.isArray(value.messages))
		return [];
	return value.messages.filter(isAgentMessageSummary);
}

function isAgentMessageSummary(value: unknown): value is AgentMessageSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"conversationId" in value &&
		typeof value.conversationId === "string" &&
		"role" in value &&
		(value.role === "user" || value.role === "agent") &&
		"text" in value &&
		typeof value.text === "string" &&
		"taskId" in value &&
		typeof value.taskId === "string" &&
		"createdAt" in value &&
		typeof value.createdAt === "number"
	);
}

async function loadAgentTasks(agent: AgentSummary): Promise<AgentTaskSummary[]> {
	if (!capabilityToken) return [];
	const response = await fetch(
		`/agent-tasks.json?agentId=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(`Could not load agent tasks: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isAgentTaskList(payload)) throw new Error("Agent task service returned an invalid response");
	agentTasksByAgent.set(agent.id, payload.tasks);
	if (activeSidebarAgent?.id === agent.id) renderAgentTaskHistory(payload.tasks);
	return payload.tasks;
}

function renderAgentTaskHistory(tasks: AgentTaskSummary[]): void {
	agentTaskList.replaceChildren(
		...tasks.slice(0, 20).map((task) => {
			const details = document.createElement("details");
			details.className = "agent-history-entry";
			details.dataset.status = task.status;
			const summary = document.createElement("summary");
			const indicator = document.createElement("i");
			indicator.className = "agent-history-status";
			const prompt = document.createElement("span");
			prompt.className = "agent-history-prompt";
			prompt.textContent = task.prompt;
			const time = document.createElement("time");
			time.className = "agent-history-time";
			time.dateTime = new Date(task.createdAt).toISOString();
			time.textContent = task.status;
			summary.append(indicator, prompt, time);
			const body = document.createElement("div");
			body.className = "agent-history-body";
			if (task.result) appendText(body, task.result);
			if (task.error) appendText(body, task.error, "run-error");
			if (task.status === "failed" || task.status === "cancelled") {
				const retry = document.createElement("button");
				retry.type = "button";
				retry.textContent = "Retry";
				retry.addEventListener("click", () => {
					void continueAgentTask(task.id, task.prompt).catch((error: unknown) =>
						setStatus(error instanceof Error ? error.message : String(error), true),
					);
				});
				body.append(retry);
			}
			details.append(summary, body);
			return details;
		}),
	);
}

function isAgentTaskList(value: unknown): value is { tasks: AgentTaskSummary[] } {
	if (typeof value !== "object" || value === null || !("tasks" in value) || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"agentId" in entry &&
			typeof entry.agentId === "string" &&
			"prompt" in entry &&
			typeof entry.prompt === "string" &&
			"conversationId" in entry &&
			typeof entry.conversationId === "string" &&
			"status" in entry &&
			["queued", "running", "completed", "failed", "cancelled"].includes(String(entry.status)) &&
			"createdAt" in entry &&
			typeof entry.createdAt === "number" &&
			(!("error" in entry) || entry.error === undefined || typeof entry.error === "string"),
	);
}

async function cancelAgentTask(taskId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/agent-tasks/${encodeURIComponent(taskId)}/cancel?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
		},
	);
	if (!response.ok) throw new Error(`Could not stop task: HTTP ${response.status}`);
	await loadSelectedAgent();
}

async function continueAgentTask(taskId: string, message: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/agent-tasks/${encodeURIComponent(taskId)}/continue?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not continue task"));
	await loadSelectedAgent();
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
	cron: string;
	timezone: string;
	maxDurationMinutes: number;
	target:
		| { kind: "agent"; agentId: string }
		| { kind: "workflow"; workflowId: string }
		| {
				kind: "browser-workflow";
				workflowId: string;
				workflowVersion: number;
				parameters: Record<string, string | number | boolean>;
		  }
		| { kind: "acp"; connectionId: string }
		| { kind: "skill"; skillName: string };
	model?: { provider: string; id: string };
	cwd?: string;
	nextRunAt?: number;
	lastRunAt?: number;
	lastRunId?: string;
	activeRunId?: string;
	lastError?: string;
	availabilityError?: string;
}

let routines: RoutineSummary[] = [];

function routineTargetLabel(routine: RoutineSummary): string {
	switch (routine.target.kind) {
		case "agent": {
			const agentId = routine.target.agentId;
			return `Agent · ${agents.find((agent) => agent.id === agentId)?.name ?? agentId}`;
		}
		case "workflow": {
			const workflowId = routine.target.workflowId;
			return `Workflow · ${workflows.find((entry) => entry.id === workflowId)?.name ?? workflowId}`;
		}
		case "browser-workflow": {
			const workflowId = routine.target.workflowId;
			return `Browser · ${recordedBrowserWorkflows.find((entry) => entry.id === workflowId)?.name ?? workflowId} · v${routine.target.workflowVersion}`;
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
	const selectedWorkflow = routineEditor.workflow.value;
	routineEditor.workflow.replaceChildren(
		...workflows.map((entry) => {
			const option = document.createElement("option");
			option.value = entry.id;
			option.textContent = entry.name;
			return option;
		}),
	);
	if (workflows.some((entry) => entry.id === selectedWorkflow)) routineEditor.workflow.value = selectedWorkflow;
	const selectedBrowserWorkflow = routineEditor.browserWorkflow.value;
	routineEditor.browserWorkflow.replaceChildren(
		...recordedBrowserWorkflows
			.filter((entry) => entry.status === "active")
			.map((entry) => {
				const option = document.createElement("option");
				option.value = `${entry.id}@${entry.version}`;
				option.textContent = `${entry.name} · v${entry.version}`;
				return option;
			}),
	);
	if (
		recordedBrowserWorkflows.some(
			(entry) => `${entry.id}@${entry.version}` === selectedBrowserWorkflow && entry.status === "active",
		)
	) {
		routineEditor.browserWorkflow.value = selectedBrowserWorkflow;
	}
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
	routineEditor.workflowLabel.classList.toggle("hidden", kind !== "workflow");
	routineEditor.browserWorkflowLabel.classList.toggle("hidden", kind !== "browser-workflow");
	routineEditor.browserParametersLabel.classList.toggle("hidden", kind !== "browser-workflow");
	routineEditor.acpLabel.classList.toggle("hidden", kind !== "acp");
	routineEditor.skillLabel.classList.toggle("hidden", kind !== "skill");
	routineEditor.cwdLabel.classList.toggle(
		"hidden",
		kind === "agent" || kind === "workflow" || kind === "browser-workflow",
	);
	refreshRoutineModels("");
}

function updateRoutineCronFromPreset(): void {
	const [hourText = "9", minuteText = "0"] = routineEditor.time.value.split(":");
	const minute = Number(minuteText);
	const hour = Number(hourText);
	switch (routineEditor.preset.value) {
		case "hourly":
			routineEditor.cron.value = `${minute} * * * *`;
			break;
		case "daily":
			routineEditor.cron.value = `${minute} ${hour} * * *`;
			break;
		case "weekly":
			routineEditor.cron.value = `${minute} ${hour} * * 1`;
			break;
		case "weekdays":
			routineEditor.cron.value = `${minute} ${hour} * * 1-5`;
			break;
	}
	routineEditor.cron.disabled = routineEditor.preset.value !== "custom";
	routineEditor.time.disabled = routineEditor.preset.value === "custom";
	void refreshRoutinePreview();
}

async function refreshRoutinePreview(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/routines/preview?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ cron: routineEditor.cron.value, timezone: routineEditor.timezone.value }),
	});
	if (!response.ok) {
		routineEditor.preview.textContent = await responseError(response, "Invalid schedule");
		return;
	}
	const payload: unknown = await response.json();
	if (typeof payload !== "object" || payload === null || !("next" in payload) || !Array.isArray(payload.next)) return;
	routineEditor.preview.textContent = payload.next
		.filter((entry): entry is number => typeof entry === "number")
		.map((entry) => new Date(entry).toLocaleString())
		.join(" · ");
}

function clearRoutineEditor(): void {
	routineEditor.form.reset();
	routineEditor.id.value = "";
	routineEditor.cron.value = "0 9 * * 1-5";
	routineEditor.preset.value = "weekdays";
	routineEditor.time.value = "09:00";
	routineEditor.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
	routineEditor.maxDuration.value = "60";
	routineEditor.browserParameters.value = "{}";
	routineEditor.deleteButton.disabled = true;
	routineEditor.runButton.disabled = true;
	element("routine-editor-title").textContent = "New routine";
	routineList.querySelectorAll(".routine-card").forEach((card) => {
		card.classList.remove("active");
	});
	updateRoutineTargetFields();
	updateRoutineCronFromPreset();
}

function editRoutine(routine: RoutineSummary): void {
	routineEditor.id.value = routine.id;
	routineEditor.name.value = routine.name;
	routineEditor.prompt.value = routine.prompt;
	routineEditor.enabled.checked = routine.enabled;
	routineEditor.cron.value = routine.cron;
	routineEditor.preset.value = "custom";
	routineEditor.timezone.value = routine.timezone;
	routineEditor.maxDuration.value = String(routine.maxDurationMinutes);
	updateRoutineCronFromPreset();
	routineEditor.targetKind.value = routine.target.kind;
	if (routine.target.kind === "agent") routineEditor.agent.value = routine.target.agentId;
	else if (routine.target.kind === "workflow") routineEditor.workflow.value = routine.target.workflowId;
	else if (routine.target.kind === "browser-workflow") {
		routineEditor.browserWorkflow.value = `${routine.target.workflowId}@${routine.target.workflowVersion}`;
		routineEditor.browserParameters.value = JSON.stringify(routine.target.parameters, null, 2);
	} else if (routine.target.kind === "acp") routineEditor.acp.value = routine.target.connectionId;
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
			appendText(
				state,
				routine.availabilityError
					? "Unavailable"
					: routine.activeRunId
						? "Running"
						: routine.enabled
							? "Active"
							: "Paused",
				"routine-target",
			);
			const menu = document.createElement("details");
			menu.className = "routine-menu";
			const summary = document.createElement("summary");
			summary.textContent = "⋯";
			summary.title = "Routine actions";
			const actions = document.createElement("div");
			const run = document.createElement("button");
			run.type = "button";
			run.textContent = "Run now";
			run.disabled = routine.activeRunId !== undefined || routine.availabilityError !== undefined;
			run.addEventListener("click", (event) => {
				event.stopPropagation();
				void runRoutine(routine.id).catch((error: unknown) =>
					setStatus(error instanceof Error ? error.message : String(error), true),
				);
			});
			const toggle = document.createElement("button");
			toggle.type = "button";
			toggle.textContent = routine.enabled ? "Pause" : "Resume";
			toggle.addEventListener("click", (event) => {
				event.stopPropagation();
				void setRoutineEnabled(routine, !routine.enabled).catch((error: unknown) =>
					setStatus(error instanceof Error ? error.message : String(error), true),
				);
			});
			const duplicate = document.createElement("button");
			duplicate.type = "button";
			duplicate.textContent = "Duplicate";
			duplicate.addEventListener("click", (event) => {
				event.stopPropagation();
				editRoutine(routine);
				routineEditor.id.value = "";
				routineEditor.name.value = `${routine.name} copy`;
				routineEditor.deleteButton.disabled = true;
				routineEditor.runButton.disabled = true;
			});
			actions.append(run, toggle, duplicate);
			menu.append(summary, actions);
			state.append(menu);
			card.append(state);
			appendText(card, routineTargetLabel(routine), "routine-target");
			appendText(
				card,
				routine.nextRunAt
					? `${routine.cron} · ${routine.timezone} · next ${new Date(routine.nextRunAt).toLocaleString()}`
					: `${routine.cron} · ${routine.timezone}`,
				"muted",
			);
			appendText(card, routine.prompt, "muted");
			if (routine.lastError) appendText(card, routine.lastError, "run-error");
			if (routine.availabilityError) appendText(card, routine.availabilityError, "run-error");
			card.addEventListener("click", () => editRoutine(routine));
			return card;
		}),
	);
	const selected = routines.find((routine) => routine.id === routineEditor.id.value);
	if (selected) editRoutine(selected);
}

async function runRoutine(id: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/routines/${encodeURIComponent(id)}/run?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not start routine"));
	await loadRoutines();
}

async function setRoutineEnabled(routine: RoutineSummary, enabled: boolean): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/routines/${encodeURIComponent(routine.id)}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: routine.name,
				prompt: routine.prompt,
				enabled,
				cron: routine.cron,
				timezone: routine.timezone,
				maxDurationMinutes: routine.maxDurationMinutes,
				target: routine.target,
				model: routine.model,
				cwd: routine.cwd,
			}),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not update routine"));
	await loadRoutines();
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
			!("cron" in entry) ||
			typeof entry.cron !== "string" ||
			!("timezone" in entry) ||
			typeof entry.timezone !== "string" ||
			!("maxDurationMinutes" in entry) ||
			typeof entry.maxDurationMinutes !== "number" ||
			!("target" in entry) ||
			typeof entry.target !== "object" ||
			entry.target === null ||
			!("kind" in entry.target)
		) {
			return false;
		}
		return (
			entry.target.kind === "agent" ||
			entry.target.kind === "workflow" ||
			entry.target.kind === "browser-workflow" ||
			entry.target.kind === "acp" ||
			entry.target.kind === "skill"
		);
	});
}

interface WorkflowSummary {
	id: string;
	name: string;
	pattern: "sequential" | "parallel" | "supervisor";
	nodes: Array<{ id: string; agentId: string; prompt: string }>;
	edges: Array<{ from: string; to: string }>;
	supervisorAgentId?: string;
	maxConcurrency: number;
	maxDelegationDepth: number;
	failurePolicy: "stop" | "continue" | "supervisor-decides";
}

interface WorkflowRunSummary {
	id: string;
	workflowId: string;
	status: "running" | "completed" | "failed" | "cancelled";
	prompt: string;
	createdAt: number;
	result?: string;
	error?: string;
}

let workflows: WorkflowSummary[] = [];
let workflowRuns: WorkflowRunSummary[] = [];

function refreshWorkflowEditorOptions(): void {
	const selected = workflowEditor.supervisor.value;
	const none = document.createElement("option");
	none.value = "";
	none.textContent = "None";
	workflowEditor.supervisor.replaceChildren(
		none,
		...agents.map((agent) => {
			const option = document.createElement("option");
			option.value = agent.id;
			option.textContent = agent.name;
			return option;
		}),
	);
	if (agents.some((agent) => agent.id === selected)) workflowEditor.supervisor.value = selected;
	refreshRoutineEditorOptions();
}

function clearWorkflowEditor(): void {
	workflowEditor.form.reset();
	workflowEditor.id.value = "";
	workflowEditor.nodes.value = "[]";
	workflowEditor.edges.value = "[]";
	workflowEditor.maxConcurrency.value = "4";
	workflowEditor.maxDepth.value = "4";
	workflowEditor.deleteButton.disabled = true;
	workflowEditor.runButton.disabled = true;
	element("workflow-editor-title").textContent = "New workflow";
}

function editWorkflow(workflow: WorkflowSummary): void {
	element("workflow-editor-title").closest<HTMLDetailsElement>("details")!.open = true;
	workflowEditor.id.value = workflow.id;
	workflowEditor.name.value = workflow.name;
	workflowEditor.pattern.value = workflow.pattern;
	workflowEditor.nodes.value = JSON.stringify(workflow.nodes, null, 2);
	workflowEditor.edges.value = JSON.stringify(workflow.edges, null, 2);
	workflowEditor.supervisor.value = workflow.supervisorAgentId ?? "";
	workflowEditor.maxConcurrency.value = String(workflow.maxConcurrency);
	workflowEditor.maxDepth.value = String(workflow.maxDelegationDepth);
	workflowEditor.failurePolicy.value = workflow.failurePolicy;
	workflowEditor.deleteButton.disabled = false;
	workflowEditor.runButton.disabled = workflowRuns.some(
		(run) => run.workflowId === workflow.id && run.status === "running",
	);
	element("workflow-editor-title").textContent = workflow.name;
}

async function loadWorkflows(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/workflows.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load workflows"));
	const payload: unknown = await response.json();
	if (!isWorkflowPayload(payload)) throw new Error("Workflow service returned an invalid response");
	workflows = payload.workflows;
	workflowRuns = payload.runs;
	workflowList.replaceChildren(
		...workflows.map((workflow) => {
			const card = document.createElement("button");
			card.type = "button";
			card.className = "card routine-card";
			appendText(card, workflow.name);
			appendText(card, `${workflow.pattern} · ${workflow.nodes.length} agents`, "muted");
			const latest = workflowRuns.find((run) => run.workflowId === workflow.id);
			if (latest)
				appendText(card, latest.error ?? latest.result ?? latest.status, latest.error ? "run-error" : "muted");
			card.addEventListener("click", () => editWorkflow(workflow));
			return card;
		}),
	);
	refreshWorkflowEditorOptions();
	const selected = workflows.find((workflow) => workflow.id === workflowEditor.id.value);
	if (selected) editWorkflow(selected);
}

function isWorkflowPayload(value: unknown): value is { workflows: WorkflowSummary[]; runs: WorkflowRunSummary[] } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("workflows" in value) ||
		!Array.isArray(value.workflows) ||
		!("runs" in value) ||
		!Array.isArray(value.runs)
	) {
		return false;
	}
	return value.workflows.every(
		(entry) =>
			typeof entry === "object" &&
			entry !== null &&
			"id" in entry &&
			typeof entry.id === "string" &&
			"name" in entry &&
			typeof entry.name === "string" &&
			"nodes" in entry &&
			Array.isArray(entry.nodes),
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
			} else setStatus(`Reconnected to ${entry.label}`);
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
	if (activeSubagentKey) return;
	if (builderActive) {
		await submitBuilderComposer();
		return;
	}
	if (activeAgentId) {
		await submitAgentComposer(activeAgentId);
		return;
	}
	if (!session) return;
	if (session.snapshot?.phase !== "idle") {
		await session.abort();
		return;
	}
	const text = input.value.trim();
	const attachments = [...activeAttachments()];
	if (!text && attachments.length === 0) return;
	recordPromptHistory(text);
	input.value = "";
	resizeComposer();
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
}

async function submitBuilderComposer(): Promise<void> {
	const chatSession = builderSession;
	if (!chatSession) return;
	if (chatSession.snapshot?.phase !== "idle") {
		await chatSession.abort();
		return;
	}
	const prompt = input.value.trim();
	if (!prompt) return;
	recordPromptHistory(prompt);
	input.value = "";
	resizeComposer();
	const message = [
		"You are Agent Builder, a temporary specialist helping configure and deploy one local Pi agent.",
		"Ask concise questions, recommend concrete settings, and keep the visible configuration form as the source of truth.",
		"Do not claim that you changed a field. State the exact field values the user should save when the design is ready.",
		`Current name: ${requiredElement<HTMLInputElement>("agent-name").value || "not set"}`,
		`Current description: ${requiredElement<HTMLTextAreaElement>("agent-description").value || "not set"}`,
		`Current project folder: ${requiredElement<HTMLInputElement>("agent-project-root").value || "not set"}`,
		`Current persona: ${requiredElement<HTMLTextAreaElement>("agent-persona").value || "not set"}`,
		`Current tools: ${requiredElement<HTMLInputElement>("agent-tools").value || "none"}`,
		`Current model: ${agentModel.value || "inherit current session"}`,
		`User request: ${prompt}`,
	].join("\n");
	await chatSession.prompt(message);
}

async function submitAgentComposer(agentId: string): Promise<void> {
	if (!capabilityToken) return;
	const agent = agents.find((entry) => entry.id === agentId);
	if (!agent) throw new Error("The selected agent is unavailable");
	const activeTask = agentTasksByAgent
		.get(agentId)
		?.find((task) => task.status === "queued" || task.status === "running");
	if (activeTask) {
		await cancelAgentTask(activeTask.id);
		return;
	}
	const prompt = input.value.trim();
	if (!prompt) return;
	recordPromptHistory(prompt);
	input.value = "";
	resizeComposer();
	const response = await fetch(`/agent-tasks?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			agentId,
			conversationId: agentConversationIds.get(agentId),
			prompt,
			source: "chat",
		}),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not message agent"));
	await loadSelectedAgent();
}

input.addEventListener("input", () => {
	resizeComposer();
	const history = activePromptHistory();
	if (!history) return;
	history.index = history.entries.length;
	history.draft = input.value;
});
attachmentButton.addEventListener("click", () => {
	try {
		attachmentInput.showPicker();
	} catch {
		attachmentInput.click();
	}
});
attachmentInput.addEventListener("change", () => {
	const files = [...(attachmentInput.files ?? [])];
	attachmentInput.value = "";
	if (builderActive) return;
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
previewPopout.addEventListener("click", () => {
	if (browserPopoutMode) {
		window.close();
		return;
	}
	if (!activePreviewSessionId) return;
	const childUrl = new URL(location.href);
	childUrl.searchParams.set("browserPopout", "1");
	childUrl.searchParams.set("browserSession", activePreviewSessionId);
	window.open(
		childUrl.href,
		`pi-browser-${activePreviewSessionId}`,
		"popup=yes,width=1200,height=850,resizable=yes,scrollbars=yes",
	);
});
previewRecord.addEventListener("click", () => {
	void togglePreviewRecording().catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewSendRecording.addEventListener("click", () => {
	void sendPreviewRecordingToPi().catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewImage.addEventListener("click", (event) => {
	if (activePreviewSession?.controlOwner !== "user") return;
	previewFrame.focus();
	const bounds = previewImage.getBoundingClientRect();
	if (bounds.width === 0 || bounds.height === 0) return;
	const x = ((event.clientX - bounds.left) / bounds.width) * activePreviewSession.viewport.width;
	const y = ((event.clientY - bounds.top) / bounds.height) * activePreviewSession.viewport.height;
	void sendPreviewInput({ kind: "click", x, y }).catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewFrame.addEventListener("keydown", (event) => {
	if (activePreviewSession?.controlOwner !== "user" || event.isComposing) return;
	if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
	event.preventDefault();
	void sendPreviewInput({ kind: "type", text: event.key }).catch((error: unknown) =>
		setPreviewMessage(error instanceof Error ? error.message : String(error), true),
	);
});
previewFrame.addEventListener("paste", (event) => {
	if (activePreviewSession?.controlOwner !== "user") return;
	const text = event.clipboardData?.getData("text/plain") ?? "";
	if (!text) return;
	event.preventDefault();
	void sendPreviewInput({ kind: "type", text }).catch((error: unknown) =>
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
	if (builderActive) return;
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
	if (builderActive) return;
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	form.classList.add("composer-drop");
});
form.addEventListener("dragleave", () => form.classList.remove("composer-drop"));
form.addEventListener("drop", (event) => {
	form.classList.remove("composer-drop");
	if (builderActive) return;
	const files = event.dataTransfer?.files;
	if (!files || files.length === 0) return;
	event.preventDefault();
	void uploadFiles(files).catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
input.addEventListener("keydown", (event) => {
	if (
		!event.isComposing &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		(event.key === "ArrowUp" || event.key === "ArrowDown") &&
		navigatePromptHistory(event.key === "ArrowUp" ? -1 : 1)
	) {
		event.preventDefault();
		return;
	}
	if (
		event.key !== "Enter" ||
		event.shiftKey ||
		event.isComposing ||
		activeSubagentKey !== undefined ||
		(!activeAgentId && (builderActive ? builderSession?.snapshot?.phase : session?.snapshot?.phase) !== "idle")
	)
		return;
	event.preventDefault();
	form.requestSubmit();
});

model.addEventListener("change", () => {
	const separator = model.value.indexOf("/");
	if (separator < 1) return;
	const targetSession = builderActive ? builderSession : session;
	if (!targetSession || activeAgentId) return;
	void targetSession
		.setModel({ provider: model.value.slice(0, separator), id: model.value.slice(separator + 1) })
		.catch((error: unknown) => setStatus(String(error), true));
});

thinking.addEventListener("change", () => {
	const targetSession = builderActive ? builderSession : session;
	if (targetSession && !activeAgentId)
		void targetSession
			.setThinking(thinking.value as ThinkingLevel)
			.catch((error: unknown) => setStatus(String(error), true));
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
	button.addEventListener("click", () => {
		const tab = button.dataset.tab ?? "browser";
		activateTab(tab);
		if (tab === "browser") {
			void loadPreview().catch((error: unknown) =>
				setPreviewMessage(error instanceof Error ? error.message : String(error), true),
			);
		}
		if (tab === "agents-workspace")
			void loadAgents()
				.then(loadSelectedAgent)
				.catch((error: unknown) => setStatus(String(error), true));
		if (tab === "agent-builder") {
			if (builderSession) void loadCapabilities().catch((error: unknown) => setStatus(String(error), true));
			else void openAgentBuilder(undefined, false).catch((error: unknown) => setStatus(String(error), true));
		}
	});
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-builder-tab]")) {
	button.addEventListener("click", () => {
		const panel = button.dataset.builderTab ?? "builder-profile-panel";
		activateBuilderTab(panel);
		if (panel === "builder-connections-panel") {
			void loadCapabilityConnections()
				.then(loadWaveTwoControls)
				.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
		}
		if (panel === "builder-automation-panel")
			void loadEverydayConfigurations().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
	});
}

newAgent.addEventListener("click", () => {
	void openAgentBuilder().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
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
	const executor = value("agent-executor");
	const browserAccess = value("agent-browser-access");
	const browserRuntime = value("agent-browser-runtime");
	const browserProfileKind = value("agent-browser-profile-kind");
	const tools = value("agent-tools")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => (executor === "harness" && entry === "ls" ? "list" : entry));
	if (browserAccess !== "disabled" && !tools.includes("browser")) tools.push("browser");
	if (browserAccess === "disabled") {
		const browserIndex = tools.indexOf("browser");
		if (browserIndex >= 0) tools.splice(browserIndex, 1);
	}
	const definition = {
		personaId: value("agent-persona-select") || undefined,
		name: value("agent-name"),
		description: value("agent-description"),
		projectRoot: value("agent-project-root"),
		tools,
		capabilities: selectedAgentCapabilities(),
		memory: value("agent-memory"),
		persona: value("agent-persona"),
		executor,
		permissionPolicy: value("agent-permissions"),
		thinking: value("agent-thinking"),
		delegateAgentIds: value("agent-delegates")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
		a2a: { enabled: requiredElement<HTMLInputElement>("agent-a2a").checked },
		browser: {
			access: browserAccess,
			runtime: browserRuntime,
			profile:
				browserProfileKind === "named"
					? { kind: "named" as const, id: value("agent-browser-profile-id") }
					: { kind: "ephemeral" as const },
		},
		browserWorkflows: value("agent-browser-workflows")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean)
			.map((entry) => {
				const separator = entry.lastIndexOf("@");
				return { id: entry.slice(0, separator), version: Number(entry.slice(separator + 1)) };
			}),
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
	setStatus("Saving agent definition…");
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
			const saved: unknown = await response.json();
			setStatus("Agent definition saved");
			void (async () => {
				await loadAgents();
				await Promise.all([loadRoutines(), loadWorkflows()]);
				if (typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string") {
					const agent = agents.find((entry) => entry.id === saved.id);
					if (agent) {
						await closeBuilderChat(false);
						await openAgent(agent);
					}
				}
			})().catch((error: unknown) => {
				setStatus(
					`Agent saved; background refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					true,
				);
			});
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

personaSelect.addEventListener("change", () => updatePersonaPreview(true));
requiredElement<HTMLSelectElement>("agent-executor").addEventListener("change", () => {
	void loadCapabilities().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
requiredElement<HTMLSelectElement>("agent-browser-profile-kind").addEventListener(
	"change",
	updateAgentBrowserProfileFields,
);

pluginForm.addEventListener("submit", (event) => {
	event.preventDefault();
	const source = requiredElement<HTMLInputElement>("plugin-source").value.trim();
	const scope = requiredElement<HTMLSelectElement>("plugin-scope").value;
	void changePlugin("install", source, scope).catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});

capabilityConnectionForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const value = (id: string) => requiredElement<HTMLInputElement>(id).value.trim();
	const providerId = value("capability-connection-provider");
	const id = value("capability-connection-id");
	const accountLabel = value("capability-connection-label");
	const secretRef = value("capability-connection-secret-ref");
	const list = (id: string) =>
		value(id)
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	void fetch(
		`${id ? `/capability-connections/${encodeURIComponent(id)}` : "/capability-connections.json"}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: id ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				providerId,
				accountLabel,
				secretRef,
				status: requiredElement<HTMLSelectElement>("capability-connection-status").value,
				scopes: list("capability-connection-scopes"),
				capabilityIds: list("capability-connection-capabilities"),
			}),
		},
	)
		.then(async (response) => {
			if (!response.ok) throw new Error(await responseError(response, "Could not save provider account"));
			clearCapabilityConnectionForm();
			await Promise.all([loadCapabilityConnections(), loadCapabilities(), loadWaveTwoControls()]);
			setStatus("Provider account saved");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

requiredElement<HTMLButtonElement>("capability-connection-clear").addEventListener(
	"click",
	clearCapabilityConnectionForm,
);

inboundRouteForm.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const list = (id: string) =>
		requiredElement<HTMLInputElement>(id)
			.value.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	void fetch(`/capability-inbound-routes.json?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			id: requiredElement<HTMLInputElement>("inbound-route-id").value.trim(),
			connectionId: requiredElement<HTMLSelectElement>("inbound-route-connection").value,
			destination: {
				kind: requiredElement<HTMLSelectElement>("inbound-route-kind").value,
				id: requiredElement<HTMLInputElement>("inbound-route-destination").value.trim(),
			},
			allowedSenders: list("inbound-route-senders"),
			maxEventsPerMinute: Number(requiredElement<HTMLInputElement>("inbound-route-rate").value),
			enabled: requiredElement<HTMLInputElement>("inbound-route-enabled").checked,
		}),
	})
		.then(async (response) => {
			if (!response.ok) throw new Error(await responseError(response, "Could not save inbound route"));
			inboundRouteForm.reset();
			await loadInboundRoutes();
			setStatus("Inbound route saved");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

siteMonitorForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void saveEverydayConfiguration(
		"monitors",
		{
			id: requiredElement<HTMLInputElement>("site-monitor-id").value.trim(),
			name: requiredElement<HTMLInputElement>("site-monitor-name").value.trim(),
			url: requiredElement<HTMLInputElement>("site-monitor-url").value.trim(),
			enabled: requiredElement<HTMLInputElement>("site-monitor-enabled").checked,
		},
		siteMonitorForm,
	).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

financeWatchlistForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void saveEverydayConfiguration(
		"watchlists",
		{
			id: requiredElement<HTMLInputElement>("finance-watchlist-id").value.trim(),
			name: requiredElement<HTMLInputElement>("finance-watchlist-name").value.trim(),
			symbols: requiredElement<HTMLInputElement>("finance-watchlist-symbols")
				.value.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
			providerId: requiredElement<HTMLInputElement>("finance-watchlist-provider").value.trim() || undefined,
			connectionId: requiredElement<HTMLSelectElement>("finance-watchlist-connection").value || undefined,
			enabled: requiredElement<HTMLInputElement>("finance-watchlist-enabled").checked,
		},
		financeWatchlistForm,
	).catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

async function saveEverydayConfiguration(
	kind: "monitors" | "watchlists",
	definition: Record<string, unknown>,
	targetForm: HTMLFormElement,
): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/everyday-configurations/${kind}?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(definition),
	});
	if (!response.ok) throw new Error(await responseError(response, `Could not save ${kind}`));
	targetForm.reset();
	await loadEverydayConfigurations();
	setStatus(kind === "monitors" ? "Site monitor saved" : "Finance watchlist saved");
}

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
routineEditor.preset.addEventListener("change", updateRoutineCronFromPreset);
routineEditor.time.addEventListener("change", updateRoutineCronFromPreset);
routineEditor.cron.addEventListener("change", () => void refreshRoutinePreview());
routineEditor.timezone.addEventListener("change", () => void refreshRoutinePreview());
routineEditor.clearButton.addEventListener("click", clearRoutineEditor);

routineEditor.form.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	const kind = routineEditor.targetKind.value;
	let browserParameters: Record<string, string | number | boolean> = {};
	if (kind === "browser-workflow") {
		try {
			browserParameters = parseRoutineBrowserParameters(routineEditor.browserParameters.value);
		} catch (error) {
			setStatus(error instanceof Error ? error.message : String(error), true);
			return;
		}
	}
	const target =
		kind === "agent"
			? { kind: "agent" as const, agentId: routineEditor.agent.value }
			: kind === "workflow"
				? { kind: "workflow" as const, workflowId: routineEditor.workflow.value }
				: kind === "browser-workflow"
					? {
							kind: "browser-workflow" as const,
							workflowId: routineEditor.browserWorkflow.value.slice(
								0,
								routineEditor.browserWorkflow.value.lastIndexOf("@"),
							),
							workflowVersion: Number(
								routineEditor.browserWorkflow.value.slice(
									routineEditor.browserWorkflow.value.lastIndexOf("@") + 1,
								),
							),
							parameters: browserParameters,
						}
					: kind === "acp"
						? { kind: "acp" as const, connectionId: routineEditor.acp.value }
						: { kind: "skill" as const, skillName: routineEditor.skill.value.trim() };
	const separator = routineEditor.model.value.indexOf("/");
	const definition = {
		name: routineEditor.name.value,
		prompt: routineEditor.prompt.value,
		enabled: routineEditor.enabled.checked,
		cron: routineEditor.cron.value,
		timezone: routineEditor.timezone.value,
		maxDurationMinutes: Number(routineEditor.maxDuration.value),
		target,
		model:
			separator > 0
				? {
						provider: routineEditor.model.value.slice(0, separator),
						id: routineEditor.model.value.slice(separator + 1),
					}
				: undefined,
		cwd:
			kind === "agent" || kind === "workflow" || kind === "browser-workflow"
				? undefined
				: routineEditor.cwd.value.trim() || undefined,
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

function parseRoutineBrowserParameters(value: string): Record<string, string | number | boolean> {
	const parsed: unknown = JSON.parse(value || "{}");
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Browser workflow parameters must be a JSON object");
	}
	const parameters: Record<string, string | number | boolean> = {};
	for (const [name, entry] of Object.entries(parsed)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new Error(`Invalid browser parameter ${name}`);
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`Browser parameter ${name} must be a string, number, or boolean`);
		}
		parameters[name] = entry;
	}
	return parameters;
}

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

workflowEditor.clearButton.addEventListener("click", clearWorkflowEditor);
workflowEditor.form.addEventListener("submit", (event) => {
	event.preventDefault();
	if (!capabilityToken) return;
	let nodes: unknown;
	let edges: unknown;
	try {
		nodes = JSON.parse(workflowEditor.nodes.value);
		edges = JSON.parse(workflowEditor.edges.value || "[]");
	} catch {
		setStatus("Workflow steps and dependencies must be valid JSON", true);
		return;
	}
	const id = workflowEditor.id.value;
	const definition = {
		name: workflowEditor.name.value,
		pattern: workflowEditor.pattern.value,
		nodes,
		edges,
		supervisorAgentId: workflowEditor.supervisor.value || undefined,
		maxConcurrency: Number(workflowEditor.maxConcurrency.value),
		maxDelegationDepth: Number(workflowEditor.maxDepth.value),
		failurePolicy: workflowEditor.failurePolicy.value,
	};
	void fetch(
		`${id ? `/workflows/${encodeURIComponent(id)}` : "/workflows"}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: id ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(definition),
		},
	)
		.then(async (response) => {
			if (!response.ok) throw new Error(await responseError(response, "Could not save workflow"));
			const saved: unknown = await response.json();
			await loadWorkflows();
			if (typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string") {
				const workflow = workflows.find((entry) => entry.id === saved.id);
				if (workflow) editWorkflow(workflow);
			}
			setStatus("Workflow saved");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

workflowEditor.runButton.addEventListener("click", () => {
	if (!capabilityToken || !workflowEditor.id.value || !workflowEditor.runPrompt.value.trim()) return;
	void fetch(
		`/workflows/${encodeURIComponent(workflowEditor.id.value)}/run?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: workflowEditor.runPrompt.value }),
		},
	)
		.then(async (response) => {
			if (!response.ok) throw new Error(await responseError(response, "Could not run workflow"));
			workflowEditor.runPrompt.value = "";
			await loadWorkflows();
			setStatus("Workflow started");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

workflowEditor.deleteButton.addEventListener("click", () => {
	const id = workflowEditor.id.value;
	if (!capabilityToken || !id || !window.confirm(`Delete workflow "${workflowEditor.name.value}"?`)) return;
	void fetch(`/workflows/${encodeURIComponent(id)}?token=${encodeURIComponent(capabilityToken)}`, { method: "DELETE" })
		.then(async (response) => {
			if (!response.ok) throw new Error(await responseError(response, "Could not delete workflow"));
			clearWorkflowEditor();
			await loadWorkflows();
			setStatus("Workflow deleted");
		})
		.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
});

window.setInterval(() => {
	if (document.visibilityState !== "visible" || periodicRefreshPromise) return;
	const activeTab = document.querySelector<HTMLButtonElement>("[data-tab].active")?.dataset.tab;
	periodicRefreshPromise = (async () => {
		if (activeTab === "browser") await loadPreview();
		if (activeTab === "agents-workspace") {
			if (activeSidebarAgent) await loadSelectedAgent();
			await loadExternalRuns();
		}
		if (activeTab === "agent-builder") await Promise.all([loadRoutines(), loadWorkflows()]);
	})()
		.catch(() => {})
		.finally(() => {
			periodicRefreshPromise = undefined;
		});
}, 2500);

installPanelResizer("left-resizer", "--rail-width", "pi-serve-rail-width", 1, 190, 420);
installPanelResizer("right-resizer", "--details-width", "pi-serve-details-width", -1, 280, 560);
resizeComposer();
clearRoutineEditor();
clearWorkflowEditor();
void connect().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
