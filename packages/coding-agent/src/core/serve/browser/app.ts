import { PiClient, type PiSessionHandle, type Unsubscribe } from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	SessionMetadata,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import { createBrowserId } from "./browser-id.ts";
import { splitInlineThinking } from "./inline-thinking.ts";
import {
	getModelSelectionCostPresentations,
	getSessionCostPresentation,
	type ModelSelectionCostPresentation,
	modelSelectionCostKey,
} from "./model-pricing.ts";
import { filterPresentedModels } from "./model-visibility.ts";
import { installThemedSelect } from "./themed-select.ts";
import { selectTranscriptWindow } from "./transcript-window.ts";
import { createBrowserWebSocketTransport } from "./websocket-transport.ts";

const pageUrl = new URL(location.href);
const capabilityToken = pageUrl.searchParams.get("token");
const browserPopoutMode = pageUrl.searchParams.get("browserPopout") === "1";
const requestedPreviewSessionId = pageUrl.searchParams.get("browserSession") ?? undefined;
const recommendedAgentModel = { provider: "openai", id: "gpt-5.6-luna" } as const;
const agentBuilderBootstrapPrefix =
	"You are Agent Builder, a temporary specialist helping configure and deploy one local Pi agent.";
const modelProviderLabels: Readonly<Record<string, string>> = {
	"amazon-bedrock": "Bedrock",
	"bedrock-mantle": "Bedrock Mantle",
	anthropic: "Anthropic",
	ollama: "Ollama",
	openai: "OpenAI",
};
document.body.classList.toggle("browser-popout", browserPopoutMode);
if (browserPopoutMode) document.title = "Pi Browser";

const status = element("status");
const sessionPath = requiredElement<HTMLButtonElement>("session-path");
const sessionPathForm = requiredElement<HTMLFormElement>("session-path-form");
const sessionPathInput = requiredElement<HTMLInputElement>("session-path-input");
const sessionPathCancel = requiredElement<HTMLButtonElement>("session-path-cancel");
const sessionStats = element("session-stats");
const transcript = element("transcript");
const form = requiredElement<HTMLFormElement>("composer");
const input = requiredElement<HTMLTextAreaElement>("prompt");
const send = requiredElement<HTMLButtonElement>("composer-action");
const mobilePanelNone = requiredElement<HTMLInputElement>("mobile-panel-none");
const mobilePanelRight = requiredElement<HTMLInputElement>("mobile-panel-right");
const attachmentInput = requiredElement<HTMLInputElement>("attachment-input");
const attachmentButton = requiredElement<HTMLButtonElement>("attachment-button");
const attachmentList = element("attachment-list");
attachmentInput.classList.remove("hidden");
attachmentInput.classList.add("file-picker-input");
const model = requiredElement<HTMLSelectElement>("model");
const agentModel = requiredElement<HTMLSelectElement>("agent-model");
const thinking = requiredElement<HTMLSelectElement>("thinking");
const agentThinking = requiredElement<HTMLSelectElement>("agent-thinking");
const phase = element("phase");
const agentList = element("agent-list");
const newAgent = requiredElement<HTMLButtonElement>("new-agent");
const agentForm = requiredElement<HTMLFormElement>("agent-form");
const selectedAgentPanel = element("selected-agent");
const selectedAgentTitle = element("selected-agent-title");
const selectedAgentMeta = element("selected-agent-meta");
const agentActivityList = element("agent-activity-list");
const attentionHeading = element("attention-heading");
const openArtifactsButton = requiredElement<HTMLButtonElement>("open-artifacts");
selectedAgentPanel.querySelector(".agent-run-history")?.remove();
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
const openSettingsButton = requiredElement<HTMLButtonElement>("open-settings");
const settingsWorkspace = element("settings-workspace");
const settingsClose = requiredElement<HTMLButtonElement>("settings-close");
const settingsProjectName = element("settings-project-name");
const settingsProjectPath = element("settings-project-path");
const settingsModelList = element("settings-model-list");
const settingsConnectionList = element("settings-connection-list");
const settingsCapabilityList = element("settings-capability-list");
const settingsCapabilitySearch = requiredElement<HTMLInputElement>("settings-capability-search");
const settingsPluginList = element("settings-plugin-list");
const settingsMcpList = element("settings-mcp-list");
const settingsSecurityList = element("settings-security-list");
const settingsAdvancedConnections = element("settings-advanced-connections");
const settingsPluginManagement = element("settings-plugin-management");
const externalConnectionList = element("external-connection-list");
const delegationPanelHost = element("delegation-panel-host");
const delegationPanel = externalConnectionList.closest("details");
installWorkflowWorkspaceLayout(delegationPanel);
const claudeAuthFlow = createClaudeAuthFlow();
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
installSettingsLayout();
const agentSubmit = (() => {
	const value = agentForm.querySelector<HTMLButtonElement>('button[type="submit"]');
	if (!value) throw new Error("Agent Builder submit control is missing");
	return value;
})();
const agentCancel = document.createElement("button");
agentCancel.type = "button";
agentCancel.className = "secondary-action";
agentCancel.textContent = "Cancel editing";
agentSubmit.before(agentCancel);
const agentValidation = document.createElement("p");
agentValidation.className = "muted";
agentValidation.setAttribute("role", "status");
agentValidation.setAttribute("aria-live", "polite");
agentForm.before(agentValidation);
const teamPackageInput = document.createElement("input");
teamPackageInput.type = "file";
teamPackageInput.accept = "application/json,.json";
teamPackageInput.multiple = true;
teamPackageInput.className = "hidden";
teamPackageInput.setAttribute("aria-label", "Open WTK team bundle and runtime files");
document.body.append(teamPackageInput);
installAgentBuilderStepControls();
const modelPicker = installThemedSelect(model);
const agentModelPicker = installThemedSelect(agentModel);
const externalModelPicker = installThemedSelect(externalModel);
const routineModelPicker = installThemedSelect(routineEditor.model);
const thinkingPicker = installThemedSelect(thinking, "simple");
const agentThinkingPicker = installThemedSelect(agentThinking, "simple");

function installWorkflowWorkspaceLayout(delegation: HTMLDetailsElement | null): void {
	const workspace = element("agents-workspace");
	const workspaceTab = document.querySelector<HTMLButtonElement>('[data-tab="agents-workspace"]');
	if (workspaceTab) workspaceTab.textContent = "Workflow";
	const mobileToggle = document.querySelector<HTMLLabelElement>('label[for="mobile-panel-right"]');
	if (mobileToggle) {
		mobileToggle.title = "Workflow and browser workspace";
		mobileToggle.setAttribute("aria-label", "Open workflow and browser workspace");
		mobileToggle.style.position = "relative";
		const badge = document.createElement("span");
		badge.id = "workflow-badge";
		badge.className = "hidden";
		badge.style.cssText =
			"position:absolute;right:2px;top:2px;min-width:15px;height:15px;padding:0 3px;border-radius:999px;background:var(--pi);color:#07101b;font:700 9px/15px system-ui;text-align:center";
		mobileToggle.append(badge);
	}
	const activityHeading = attentionHeading.closest<HTMLElement>(".rail-heading");
	const activityPanel = agentActivityList.closest<HTMLElement>(".agent-activity-panel");
	if (activityHeading && activityPanel) workspace.prepend(activityHeading, activityPanel);
	element("rail-section-resizer").classList.add("hidden");
	const sessionsPanel = element("sessions");
	sessionsPanel.style.flex = "1 1 auto";
	agentList.classList.add("hidden");
	newAgent.classList.add("hidden");
	delegationPanelHost.classList.add("hidden");

	const delegate = document.createElement("button");
	delegate.type = "button";
	delegate.title = "Delegate to an external agent";
	delegate.setAttribute("aria-label", delegate.title);
	delegate.style.width = "44px";
	delegate.style.height = "44px";
	delegate.style.flex = "0 0 44px";
	delegate.innerHTML =
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h10m-4-4 4 4-4 4M5 7V5h14v14H5v-2"/><text x="5" y="15" font-size="8" fill="currentColor" stroke="none">π</text></svg>';
	delegate.addEventListener("click", () => {
		mobilePanelRight.checked = true;
		activateTab("agents-workspace");
		if (delegation) {
			delegation.open = true;
			delegation.scrollIntoView({ behavior: "smooth", block: "start" });
		}
	});
	openSettingsButton.before(delegate);
}

let session: PiSessionHandle | undefined;
let unsubscribeSession: Unsubscribe | undefined;
let builderActive = false;
let builderLabel = "Agent Builder";
let activeSidebarAgent: AgentSummary | undefined;
let activeTargetKey: string | undefined;
let activeAgentId: string | undefined;
let activeSubagentKey: string | undefined;
let activeExternalRunId = localStorage.getItem("pi-serve-active-external-run-v2") ?? undefined;
let activeExternalConnectionId = localStorage.getItem("pi-serve-active-external-connection") ?? undefined;
let activeArtifactId: string | undefined;
const artifactLibraryId = "artifact-library";
const openAgentIds: string[] = [];
const openSubagentKeys: string[] = [];
const openExternalRunIds = readStoredStringArray("pi-serve-external-run-tabs-v2");
const openExternalConnectionIds = readStoredStringArray("pi-serve-external-connection-tabs");
const openArtifactIds: string[] = [];
const externalResultByRunId = new Map<string, string>();
const subagentActivityByKey = new Map<string, SubagentActivity>();
const agentConversationIds = new Map<string, string>();
const agentTasksByAgent = new Map<string, AgentTaskSummary[]>();
const agentTeamStates = new Map<string, AgentTeamState>();
let attentionItems: AttentionSummary[] = [];
let artifacts: ArtifactSummary[] = [];
let activeArtifactObjectUrl: string | undefined;
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
const previewSessionsWithoutCapture = new Set<string>();
let recordedBrowserWorkflows: BrowserWorkflowSummary[] = [];
let browserWorkflowRuns: BrowserWorkflowRunSummary[] = [];
let lastBrowserWorkflowLoadAt = 0;
const browserWorkflowReviews = new Map<string, BrowserWorkflowReview>();
const browserWorkflowActionStates = new Map<string, { status: "running" | "completed" | "failed"; message: string }>();
let selectedExternalConnectionId: string | undefined;
let externalRuns: ExternalRunSummary[] = [];
let renderedExternalRunSignature = "";
let renderedExternalRunListSignature = "";
let lastAppliedBuilderDraft = "";
let agentBuilderBaseline = "";
let agentBuilderFeedback = "";
let activeAgentImprovement: AgentImprovementContext | undefined;
let activeAgentBuild: AgentBuildRecord | undefined;
let draftedAgentCriteria: unknown[] | undefined;
let agentBuildDraftTimer: number | undefined;
let agentBuildPollTimer: number | undefined;
let pendingTeamPackage: PendingTeamPackage | undefined;
let teamLaunchBusy = false;
let teamFactoryAvailable = false;
let teamFactoryBusy = false;
let teamFactoryDraft = readStoredTeamFactoryDraft();
let availableModels: ModelMetadata[] = [];
let modelCostPresentations: ReadonlyMap<string, ModelSelectionCostPresentation> = new Map();
let agentModelsInitialized = false;
let agents: AgentSummary[] = [];
let agentBuilds: AgentBuildRecord[] = [];
let personas: PersonaSummary[] = [];
let agentEvents: EventSource | undefined;
let agentsLoadPromise: Promise<void> | undefined;
const selectedAgentLoadPromises = new Map<string, Promise<void>>();
let capabilitySearchTimer: number | undefined;
let settingsReturnHash = "";
let settingsReturnFocus: HTMLElement | undefined;
let capabilityConnections: CapabilityConnectionSummary[] = [];
let capabilitySnapshot: CapabilitySnapshot["broker"] | undefined;
let capabilityCatalogSnapshot: CapabilitySnapshot | undefined;
let credentialVaultStatus: CredentialVaultManagementStatus | undefined;
const attachmentsBySession = new Map<string, AttachmentSummary[]>();

interface AttachmentSummary {
	id: string;
	name: string;
	mimeType: string;
	size: number;
}

interface PiAgentTeamPreview {
	schemaVersion: "pi.agents.team-preview.v1";
	approvalDigest: string;
	team: {
		name: string;
		coordinatorRoleId: string;
		roles: Array<{
			id: string;
			name: string;
			model: { provider: string; id: string };
			permissionPolicy: "read-only" | "workspace-write";
			toolNames: string[];
			capabilityGrantCount: number;
		}>;
		workflow: { nodeCount: number; maxConcurrency: number };
	};
	bindings: { projectRoot: string; credentialRefs: string[] };
}

interface PendingTeamPackage {
	bundle: unknown;
	bindings: unknown;
	preview: PiAgentTeamPreview;
}

type TeamFactoryPhase = "intake" | "research" | "build" | "deliver" | "prepare" | "failed";

interface TeamFactoryDraft {
	sessionId?: string;
	operationId?: string;
	phase: TeamFactoryPhase;
	pkgId?: string;
	reviewReady?: boolean;
	paused?: boolean;
	messages: Array<{ role: "user" | "assistant"; text: string }>;
}

interface TeamFactoryOperation {
	id: string;
	status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
	result?: unknown;
	error?: { message: string };
	progress?: { message: string };
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
	bindings: Array<{
		capabilityId: string;
		capabilityVersion: number;
		toolName?: string;
	}>;
	authentication?: {
		kind: "environment" | "oauth2" | "plaid-link";
		configured: boolean;
		fields: Array<{
			env: string;
			label: string;
			required: boolean;
			secret: boolean;
			format?: "text" | "url";
			options?: Array<{ value: string; label: string }>;
			operatorEditable?: boolean;
			configured: boolean;
			value?: string;
		}>;
		capabilityGroups?: Array<{ id: string; label: string; capabilityIds: string[] }>;
		defaultCapabilityIds?: string[];
	};
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

interface CredentialVaultManagementStatus {
	vault: {
		path: string;
		scope: "user" | "workspace";
		initialized: boolean;
		locked: boolean;
		protection: "windows" | "passphrase" | "none";
		generation?: number;
		updatedAt?: string;
		credentialCount?: number;
	};
	legacy: {
		path: string;
		configuredFields: Array<{ providerId: string; name: string; secret: boolean; sourceName: string }>;
		migratedFields: Array<{ providerId: string; name: string; secret: boolean; sourceName: string }>;
		unmanagedNames: string[];
	};
}

type CapabilityConnectionState = "not-required" | "missing" | "unhealthy" | "not-granted" | "ready";

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
	status:
		| "queued"
		| "running"
		| "waiting_for_approval"
		| "waiting_for_input"
		| "stopping"
		| "completed"
		| "failed"
		| "cancelled"
		| "interrupted";
	prompt: string;
	createdAt: number;
	phase?: "initializing" | "waiting-for-model" | "generating" | "running-tool" | "writing-results";
	progressMessage?: string;
	lastActivityAt?: number;
	attemptIds: string[];
	artifactIds: string[];
	result?: string;
	error?: string;
}

interface AgentImprovementContext {
	route: "repair" | "refine" | "diagnose";
	scope: "auto" | "agent" | "team";
	objective: string;
	successCriteria: string;
	baselineRevision: number;
	task?: Pick<AgentTaskSummary, "id" | "status" | "prompt" | "attemptIds" | "result" | "error">;
}

type AgentBuildStage =
	| "draft"
	| "ready-to-test"
	| "testing"
	| "proof-ready"
	| "needs-refinement"
	| "proven"
	| "promoted"
	| "automated";

interface AgentBuildRecord {
	id: string;
	revision: number;
	name: string;
	objective: string;
	projectRoot: string;
	configuration?: {
		name: string;
		description: string;
		persona: string;
		projectRoot: string;
		tools: string[];
		model?: { provider: string; id: string };
		thinking?: ThinkingLevel;
		memory: "none" | "notes";
		executor: "session" | "harness";
		permissionPolicy: "read-only" | "workspace-write";
		browserAccess: "disabled" | "loopback" | "public-web" | "private-network";
		delegateAgentIds: string[];
		exposeA2a: boolean;
	};
	candidateRevision?: number;
	automationIntent?: {
		task: string;
		cadence: string;
		timezone: string;
		mode: "replace" | "additional";
		confirmed: boolean;
	};
	criteria: Array<{
		id: string;
		label: string;
		description: string;
		category: string;
		expectation: "required-improvement" | "non-regression" | "advisory";
		evaluator: { type: string };
	}>;
	feedback: Array<{
		id: string;
		proofRunId: string;
		rating: 1 | 2 | 3 | 4 | 5;
		summary: string;
		createdAt: number;
	}>;
	evaluation?: {
		runId: string;
		evaluatedAt: number;
		checks: Array<{
			criterionId: string;
			status: "pass" | "fail" | "unverified";
			summary: string;
			evidence: string[];
		}>;
	};
	proofHistory: Array<{
		proof: AgentBuildRecord["proof"];
		evaluation?: AgentBuildRecord["evaluation"];
	}>;
	stage: AgentBuildStage;
	agentId?: string;
	agentRevision?: number;
	proof?: {
		runId: string;
		agentRevision: number;
		prompt: string;
		status: "running" | "succeeded" | "failed" | "aborted";
		finishedAt?: number;
	};
	proofPrompt?: string;
	skill?: { name: string; path: string; sourceRunId: string };
	routineIds: string[];
	createdAt: number;
	updatedAt: number;
}

interface AttentionSummary {
	id: string;
	taskId: string;
	kind: "approval" | "question" | "failure" | "completed";
	status: "open" | "resolved" | "dismissed";
	title: string;
	summary: string;
	createdAt: number;
}

interface ArtifactSummary {
	id: string;
	title: string;
	kind: string;
	taskId: string;
	agentId?: string;
	currentVersionId: string;
	versionIds: string[];
	createdAt: number;
	updatedAt: number;
	archivedAt?: number;
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
	provider: "anthropic" | "openai" | "hermes";
	authentication: "subscription" | "api-key" | "configured";
	billing: "subscription" | "usage-based" | "configured";
	available: boolean;
	warning?: string;
	defaultModel: { provider: string; id: string };
	models: Array<{ provider: string; id: string; name: string }>;
}

interface ClaudeSubscriptionLoginStatus {
	status: "idle" | "running" | "succeeded" | "failed";
	authenticated: boolean;
	authorizationUrl?: string;
	error?: string;
}

interface ExternalRunSummary {
	id: string;
	connectionId: string;
	prompt: string;
	cwd: string;
	model: { provider: string; id: string };
	status: string;
	createdAt: number;
	startedAt?: number;
	phase?: string;
	progress?: string;
	lastActivityAt?: number;
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
const pendingSessionConfigurationUpdates = new Map<string, Promise<SessionSnapshot>>();
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
	const tabs = panel.parentElement?.querySelector<HTMLElement>(".builder-tabs");
	const runtimeTab = tabs?.querySelector<HTMLButtonElement>('[data-builder-tab="builder-tools-panel"]');
	const delegationTab = tabs?.querySelector<HTMLButtonElement>('[data-builder-tab="builder-connections-panel"]');
	if (!tabs || !runtimeTab || !delegationTab) throw new Error("Agent Builder navigation is incomplete");
	runtimeTab.textContent = "Runtime";
	delegationTab.textContent = "Delegation";
	const capabilityTab = document.createElement("button");
	capabilityTab.type = "button";
	capabilityTab.dataset.builderTab = "builder-capabilities-panel";
	capabilityTab.textContent = "Capabilities";
	tabs.insertBefore(capabilityTab, delegationTab);
	const capabilityPanel = document.createElement("section");
	capabilityPanel.id = "builder-capabilities-panel";
	capabilityPanel.className = "builder-panel hidden";
	capabilityPanel.dataset.builderPanel = "";
	panel.after(capabilityPanel);
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
			],
			false,
		),
	);
	panel.prepend(stack);
	const hiddenTools = element("agent-tools");
	const hiddenCapabilities = element("agent-capabilities");
	capabilityPanel.append(
		hiddenTools,
		hiddenCapabilities,
		builderSettingsGroup(
			"Capabilities",
			"Grant only resources that are ready in Settings.",
			[capabilityList],
			true,
			"agent-capability-summary",
		),
		builderSettingsGroup(
			"Browser workflows",
			"Grant validated browser workflows to this agent.",
			[browserWorkflowSection],
			false,
		),
	);
	settingsPluginManagement.append(pluginSection);
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

type SettingsSection = "models" | "connections" | "capabilities" | "plugins" | "security";

function installSettingsLayout(): void {
	const connectionSection = capabilityConnectionForm.closest("details");
	const approvalSection = capabilityApprovalList.closest("details");
	const inboundSection = inboundRouteForm.closest("details");
	const siteMonitorSection = siteMonitorForm.closest("details");
	const financeWatchlistSection = financeWatchlistForm.closest("details");
	if (!connectionSection || !approvalSection || !inboundSection || !siteMonitorSection || !financeWatchlistSection) {
		throw new Error("Settings resources are incomplete");
	}
	settingsAdvancedConnections.append(connectionSection, siteMonitorSection, financeWatchlistSection);
	settingsSecurityList.append(approvalSection, inboundSection);
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-section]")) {
		button.addEventListener("click", () => {
			const section = settingsSection(button.dataset.settingsSection);
			showSettingsSection(section);
			history.replaceState(null, "", `#settings/${section}`);
		});
	}
	settingsCapabilitySearch.addEventListener("input", renderSettingsCapabilities);
	window.addEventListener("hashchange", applySettingsHash);
}

function openSettings(section: SettingsSection = "models", resourceId?: string): void {
	if (settingsWorkspace.classList.contains("hidden")) {
		settingsReturnHash = location.hash.startsWith("#settings/") ? "" : location.hash;
		settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
	}
	const cwd = session?.snapshot?.cwd ?? requiredElement<HTMLInputElement>("agent-project-root").value;
	const project = sessionFolderName(cwd) ?? "Pi deployment";
	settingsProjectName.textContent = `Settings · ${project}`;
	settingsProjectPath.textContent = cwd;
	settingsProjectPath.title = cwd;
	settingsWorkspace.classList.remove("hidden");
	mobilePanelNone.checked = true;
	showSettingsSection(section);
	renderSettings();
	const hash = `#settings/${section}${resourceId ? `/${encodeURIComponent(resourceId)}` : ""}`;
	history.replaceState(null, "", hash);
	window.setTimeout(() => {
		const resource = resourceId
			? settingsWorkspace.querySelector<HTMLElement>(`[data-settings-resource="${CSS.escape(resourceId)}"]`)
			: undefined;
		(resource ?? settingsClose).focus();
		resource?.scrollIntoView({ block: "start" });
	}, 0);
}

function closeSettings(): void {
	settingsWorkspace.classList.add("hidden");
	history.replaceState(null, "", `${location.pathname}${location.search}${settingsReturnHash}`);
	settingsReturnFocus?.focus();
}

function applySettingsHash(): void {
	if (!location.hash.startsWith("#settings/")) return;
	const [, rawSection, rawResource] = location.hash.split("/");
	openSettings(settingsSection(rawSection), rawResource ? decodeURIComponent(rawResource) : undefined);
}

function settingsSection(value: string | undefined): SettingsSection {
	return value === "connections" ||
		value === "capabilities" ||
		value === "plugins" ||
		value === "security" ||
		value === "models"
		? value
		: "models";
}

function showSettingsSection(section: SettingsSection): void {
	for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-section]")) {
		button.classList.toggle("active", button.dataset.settingsSection === section);
		button.setAttribute("aria-current", button.dataset.settingsSection === section ? "page" : "false");
	}
	for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
		panel.classList.toggle("hidden", panel.id !== `settings-${section}`);
	}
}

function renderSettings(): void {
	renderSettingsModels();
	renderSettingsConnections();
	renderSettingsCapabilities();
	renderSettingsPlugins();
	renderSettingsSecurity();
}

function renderSettingsSecurity(): void {
	document.getElementById("settings-vault-card")?.remove();
	const status = credentialVaultStatus;
	const card = settingsCard(
		"Credential vault",
		status
			? `${status.vault.scope === "user" ? "Shared user" : "Workspace"} · ${status.vault.protection}`
			: "Loading encrypted credential storage",
		status
			? status.vault.initialized
				? status.vault.locked
					? "Locked"
					: "Unlocked"
				: "Setup required"
			: "Loading",
		"User",
		"credential-vault",
	);
	card.id = "settings-vault-card";
	if (!status) {
		settingsSecurityList.prepend(card);
		return;
	}
	appendText(
		card,
		status.vault.locked
			? "Stored values are unavailable until this Pi host unlocks the vault."
			: `${status.vault.credentialCount ?? 0} configured provider record${status.vault.credentialCount === 1 ? "" : "s"}.`,
		"muted",
	);
	const legacyRemaining = status.legacy.configuredFields.filter(
		(field) =>
			!status.legacy.migratedFields.some(
				(migrated) => migrated.providerId === field.providerId && migrated.name === field.name,
			),
	);
	if (status.legacy.configuredFields.length > 0) {
		appendText(
			card,
			`${status.legacy.migratedFields.length}/${status.legacy.configuredFields.length} declared .env.local values migrated.`,
			"settings-state",
		);
	}
	if (status.legacy.unmanagedNames.length > 0) {
		appendText(
			card,
			`${status.legacy.unmanagedNames.length} legacy setting${status.legacy.unmanagedNames.length === 1 ? " is" : "s are"} not owned by a connection and remain in .env.local.`,
			"settings-state",
		);
	}
	const secretMutationAllowed = location.protocol === "https:" || isLoopbackHostname(location.hostname);
	const passphrase = document.createElement("input");
	passphrase.type = "password";
	passphrase.autocomplete = "new-password";
	passphrase.placeholder = "Vault passphrase for portable or recovery vaults";
	passphrase.setAttribute("aria-label", "Credential vault passphrase");
	passphrase.className = "settings-search";
	if (!status.vault.initialized || status.vault.locked) card.append(passphrase);
	const actions = document.createElement("div");
	actions.className = "settings-actions";
	if (!status.vault.initialized) {
		actions.append(vaultActionButton("Initialize vault", "initialize", passphrase, secretMutationAllowed));
	} else if (status.vault.locked) {
		actions.append(vaultActionButton("Unlock", "unlock", passphrase, secretMutationAllowed));
	} else {
		actions.append(vaultActionButton("Lock", "lock", undefined, true));
		if (legacyRemaining.length > 0) {
			actions.append(vaultActionButton("Import .env.local", "migrate", undefined, secretMutationAllowed));
		}
		if (status.legacy.configuredFields.length > 0 && legacyRemaining.length === 0) {
			const remove = vaultActionButton(
				"Remove migrated entries",
				"remove-migrated-legacy",
				undefined,
				secretMutationAllowed,
			);
			remove.classList.add("danger");
			actions.append(remove);
		}
	}
	if (!secretMutationAllowed) {
		appendText(card, "Credential changes require this Pi host or authenticated HTTPS.", "muted");
	}
	card.append(actions);
	const advanced = document.createElement("details");
	advanced.className = "settings-advanced";
	const summary = document.createElement("summary");
	summary.textContent = "Storage details";
	advanced.append(summary);
	appendText(advanced, status.vault.path, "capability-meta");
	if (status.legacy.configuredFields.length > 0)
		appendText(advanced, `Legacy source: ${status.legacy.path}`, "capability-meta");
	if (status.legacy.unmanagedNames.length > 0)
		appendText(advanced, `Unmanaged: ${status.legacy.unmanagedNames.join(", ")}`, "capability-meta");
	card.append(advanced);
	settingsSecurityList.prepend(card);
}

function vaultActionButton(
	label: string,
	action: "initialize" | "unlock" | "lock" | "migrate" | "remove-migrated-legacy",
	passphrase: HTMLInputElement | undefined,
	enabled: boolean,
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.disabled = !enabled;
	button.title = enabled ? "" : "Use Settings on the Pi host or over authenticated HTTPS";
	button.addEventListener("click", () => {
		if (action === "remove-migrated-legacy" && !window.confirm("Remove migrated secret assignments from .env.local?"))
			return;
		button.disabled = true;
		void mutateCredentialVault(action, passphrase?.value).catch((error: unknown) => {
			setStatus(error instanceof Error ? error.message : String(error), true);
			button.disabled = false;
		});
	});
	return button;
}

function renderSettingsModels(): void {
	const byProvider = new Map<string, ModelMetadata[]>();
	for (const entry of availableModels) {
		const group = byProvider.get(entry.provider) ?? [];
		group.push(entry);
		byProvider.set(entry.provider, group);
	}
	settingsModelList.replaceChildren(
		...[...byProvider.entries()].map(([provider, models]) =>
			settingsCard(
				provider,
				`${models.length} usable model${models.length === 1 ? "" : "s"}`,
				"Ready",
				"Deployment",
				provider,
			),
		),
	);
	if (byProvider.size === 0) appendText(settingsModelList, "No usable models reported", "settings-empty");
}

function renderSettingsConnections(): void {
	const providers = capabilityCatalogSnapshot?.broker.providers.filter((provider) => provider.authentication) ?? [];
	const groupedProviders = [
		{
			title: "API and web services",
			description: "Credentials stored in your user vault.",
			providers: providers.filter((provider) => provider.authentication?.kind === "environment"),
		},
		{
			title: "Connected accounts",
			description: "Authorized service accounts.",
			providers: providers.filter((provider) => provider.authentication?.kind !== "environment"),
		},
	];
	const children: HTMLElement[] = [];
	for (const group of groupedProviders) {
		if (group.providers.length === 0) continue;
		const heading = document.createElement("header");
		heading.className = "settings-group-heading";
		const title = document.createElement("strong");
		title.textContent = group.title;
		heading.append(title);
		appendText(heading, group.description, "muted");
		children.push(heading);
		for (const provider of group.providers) {
			const connection = capabilityConnections.find(
				(entry) => entry.providerId === provider.id && entry.status !== "revoked",
			);
			const state = providerConnectionState(provider, connection);
			const description =
				provider.id === "pi-searxng"
					? "Private web search"
					: provider.id === "pi-firecrawl"
						? "Web search, scrape, and crawl"
						: (connection?.accountLabel ?? "");
			const card = settingsCard(provider.name, description, state, "User", provider.id);
			if (provider.id === "google-workspace") {
				const icon = document.createElement("span");
				icon.className = "settings-provider-icon";
				icon.textContent = "G";
				icon.setAttribute("aria-hidden", "true");
				card.querySelector(".settings-card-header")?.prepend(icon);
			}
			card.append(providerConfigurationForm(provider));
			const actions = document.createElement("div");
			actions.className = "settings-actions";
			if (provider.trust === "quarantined" || provider.trust === "unreviewed") {
				actions.append(capabilityProviderButton("Review", () => changeCapabilityProvider(provider.id, "review")));
			} else if (provider.enabled) {
				actions.append(capabilityProviderButton("Disable", () => changeCapabilityProvider(provider.id, "disable")));
			} else {
				const enable = capabilityProviderButton("Enable", () => changeCapabilityProvider(provider.id, "enable"));
				enable.disabled =
					provider.health === "missing-tools" ||
					(provider.connectionRequired === true && connection?.status !== "active");
				enable.title = enable.disabled
					? provider.health === "missing-tools"
						? "Install the required adapter first"
						: "Connect an account first"
					: "";
				actions.append(enable);
			}
			card.append(actions);
			children.push(card);
		}
	}
	settingsConnectionList.replaceChildren(...children);
	if (providers.length === 0)
		appendText(settingsConnectionList, "No configurable connections installed", "settings-empty");
}

function renderSettingsCapabilities(): void {
	const query = settingsCapabilitySearch.value.trim().toLowerCase();
	const broker = capabilityCatalogSnapshot?.broker;
	if (!broker) {
		settingsCapabilityList.replaceChildren();
		appendText(settingsCapabilityList, "Capability catalogue has not loaded", "settings-empty");
		return;
	}
	const cards = broker.capabilities
		.filter((capability) =>
			[capability.id, capability.name, capability.description, capability.category].some((value) =>
				value.toLowerCase().includes(query),
			),
		)
		.map((capability) => {
			const provider = resolveCapabilityProvider(broker, capability);
			const connectionState = provider ? providerCapabilityConnectionState(provider, capability.id) : "missing";
			const state = canonicalCapabilityState(capability, provider, connectionState);
			const card = settingsCard(
				capability.name,
				`${capability.effect} · ${provider?.name ?? "No provider"}`,
				state,
				"Deployment",
				capability.id,
			);
			appendText(card, capability.description, "capability-meta");
			if (provider && state !== "Ready") {
				const actions = document.createElement("div");
				actions.className = "settings-actions";
				const configure = document.createElement("button");
				configure.type = "button";
				configure.textContent = settingsRemediationLabel(provider, connectionState);
				configure.addEventListener("click", () => openProviderSettings(provider));
				actions.append(configure);
				card.append(actions);
			}
			return card;
		});
	settingsCapabilityList.replaceChildren(...cards);
	if (cards.length === 0) appendText(settingsCapabilityList, "No matching capabilities", "settings-empty");
}

function renderSettingsPlugins(): void {
	const snapshot = capabilityCatalogSnapshot;
	settingsPluginList.replaceChildren(
		...(snapshot?.broker.providers ?? [])
			.filter((provider) => !provider.authentication)
			.map((provider) => {
				const card = settingsCard(
					provider.name,
					`${provider.source}@${provider.version}`,
					provider.health === "missing-tools" ? "Unavailable" : provider.enabled ? "Ready" : "Disabled",
					"Deployment",
					provider.id,
				);
				const actions = document.createElement("div");
				actions.className = "settings-actions";
				if (provider.trust === "quarantined" || provider.trust === "unreviewed") {
					actions.append(
						capabilityProviderButton("Review", () => changeCapabilityProvider(provider.id, "review")),
					);
				} else if (provider.enabled) {
					actions.append(
						capabilityProviderButton("Disable", () => changeCapabilityProvider(provider.id, "disable")),
					);
				} else {
					const enable = capabilityProviderButton("Enable", () => changeCapabilityProvider(provider.id, "enable"));
					enable.disabled = provider.health === "missing-tools";
					actions.append(enable);
				}
				card.append(actions);
				return card;
			}),
		...(snapshot?.plugins ?? []).map((entry) => {
			const card = settingsCard(
				entry.name,
				entry.source ?? entry.description,
				canonicalEntryState(entry),
				"User",
				entry.id,
			);
			if (entry.source) {
				const actions = document.createElement("div");
				actions.className = "settings-actions";
				for (const action of ["update", "remove"] as const) {
					const button = document.createElement("button");
					button.type = "button";
					button.textContent = action === "update" ? "Update" : "Remove";
					if (action === "remove") button.className = "danger";
					button.addEventListener("click", () => void changePlugin(action, entry.source ?? "", entry.scope));
					actions.append(button);
				}
				card.append(actions);
			}
			return card;
		}),
	);
	settingsMcpList.replaceChildren(
		...(snapshot?.mcpServers ?? []).map((entry) =>
			settingsCard(entry.name, entry.description, canonicalEntryState(entry), "Deployment", entry.id),
		),
	);
}

function settingsCard(
	name: string,
	description: string,
	state: string,
	scope: "Project" | "User" | "Deployment",
	resourceId: string,
): HTMLElement {
	const card = document.createElement("article");
	card.className = "settings-card";
	card.dataset.settingsResource = resourceId;
	card.tabIndex = -1;
	const header = document.createElement("div");
	header.className = "settings-card-header";
	const title = document.createElement("strong");
	title.textContent = name;
	const badge = document.createElement("span");
	badge.className = "settings-badge";
	badge.textContent = scope;
	header.append(title, badge);
	card.append(header);
	if (description) appendText(card, description, "capability-meta");
	appendText(
		card,
		state,
		state === "Needs attention" || state === "Unavailable" ? "settings-state error" : "settings-state",
	);
	return card;
}

function canonicalEntryState(entry: CapabilityEntry): string {
	return entry.status === "active" ? "Ready" : entry.status === "available" ? "Setup required" : "Unavailable";
}

function providerConnectionState(
	provider: CapabilityProvider,
	connection: CapabilityConnectionSummary | undefined,
): string {
	if (!provider.authentication?.configured) return "Setup required";
	if (provider.health === "missing-tools") return "Unavailable";
	if (provider.authentication.kind === "environment") {
		if (provider.trust === "unreviewed" || provider.trust === "quarantined") return "Configured · review required";
		if (!provider.enabled) return "Configured · disabled";
		if (provider.health === "degraded") return "Degraded";
		return "Ready";
	}
	if (!connection) return "OAuth configured · account not connected";
	if (connection?.status === "unhealthy") return "Needs attention";
	if (provider.trust === "unreviewed" || provider.trust === "quarantined") return "Connected · review required";
	if (!provider.enabled) return "Connected · disabled";
	if (provider.health === "degraded") return "Connected · limited services";
	return "Ready";
}

function resolveCapabilityProvider(
	broker: CapabilitySnapshot["broker"],
	capability: BrokeredCapability,
): CapabilityProvider | undefined {
	const configuredDefault = broker.providers.find((provider) => provider.id === capability.defaultProviderId);
	if (configuredDefault) return configuredDefault;
	const candidates = capability.providers.flatMap((providerId) => {
		const provider = broker.providers.find((entry) => entry.id === providerId);
		return provider ? [provider] : [];
	});
	return candidates.find((provider) => provider.authentication?.configured) ?? candidates[0];
}

function canonicalCapabilityState(
	capability: BrokeredCapability,
	provider: CapabilityProvider | undefined,
	connectionState: CapabilityConnectionState,
): string {
	if (!provider || provider.health === "missing-tools" || capability.status === "unavailable") return "Unavailable";
	if (provider.authentication && !provider.authentication.configured) return "Configuration required";
	if (connectionState === "missing") return "Account not connected";
	if (connectionState === "unhealthy") return "Needs attention";
	if (connectionState === "not-granted") return "Access not granted";
	if (provider.trust === "unreviewed" || provider.trust === "quarantined") return "Review required";
	if (!provider.enabled) return "Disabled";
	return capability.status === "active" ? "Ready" : "Setup required";
}

function settingsRemediationLabel(provider: CapabilityProvider, connectionState: CapabilityConnectionState): string {
	if (provider.health === "missing-tools") return "Install";
	if (!provider.authentication?.configured) return "Configure";
	if (connectionState === "missing") return "Connect";
	if (connectionState === "unhealthy") return "Reconnect";
	if (connectionState === "not-granted") return "Update access";
	if (provider.trust === "unreviewed" || provider.trust === "quarantined") return "Review";
	return provider.enabled ? "Configure" : "Enable";
}

function providerCapabilityConnectionState(
	provider: CapabilityProvider,
	capabilityId: string,
): CapabilityConnectionState {
	if (!provider.connectionRequired) return "not-required";
	const connections = capabilityConnections.filter(
		(connection) => connection.providerId === provider.id && connection.status !== "revoked",
	);
	if (connections.length === 0) return "missing";
	if (connections.some((connection) => connection.status === "unhealthy")) return "unhealthy";
	return connections.some(
		(connection) => connection.status === "active" && connection.capabilityIds.includes(capabilityId),
	)
		? "ready"
		: "not-granted";
}

function openProviderSettings(provider: CapabilityProvider): void {
	openSettings(provider.authentication ? "connections" : "plugins", provider.id);
}

function createBrowserProfilePanel(): HTMLElement {
	const browserPanel = element("browser");
	const details = document.createElement("details");
	details.className = "card browser-profiles";
	const summary = document.createElement("summary");
	summary.textContent = "Signed-in profiles";
	summary.title = "Optional saved login state for browser workflows that access authenticated sites";
	const description = document.createElement("p");
	description.className = "muted browser-profile-description";
	description.textContent = "Optional. Use a named profile only when a workflow must stay signed in to a site.";
	const list = document.createElement("div");
	details.append(summary, description, list);
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
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) selected.add(reference);
					else selected.delete(reference);
					requiredElement<HTMLInputElement>("agent-browser-workflows").value = [...selected].sort().join(",");
					if (selected.size > 0) {
						requiredElement<HTMLSelectElement>("agent-browser-access").value = "loopback";
						updateAgentToolGrant("browser", true);
					} else updateAgentBuilderReadiness();
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
	scope: HTMLParagraphElement;
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
	saveButton: HTMLButtonElement;
} {
	const panel = element("routines");
	const card = document.createElement("div");
	card.className = "card";
	const title = document.createElement("strong");
	title.id = "routine-editor-title";
	title.textContent = "New schedule";
	const scope = document.createElement("p");
	scope.className = "muted";
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
	const saveButton = document.createElement("button");
	saveButton.type = "submit";
	saveButton.className = "primary";
	saveButton.textContent = "Save schedule";
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
	actions.append(saveButton, runButton, clearButton, deleteButton);
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
	card.append(title, scope, form);
	panel.insertBefore(card, routineList);
	return {
		form,
		scope,
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
		saveButton,
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

function setSessionPath(path: string, editable: boolean): void {
	sessionPath.textContent = path ? formatWorkingDirectory(path) : "No workspace";
	sessionPath.title = editable ? `Change target folder · ${path}` : path;
	sessionPath.dataset.path = path;
	sessionPath.disabled = !editable;
	sessionPath.setAttribute("aria-label", editable ? `Change target folder from ${path}` : `Workspace ${path}`);
	if (!editable) closeSessionPathEditor();
}

function closeSessionPathEditor(): void {
	sessionPathForm.classList.add("hidden");
	sessionPath.classList.remove("hidden");
}

function openSessionPathEditor(): void {
	if (sessionPath.disabled) return;
	sessionPathInput.value = sessionPath.dataset.path ?? "";
	sessionPath.classList.add("hidden");
	sessionPathForm.classList.remove("hidden");
	sessionPathInput.focus();
	sessionPathInput.select();
}

async function saveTargetPath(path: string): Promise<void> {
	const projectRoot = path.trim();
	if (!projectRoot) throw new Error("Enter a target directory");
	if (activeExternalConnectionId) {
		if (
			externalRuns.some(
				(run) =>
					run.connectionId === activeExternalConnectionId &&
					(run.status === "starting" || run.status === "running"),
			)
		)
			throw new Error("Wait for the delegated response to finish");
		requiredElement<HTMLInputElement>("external-cwd").value = projectRoot;
		localStorage.setItem(`pi-serve-external-cwd:${activeExternalConnectionId}`, projectRoot);
		const connection = externalConnections.find((entry) => entry.id === activeExternalConnectionId);
		if (connection) renderExternalConversation(connection);
		closeSessionPathEditor();
		setStatus(`Next delegated request: ${formatWorkingDirectory(projectRoot)}`);
		return;
	}
	const agent = agents.find((entry) => entry.id === activeAgentId);
	if (!agent) throw new Error("The selected agent is unavailable");
	if (agent.source !== "managed") throw new Error("Markdown catalog agents must be edited in their source file");
	if (agentTasksByAgent.get(agent.id)?.some((task) => task.status === "queued" || task.status === "running"))
		throw new Error("Wait for the agent task to finish");
	if (!capabilityToken) throw new Error("The capability token is missing");
	const response = await fetch(
		`/agents/${encodeURIComponent(agent.id)}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				personaId: agent.personaId,
				name: agent.name,
				description: agent.description,
				projectRoot,
				tools: agent.tools,
				capabilities: agent.capabilities,
				memory: agent.memory,
				persona: agent.persona,
				executor: agent.executor,
				permissionPolicy: agent.permissionPolicy,
				model: agent.model,
				thinking: agent.thinking,
				delegateAgentIds: agent.delegateAgentIds,
				a2a: agent.a2a,
				browser: agent.browser,
				browserWorkflows: agent.browserWorkflows,
				schedules: agent.schedules,
			}),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not update agent target directory"));
	closeSessionPathEditor();
	await loadAgents();
	const updated = agents.find((entry) => entry.id === agent.id);
	if (updated && activeAgentId === updated.id) await openAgent(updated);
	setStatus(`Agent target: ${formatWorkingDirectory(projectRoot)}`);
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
	if (activeExternalRunId) return;
	if (activeExternalConnectionId) return;
	if (activeArtifactId) return;
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
	transcript.replaceChildren(...earlier, ...window.items.map(builderDisplayItem).map(renderItem));
	setBusy(snapshot);
	replacePrimaryModelOptions(availableModels);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
	modelPicker.refresh();
	thinking.value = snapshot.thinkingLevel;
	updateThinkingLevelAvailability(thinking, model.value, snapshot.thinkingLevel);
	input.disabled = false;
	input.placeholder = "Message Pi…";
	input.setAttribute("aria-label", "Message Pi");
	setSessionPath(snapshot.cwd, false);
	renderSessionStats(snapshot);
	transcript.scrollTop = nearBottom ? transcript.scrollHeight : previousScrollTop;
}

function renderBuilderConversation(snapshot: SessionSnapshot): void {
	if (!builderActive) return;
	const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
	const guide = document.createElement("section");
	guide.className = "builder-guide";
	const heading = document.createElement("div");
	heading.className = "builder-guide-heading";
	const title = document.createElement("strong");
	title.textContent = pendingTeamPackage
		? pendingTeamPackage.preview.team.name
		: teamFactoryDraft && !activeSidebarAgent
			? "Build a canonical agent team"
			: activeSidebarAgent && activeAgentImprovement
				? `${improvementRouteLabel(activeAgentImprovement.route)} ${activeSidebarAgent.name}`
				: activeSidebarAgent
					? `Refine ${activeSidebarAgent.name}`
					: "Build an agent or team";
	const lifecycle = document.createElement("span");
	lifecycle.className = "builder-stage";
	lifecycle.dataset.stage = activeAgentBuild?.stage ?? "draft";
	lifecycle.textContent = agentBuildStageLabel(activeAgentBuild);
	const openTeam = document.createElement("button");
	openTeam.type = "button";
	openTeam.className = "secondary-action";
	openTeam.textContent = pendingTeamPackage ? "Change package" : "Import package";
	openTeam.title = "Open the bundle.json and runtime.json generated by the WTK pi-agents target";
	openTeam.addEventListener("click", () => teamPackageInput.click());
	const useWtk = document.createElement("button");
	useWtk.type = "button";
	useWtk.className = "secondary-action";
	useWtk.textContent = "Build canonical package";
	useWtk.title = "Use the optional WTK catalog and compiler for this team";
	useWtk.addEventListener("click", () => {
		teamFactoryDraft = { phase: "intake", messages: [] };
		persistTeamFactoryDraft();
		if (session?.snapshot) renderBuilderConversation(session.snapshot);
	});
	const advanced = document.createElement("button");
	advanced.type = "button";
	advanced.className = "secondary-action";
	advanced.textContent = "Advanced configuration";
	advanced.title = "Review and edit the generated agent configuration";
	advanced.addEventListener("click", () => {
		activateTab("agent-builder");
		mobilePanelRight.checked = true;
	});
	const apply = document.createElement("button");
	apply.type = "button";
	apply.id = "builder-chat-apply";
	apply.className = "primary-action";
	apply.textContent = activeSidebarAgent ? "Save candidate" : "Publish agent";
	apply.title = "Apply the reviewed agent configuration without another model call";
	apply.addEventListener("click", () => agentForm.requestSubmit());
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary-action";
	cancel.textContent = "Exit editing";
	cancel.addEventListener("click", () => void closeBuilderChat());
	if (pendingTeamPackage) heading.append(title, openTeam, cancel);
	else {
		heading.append(title, lifecycle, openTeam, advanced, apply);
		const lifecycleAction = agentBuildLifecycleAction();
		if (lifecycleAction) heading.append(lifecycleAction);
		if (teamFactoryAvailable && !teamFactoryDraft && !activeSidebarAgent) heading.append(useWtk);
		if (teamFactoryDraft?.reviewReady && !activeSidebarAgent) {
			const approveBrief = document.createElement("button");
			approveBrief.type = "button";
			approveBrief.className = "primary-action";
			approveBrief.disabled = teamFactoryBusy;
			approveBrief.textContent = "Approve brief";
			approveBrief.addEventListener("click", () => void submitTeamFactory("confirm", "Approve brief"));
			heading.append(approveBrief);
		}
		if (teamFactoryBusy && teamFactoryDraft?.operationId && !activeSidebarAgent) {
			const stopBuild = document.createElement("button");
			stopBuild.type = "button";
			stopBuild.className = "secondary-action danger-action";
			stopBuild.textContent = "Stop build";
			stopBuild.addEventListener("click", () => void controlTeamFactoryOperation("cancel"));
			heading.append(stopBuild);
		}
		heading.append(cancel);
	}
	const guidance = document.createElement("p");
	guidance.className = "muted";
	guidance.textContent = pendingTeamPackage
		? "Review the compiled team and its local bindings before launch."
		: teamFactoryDraft && !activeSidebarAgent
			? teamFactoryBusy
				? "WTK is building the canonical package. You can leave this view and return without stopping it."
				: "Continue the optional canonical package build here. Pi remains usable without WTK."
			: activeSidebarAgent && activeAgentImprovement
				? `${activeAgentImprovement.objective} Success: ${activeAgentImprovement.successCriteria}`
				: snapshot.transcript.length === 0
					? "Describe the outcome, working folder, and access the agent needs. Pi will build the agent locally."
					: "Continue refining the agent here, or review the generated settings.";
	guide.append(heading, guidance);
	if (activeAgentBuild) guide.append(renderAgentPackageSummary(activeAgentBuild));
	if (activeAgentBuild?.stage === "testing" && agentBuildPollTimer === undefined) {
		agentBuildPollTimer = window.setTimeout(() => {
			agentBuildPollTimer = undefined;
			void refreshActiveAgentBuild().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		}, 1_500);
	}
	if (pendingTeamPackage) guide.append(renderTeamPackageReview(pendingTeamPackage.preview));
	transcript.replaceChildren(
		guide,
		...(teamFactoryDraft && !activeSidebarAgent
			? teamFactoryDraft.messages.map(renderTeamFactoryMessage)
			: snapshot.transcript.map(builderDisplayItem).map(renderItem)),
	);
	setBusy(snapshot);
	if (teamFactoryBusy) {
		model.disabled = true;
		thinking.disabled = true;
		send.disabled = true;
		phase.textContent = teamFactoryDraft?.phase ?? "building";
	}
	replacePrimaryModelOptions(availableModels);
	model.value = `${snapshot.model.provider}/${snapshot.model.id}`;
	modelPicker.refresh();
	thinking.value = snapshot.thinkingLevel;
	updateThinkingLevelAvailability(thinking, model.value, snapshot.thinkingLevel);
	input.disabled = false;
	input.placeholder = `Message ${builderLabel}…`;
	input.setAttribute("aria-label", `Message ${builderLabel}`);
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	attachmentButton.title = "Agent Builder attachments are not available yet";
	attachmentList.replaceChildren();
	const projectRoot = requiredElement<HTMLInputElement>("agent-project-root").value;
	setSessionPath(projectRoot || "Agent Builder", false);
	renderSessionStats(snapshot);
	setStatus(projectRoot || "Configure and deploy a local agent");
	if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
	if (!teamFactoryDraft || activeSidebarAgent) applyLatestAgentBuilderDraft(snapshot);
	updateAgentBuilderReadiness();
}

function renderAgentPackageSummary(build: AgentBuildRecord): HTMLElement {
	const details = document.createElement("details");
	details.className = "card agent-package-summary";
	const summary = document.createElement("summary");
	summary.textContent = `Agent package · build revision ${build.revision}${build.agentRevision ? ` · agent revision ${build.agentRevision}` : ""}`;
	details.append(summary);
	const configuration = build.configuration;
	if (configuration) {
		const changed = activeSidebarAgent
			? agentConfigurationChanges(configuration, activeSidebarAgent)
			: ["New package"];
		appendText(details, `Candidate changes: ${changed.length > 0 ? changed.join(", ") : "none"}`, "muted");
		appendText(
			details,
			`Model: ${configuration.model ? `${configuration.model.provider}/${configuration.model.id}` : "session default"} · Tools: ${configuration.tools.join(", ") || "none"} · Permissions: ${configuration.permissionPolicy}`,
			"muted",
		);
	}
	appendText(
		details,
		`Criteria: ${build.criteria.length} · Proof attempts: ${build.proofHistory.length + (build.proof ? 1 : 0)} · Evidence checks: ${build.evaluation?.checks.length ?? 0} · Feedback entries: ${build.feedback.length}`,
		"muted",
	);
	const criteria = document.createElement("ul");
	criteria.className = "muted";
	for (const criterion of build.criteria) {
		const item = document.createElement("li");
		const result = build.evaluation?.checks.find((check) => check.criterionId === criterion.id);
		item.textContent = `${result ? `${result.status.toUpperCase()} · ` : ""}${criterion.label}`;
		criteria.append(item);
	}
	details.append(criteria);
	if (build.automationIntent) {
		appendText(
			details,
			`Inactive schedule intent: ${build.automationIntent.cadence} ${build.automationIntent.timezone} · ${build.automationIntent.task}`,
			"muted",
		);
	}
	return details;
}

function agentConfigurationChanges(
	configuration: NonNullable<AgentBuildRecord["configuration"]>,
	active: AgentSummary,
): string[] {
	const changes: string[] = [];
	if (configuration.description !== active.description) changes.push("description");
	if (configuration.persona !== active.persona) changes.push("persona instructions");
	if (configuration.projectRoot !== active.projectRoot) changes.push("project folder");
	if (configuration.tools.join("\0") !== active.tools.join("\0")) changes.push("tools");
	if (
		`${configuration.model?.provider ?? ""}/${configuration.model?.id ?? ""}` !==
		`${active.model?.provider ?? ""}/${active.model?.id ?? ""}`
	)
		changes.push("model");
	if (configuration.thinking !== active.thinking) changes.push("thinking");
	if (configuration.executor !== active.executor) changes.push("executor");
	if (configuration.permissionPolicy !== active.permissionPolicy) changes.push("permissions");
	if (configuration.browserAccess !== (active.browser?.access ?? "disabled")) changes.push("browser access");
	if (configuration.delegateAgentIds.join("\0") !== active.delegateAgentIds.join("\0")) changes.push("delegates");
	if (configuration.exposeA2a !== active.a2a.enabled) changes.push("A2A exposure");
	return changes;
}

function agentBuildStageLabel(record: AgentBuildRecord | undefined): string {
	if (!record) return "Name the draft";
	return {
		draft: "Draft saved",
		"ready-to-test": "Ready to test",
		testing: "Testing",
		"proof-ready": "Review proof",
		"needs-refinement": "Refine and retry",
		proven: "Proof accepted",
		promoted: "Skill created",
		automated: "Automated",
	}[record.stage];
}

function agentBuildLifecycleAction(): HTMLButtonElement | undefined {
	const build = activeAgentBuild;
	if (!build || build.stage === "automated" || (build.stage === "draft" && !build.agentId)) return undefined;
	const button = document.createElement("button");
	button.type = "button";
	button.className = "lifecycle-action";
	if (build.stage === "testing") {
		button.textContent = "Testing…";
		button.disabled = true;
		return button;
	}
	if (build.stage === "proof-ready") {
		button.textContent = "Review proof";
		button.addEventListener("click", () => void openAgentBuildProofReview());
		return button;
	}
	if (build.stage === "proven") {
		button.textContent = "Save as skill";
		button.addEventListener("click", () => void openLifecycleSkillPromotion());
		return button;
	}
	if (build.stage === "promoted") {
		button.textContent = "Add routine";
		button.addEventListener("click", () => void stageRoutineFromBuild());
		return button;
	}
	button.textContent =
		build.stage === "needs-refinement" ? "Run same proof" : build.stage === "draft" ? "Try candidate" : "Try agent";
	button.addEventListener("click", openAgentBuildProofDialog);
	return button;
}

function openAgentBuildProofDialog(): void {
	if (!activeAgentBuild?.agentId) {
		setStatus("Create the agent before running a proof", true);
		return;
	}
	const build = activeAgentBuild;
	const dialog = document.createElement("dialog");
	dialog.className = "promotion-dialog";
	const form = document.createElement("form");
	form.method = "dialog";
	const heading = document.createElement("strong");
	heading.textContent = `Try ${build.name}`;
	const explanation = document.createElement("p");
	explanation.className = "muted";
	explanation.textContent = "Run one concrete task. Automation stays locked until you review the retained result.";
	const prompt = document.createElement("textarea");
	prompt.required = true;
	prompt.maxLength = 16_384;
	prompt.value = build.proofPrompt ?? `Prove this agent can complete its goal: ${build.objective}`;
	const label = document.createElement("label");
	label.append(document.createTextNode("One-time proof task"), prompt);
	const actions = document.createElement("div");
	actions.className = "promotion-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary-action";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => dialog.close());
	const run = document.createElement("button");
	run.type = "submit";
	run.textContent = "Run proof";
	actions.append(cancel, run);
	form.append(heading, explanation, label, actions);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!form.reportValidity() || !capabilityToken) return;
		run.disabled = true;
		void fetch(`/agent-builds/${encodeURIComponent(build.id)}/proof?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: prompt.value }),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(await responseError(response, "Could not start proof"));
				const payload: unknown = await response.json();
				if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid proof");
				activeAgentBuild = payload;
				dialog.close();
				if (session?.snapshot) renderBuilderConversation(session.snapshot);
				setStatus(`Testing ${build.name} in an isolated one-time run`);
			})
			.catch((error: unknown) => {
				run.disabled = false;
				setStatus(error instanceof Error ? error.message : String(error), true);
			});
	});
	dialog.addEventListener("close", () => dialog.remove());
	dialog.append(form);
	document.body.append(dialog);
	dialog.showModal();
	prompt.focus();
	prompt.select();
}

async function openAgentBuildProofReview(): Promise<void> {
	if (!capabilityToken || !activeAgentBuild?.proof) return;
	const build = activeAgentBuild;
	const proof = activeAgentBuild.proof;
	const response = await fetch(
		`/runs/${encodeURIComponent(proof.runId)}/result?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not load proof result"));
	const result = await response.text();
	const dialog = document.createElement("dialog");
	dialog.className = "promotion-dialog proof-review-dialog";
	const heading = document.createElement("strong");
	heading.textContent = `Review ${build.name} proof`;
	const explanation = document.createElement("p");
	explanation.className = "muted";
	explanation.textContent =
		"Accept only if the retained evidence and result prove this revision can repeat the task safely.";
	const comparison = document.createElement("p");
	comparison.className = "muted";
	const previous = build.proofHistory.at(-1);
	if (previous?.evaluation) {
		const passed = previous.evaluation.checks.filter((check) => check.status === "pass").length;
		const failed = previous.evaluation.checks.filter((check) => check.status === "fail").length;
		comparison.textContent = `Previous proof · revision ${previous.proof?.agentRevision ?? "unknown"} · ${passed} passed · ${failed} failed. Current proof · revision ${proof.agentRevision}.`;
	} else
		comparison.textContent = `Current proof · revision ${proof.agentRevision} · no comparable prior evaluation retained.`;
	const checks = document.createElement("div");
	checks.className = "proof-evaluation";
	for (const check of build.evaluation?.checks ?? []) {
		const criterion = build.criteria.find((candidate) => candidate.id === check.criterionId);
		const row = document.createElement("div");
		row.className = `card proof-check proof-check-${check.status}`;
		const label = document.createElement("strong");
		label.textContent = `${check.status === "pass" ? "Pass" : check.status === "fail" ? "Fail" : "Unverified"}: ${criterion?.label ?? check.criterionId}`;
		const summary = document.createElement("span");
		summary.className = "muted";
		summary.textContent = check.summary;
		row.append(label, summary);
		checks.append(row);
	}
	const output = document.createElement("pre");
	output.textContent = result;
	const rating = document.createElement("select");
	for (const [value, text] of [
		[1, "1 · Unusable"],
		[2, "2 · Materially flawed"],
		[3, "3 · Useful with limitations"],
		[4, "4 · Meets goal"],
		[5, "5 · Fully accomplished"],
	] as const) {
		const option = document.createElement("option");
		option.value = String(value);
		option.textContent = text;
		if (value === 2) option.selected = true;
		rating.append(option);
	}
	const feedback = document.createElement("textarea");
	feedback.placeholder = "What failed, what should change, and what should be preserved?";
	feedback.maxLength = 4_000;
	const feedbackLabel = document.createElement("label");
	feedbackLabel.append(document.createTextNode("Improvement feedback"), rating, feedback);
	const actions = document.createElement("div");
	actions.className = "promotion-actions";
	const refine = document.createElement("button");
	refine.type = "button";
	refine.className = "secondary-action";
	refine.textContent = "Needs refinement";
	const accept = document.createElement("button");
	accept.type = "button";
	accept.textContent = "Accept proof";
	const blockingChecks = (build.evaluation?.checks ?? []).filter((check) => {
		const criterion = build.criteria.find((candidate) => candidate.id === check.criterionId);
		return criterion?.expectation !== "advisory" && criterion?.evaluator.type !== "human" && check.status !== "pass";
	});
	accept.disabled = blockingChecks.length > 0;
	if (blockingChecks.length > 0) accept.title = "Required evidence checks must pass before this proof can be accepted";
	const review = async (accepted: boolean): Promise<void> => {
		const reviewResponse = await fetch(
			`/agent-builds/${encodeURIComponent(build.id)}/proof-review?token=${encodeURIComponent(capabilityToken)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ accepted }),
			},
		);
		if (!reviewResponse.ok) throw new Error(await responseError(reviewResponse, "Could not review proof"));
		const payload: unknown = await reviewResponse.json();
		if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid review");
		activeAgentBuild = payload;
		dialog.close();
		if (!accepted) {
			input.value = `Refine ${build.name} using this rejected proof as evidence. Keep the smallest safe change.`;
			resizeComposer();
			input.focus();
		}
		if (session?.snapshot) renderBuilderConversation(session.snapshot);
		setStatus(
			accepted ? "Proof accepted. Review and save it as a reusable skill." : "Proof rejected. Refine and retry.",
		);
	};
	refine.addEventListener("click", () => {
		if (!feedback.value.trim()) {
			feedback.focus();
			setStatus("Describe what should improve before rejecting the proof", true);
			return;
		}
		void fetch(
			`/agent-builds/${encodeURIComponent(build.id)}/feedback?token=${encodeURIComponent(capabilityToken)}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					rating: Number(rating.value),
					summary: feedback.value.trim(),
					answers: [
						{
							aspect: "goal-obligation",
							question: "What should change while preserving successful behavior?",
							answer: feedback.value.trim(),
						},
					],
				}),
			},
		)
			.then(async (feedbackResponse) => {
				if (!feedbackResponse.ok) throw new Error(await responseError(feedbackResponse, "Could not save feedback"));
				const payload: unknown = await feedbackResponse.json();
				if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned invalid feedback");
				activeAgentBuild = payload;
				dialog.close();
				input.value = `Improve ${build.name} using the retained failed proof, feedback, and criteria. Preserve every passing criterion.`;
				resizeComposer();
				input.focus();
				if (session?.snapshot) renderBuilderConversation(session.snapshot);
				setStatus("Feedback retained. Refine the candidate and run the same proof again.");
			})
			.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
	});
	accept.addEventListener("click", () => void review(true).catch((error: unknown) => setStatus(String(error), true)));
	actions.append(refine, accept);
	dialog.append(heading, explanation, comparison, checks, output, feedbackLabel, actions);
	dialog.addEventListener("close", () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
}

async function openLifecycleSkillPromotion(): Promise<void> {
	if (!capabilityToken || !activeAgentBuild?.proof || !activeSidebarAgent) return;
	const response = await fetch(
		`/runs/${encodeURIComponent(activeAgentBuild.proof.runId)}/result?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not load proof result"));
	openSkillPromotionReview(
		{
			id: activeAgentBuild.proof.runId,
			conversationId: "",
			agentId: activeSidebarAgent.id,
			status: "completed",
			prompt: activeAgentBuild.proof.prompt,
			createdAt: activeAgentBuild.proof.finishedAt ?? Date.now(),
			attemptIds: [activeAgentBuild.proof.runId],
			artifactIds: [],
			result: await response.text(),
		},
		activeSidebarAgent,
	);
}

async function stageRoutineFromBuild(): Promise<void> {
	if (!activeAgentBuild?.proof || !activeSidebarAgent) return;
	const intent = activeAgentBuild.automationIntent;
	await stageRoutineFromTask(
		{
			id: activeAgentBuild.proof.runId,
			conversationId: "",
			agentId: activeSidebarAgent.id,
			status: "completed",
			prompt: intent?.task ?? activeAgentBuild.proof.prompt,
			createdAt: activeAgentBuild.proof.finishedAt ?? Date.now(),
			attemptIds: [activeAgentBuild.proof.runId],
			artifactIds: [],
		},
		activeSidebarAgent,
	);
	if (intent) {
		applyAutomationIntent(intent.cadence);
		routineEditor.timezone.value = intent.timezone;
		setStatus("Schedule intent restored. Review it and explicitly enable it before saving.");
	}
}

function applyAutomationIntent(cadence: string): void {
	const daily = /^daily\s+(\d{2}:\d{2})$/i.exec(cadence);
	const weekly = /^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{2}:\d{2})$/i.exec(cadence);
	const every = /^every\s+(\d+)(m|h)$/i.exec(cadence);
	if (daily?.[1]) {
		routineEditor.preset.value = "daily";
		routineEditor.time.value = daily[1];
		updateRoutineCronFromPreset();
		return;
	}
	if (/^hourly$/i.test(cadence)) {
		routineEditor.preset.value = "hourly";
		updateRoutineCronFromPreset();
		return;
	}
	if (weekly?.[1] && weekly[2]) {
		const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekly[1].toLowerCase());
		const [hour, minute] = weekly[2].split(":");
		routineEditor.preset.value = "custom";
		routineEditor.time.value = weekly[2];
		routineEditor.cron.value = `${Number(minute)} ${Number(hour)} * * ${day}`;
		updateRoutineCronFromPreset();
		return;
	}
	if (every?.[1] && every[2]) {
		const interval = Number(every[1]);
		routineEditor.preset.value = "custom";
		routineEditor.cron.value = every[2].toLowerCase() === "m" ? `*/${interval} * * * *` : `0 */${interval} * * *`;
		updateRoutineCronFromPreset();
	}
}

function renderTeamPackageReview(preview: PiAgentTeamPreview): HTMLElement {
	const card = document.createElement("section");
	card.className = "team-review";
	const summary = document.createElement("p");
	summary.textContent = `${preview.team.roles.length} members · ${preview.team.workflow.nodeCount} steps · up to ${preview.team.workflow.maxConcurrency} concurrent`;
	const members = document.createElement("div");
	members.className = "team-review-members";
	for (const role of preview.team.roles) {
		const member = document.createElement("div");
		const name = document.createElement("strong");
		name.textContent = role.name;
		const detail = document.createElement("span");
		detail.textContent = `${role.model.id} · ${role.permissionPolicy}${role.id === preview.team.coordinatorRoleId ? " · coordinator" : ""}`;
		member.append(name, detail);
		members.append(member);
	}
	const access = document.createElement("p");
	access.className = "muted";
	access.textContent = `${formatWorkingDirectory(preview.bindings.projectRoot)} · ${preview.bindings.credentialRefs.length} credential reference${preview.bindings.credentialRefs.length === 1 ? "" : "s"}`;
	const launch = document.createElement("button");
	launch.type = "button";
	launch.className = "primary-action";
	launch.disabled = teamLaunchBusy;
	launch.textContent = teamLaunchBusy ? "Launching…" : "Launch team";
	launch.addEventListener("click", () => {
		void launchPendingTeamPackage().catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		);
	});
	card.append(summary, members, access, launch);
	return card;
}

function renderTeamFactoryMessage(message: TeamFactoryDraft["messages"][number]): HTMLElement {
	const element = document.createElement("article");
	element.className = `message ${message.role}`;
	const text = document.createElement("div");
	text.textContent = message.text;
	element.append(text);
	return element;
}

async function prepareTeamPackageFiles(files: readonly File[]): Promise<void> {
	if (!capabilityToken) throw new Error("The capability token is missing");
	const documents: unknown[] = [];
	for (const file of files) documents.push(JSON.parse(await file.text()) as unknown);
	let bundle: unknown;
	let bindings: unknown;
	for (const document of documents) {
		if (!isJsonObject(document)) continue;
		if (document.schemaVersion === "pi.agents.bundle.v1") bundle = document;
		if (document.schemaVersion === "wtk.pi-agents-runtime.v1") bindings = document.bindings;
		if (document.bundle !== undefined) bundle = document.bundle;
		if (document.bindings !== undefined && document.schemaVersion !== "pi.agents.bundle.v1") {
			bindings = document.bindings;
		}
	}
	if (bundle === undefined || bindings === undefined) {
		throw new Error("Select the WTK pi-agents bundle.json and runtime.json files together");
	}
	setStatus("Reviewing WTK team package…");
	const response = await fetch(`/agent-teams/prepare?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ bundle, bindings }),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not prepare WTK team package"));
	const preview: unknown = await response.json();
	if (!isPiAgentTeamPreview(preview)) throw new Error("Pi returned an invalid team preview");
	pendingTeamPackage = { bundle, bindings, preview };
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
	setStatus("Team package ready to review");
}

async function launchPendingTeamPackage(): Promise<void> {
	if (!capabilityToken || !pendingTeamPackage || teamLaunchBusy) return;
	teamLaunchBusy = true;
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
	setStatus("Launching team…");
	try {
		const response = await fetch(`/agent-teams/launch?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				bundle: pendingTeamPackage.bundle,
				bindings: pendingTeamPackage.bindings,
				approvalDigest: pendingTeamPackage.preview.approvalDigest,
				reviewedBy: "pi-serve-operator",
			}),
		});
		if (!response.ok) throw new Error(await responseError(response, "Could not launch WTK team"));
		const result: unknown = await response.json();
		const coordinatorAgentId = teamLaunchCoordinatorAgentId(result);
		pendingTeamPackage = undefined;
		teamFactoryDraft = undefined;
		persistTeamFactoryDraft();
		if (agentsLoadPromise) await agentsLoadPromise;
		await loadAgentsNow();
		const coordinator = agents.find((agent) => agent.id === coordinatorAgentId);
		if (!coordinator) throw new Error("The installed team coordinator is not available");
		await openAgent(coordinator);
		setStatus(`Team ready · ${coordinator.name}`);
	} finally {
		teamLaunchBusy = false;
		if (pendingTeamPackage && session?.snapshot) renderBuilderConversation(session.snapshot);
	}
}

async function loadTeamFactoryStatus(): Promise<void> {
	if (!capabilityToken || activeSidebarAgent) return;
	const response = await fetch(`/agent-team-factory?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not inspect the canonical team builder"));
	const value: unknown = await response.json();
	teamFactoryAvailable = isJsonObject(value) && value.available === true;
	if (teamFactoryDraft?.operationId && !teamFactoryBusy) {
		teamFactoryBusy = true;
		if (session?.snapshot) renderBuilderConversation(session.snapshot);
		void followTeamFactoryOperation(teamFactoryDraft.operationId)
			.catch((error: unknown) => {
				if (!teamFactoryDraft) return;
				teamFactoryDraft.phase = "failed";
				teamFactoryDraft.operationId = undefined;
				teamFactoryDraft.messages.push({
					role: "assistant",
					text: error instanceof Error ? error.message : "Canonical team build failed",
				});
				persistTeamFactoryDraft();
				setStatus(error instanceof Error ? error.message : String(error), true);
			})
			.finally(() => {
				teamFactoryBusy = false;
				if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
			});
	} else if (
		teamFactoryAvailable &&
		teamFactoryDraft?.phase === "prepare" &&
		teamFactoryDraft.pkgId &&
		!pendingTeamPackage
	) {
		teamFactoryBusy = true;
		void prepareBuiltTeam(teamFactoryDraft.pkgId)
			.catch((error: unknown) => {
				if (teamFactoryDraft) teamFactoryDraft.phase = "failed";
				persistTeamFactoryDraft();
				setStatus(error instanceof Error ? error.message : String(error), true);
			})
			.finally(() => {
				teamFactoryBusy = false;
				if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
			});
	}
}

async function submitTeamFactory(prompt: string, displayPrompt = prompt): Promise<void> {
	if (!capabilityToken || teamFactoryBusy) return;
	teamFactoryDraft ??= { phase: "intake", messages: [] };
	teamFactoryDraft.messages.push({ role: "user", text: displayPrompt });
	teamFactoryBusy = true;
	persistTeamFactoryDraft();
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
	try {
		if (teamFactoryDraft.paused && teamFactoryDraft.operationId) {
			teamFactoryDraft.paused = false;
			const operation = await controlTeamFactoryOperation("resume", prompt);
			if (operation) await followTeamFactoryOperation(operation.id);
			return;
		}
		if (teamFactoryDraft.phase === "failed" && teamFactoryDraft.pkgId) {
			teamFactoryDraft.phase = "prepare";
			await prepareBuiltTeam(teamFactoryDraft.pkgId);
			return;
		}
		const path = teamFactoryDraft.sessionId
			? "/agent-team-factory/intake/message"
			: "/agent-team-factory/intake/start";
		const response = await fetch(`${path}?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				input: prompt,
				...(teamFactoryDraft.sessionId ? { sessionId: teamFactoryDraft.sessionId } : {}),
			}),
		});
		if (!response.ok) throw new Error(await responseError(response, "WTK could not start the team brief"));
		const accepted = teamFactoryAccepted(await response.json());
		teamFactoryDraft.sessionId = accepted.sessionId ?? teamFactoryDraft.sessionId;
		teamFactoryDraft.operationId = accepted.operation.id;
		persistTeamFactoryDraft();
		await followTeamFactoryOperation(accepted.operation.id);
	} catch (error) {
		teamFactoryDraft.phase = "failed";
		teamFactoryDraft.operationId = undefined;
		teamFactoryDraft.messages.push({
			role: "assistant",
			text: error instanceof Error ? error.message : "Canonical team build failed",
		});
		persistTeamFactoryDraft();
		setStatus(error instanceof Error ? error.message : String(error), true);
	} finally {
		teamFactoryBusy = false;
		if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
	}
}

async function followTeamFactoryOperation(operationId: string): Promise<void> {
	if (!capabilityToken || !teamFactoryDraft) return;
	for (;;) {
		const response = await fetch(
			`/agent-team-factory/operation?id=${encodeURIComponent(operationId)}&token=${encodeURIComponent(capabilityToken)}`,
		);
		if (!response.ok) throw new Error(await responseError(response, "Could not read WTK build progress"));
		const operation = teamFactoryOperation(await response.json());
		if (operation.progress?.message) setStatus(operation.progress.message);
		if (operation.status === "failed" || operation.status === "cancelled") {
			throw new Error(operation.error?.message ?? `WTK operation ${operation.status}`);
		}
		if (operation.status === "paused") {
			teamFactoryDraft.paused = true;
			teamFactoryDraft.messages.push({
				role: "assistant",
				text: "Build paused at a safe boundary. Send direction here to resume it.",
			});
			persistTeamFactoryDraft();
			return;
		}
		if (operation.status === "succeeded") {
			teamFactoryDraft.operationId = undefined;
			persistTeamFactoryDraft();
			await advanceTeamFactory(operation.result);
			return;
		}
		await new Promise((resolve) => window.setTimeout(resolve, 1_000));
	}
}

async function controlTeamFactoryOperation(
	action: "cancel" | "pause" | "resume" | "steer",
	message?: string,
): Promise<TeamFactoryOperation | undefined> {
	if (!capabilityToken || !teamFactoryDraft?.operationId) return undefined;
	const response = await fetch(`/agent-team-factory/operation/control?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ operationId: teamFactoryDraft.operationId, action, ...(message ? { message } : {}) }),
	});
	if (!response.ok) throw new Error(await responseError(response, `Could not ${action} WTK build`));
	const operation = teamFactoryOperation(await response.json());
	teamFactoryDraft.operationId = operation.id;
	teamFactoryDraft.paused = operation.status === "paused";
	if (action === "cancel") teamFactoryDraft.phase = "failed";
	persistTeamFactoryDraft();
	return operation;
}

async function advanceTeamFactory(resultValue: unknown): Promise<void> {
	if (!capabilityToken || !teamFactoryDraft) return;
	const result = isJsonObject(resultValue) ? resultValue : {};
	if (teamFactoryDraft.phase === "intake") {
		teamFactoryDraft.sessionId = typeof result.sessionId === "string" ? result.sessionId : teamFactoryDraft.sessionId;
		teamFactoryDraft.reviewReady = result.reviewReady === true;
		const response =
			isJsonObject(result.conversationMove) && typeof result.conversationMove.response === "string"
				? result.conversationMove.response
				: typeof result.prompt === "string"
					? result.prompt
					: undefined;
		if (response) teamFactoryDraft.messages.push({ role: "assistant", text: response });
		if (result.done !== true) {
			persistTeamFactoryDraft();
			return;
		}
		const goalRecordPath = typeStringValue(result.relativeRecordPath) ?? typeStringValue(result.recordPath);
		if (!goalRecordPath) throw new Error("WTK completed intake without a goal record");
		teamFactoryDraft.phase = "research";
		teamFactoryDraft.reviewReady = false;
		teamFactoryDraft.messages.push({
			role: "assistant",
			text: "Build brief approved. Researching the package design…",
		});
		persistTeamFactoryDraft();
		await startTeamFactoryOperation("/agent-team-factory/research", { goalRecordPath });
		return;
	}
	if (teamFactoryDraft.phase === "research") {
		const build = isJsonObject(result.next) && isJsonObject(result.next.build) ? result.next.build : undefined;
		const body = build && isJsonObject(build.body) ? build.body : undefined;
		const pkgId = typeStringValue(body?.pkgId) ?? typeStringValue(result.pkgId);
		const handoffPath = typeStringValue(body?.handoffPath) ?? typeStringValue(result.handoffPath);
		if (!pkgId || !handoffPath) throw new Error("WTK research did not produce a build handoff");
		teamFactoryDraft.phase = "build";
		teamFactoryDraft.pkgId = pkgId;
		teamFactoryDraft.messages.push({
			role: "assistant",
			text: "Research complete. Compiling the canonical agent package…",
		});
		persistTeamFactoryDraft();
		await startTeamFactoryOperation("/agent-team-factory/build", { pkgId, handoffPath });
		return;
	}
	if (teamFactoryDraft.phase === "build") {
		if (!teamFactoryDraft.pkgId) throw new Error("WTK build lost its package identifier");
		teamFactoryDraft.phase = "deliver";
		teamFactoryDraft.messages.push({
			role: "assistant",
			text: "Package compiled. Producing the Pi runtime projection…",
		});
		persistTeamFactoryDraft();
		await startTeamFactoryOperation("/agent-team-factory/deliver", { pkgId: teamFactoryDraft.pkgId });
		return;
	}
	if (teamFactoryDraft.phase === "deliver") {
		if (!teamFactoryDraft.pkgId) throw new Error("WTK delivery lost its package identifier");
		teamFactoryDraft.phase = "prepare";
		persistTeamFactoryDraft();
		await prepareBuiltTeam(teamFactoryDraft.pkgId);
	}
}

async function startTeamFactoryOperation(path: string, body: Record<string, unknown>): Promise<void> {
	if (!capabilityToken || !teamFactoryDraft) return;
	const response = await fetch(`${path}?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(await responseError(response, "WTK could not advance the build"));
	const accepted = teamFactoryAccepted(await response.json());
	teamFactoryDraft.operationId = accepted.operation.id;
	persistTeamFactoryDraft();
	await followTeamFactoryOperation(accepted.operation.id);
}

async function prepareBuiltTeam(pkgId: string): Promise<void> {
	if (!capabilityToken || !teamFactoryDraft) return;
	const selectedModel = (agentModel.value || model.value).split("/");
	if (selectedModel.length < 2) throw new Error("Select a model before reviewing the generated team");
	const provider = selectedModel.shift()!;
	const id = selectedModel.join("/");
	const projectRoot = requiredElement<HTMLInputElement>("agent-project-root").value.trim();
	const response = await fetch(`/agent-team-factory/prepare?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ pkgId, projectRoot, model: { provider, id } }),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not bind the generated team locally"));
	const value: unknown = await response.json();
	if (!isJsonObject(value) || !isPiAgentTeamPreview(value.preview))
		throw new Error("Pi returned an invalid generated team review");
	pendingTeamPackage = { bundle: value.bundle, bindings: value.bindings, preview: value.preview };
	teamFactoryDraft.messages.push({
		role: "assistant",
		text: "Canonical package ready. Review its members, model, access, and workspace before launch.",
	});
	persistTeamFactoryDraft();
	setStatus("Team package ready to review");
}

function teamFactoryAccepted(value: unknown): { operation: TeamFactoryOperation; sessionId?: string } {
	if (!isJsonObject(value)) throw new Error("WTK returned an invalid accepted operation");
	return {
		operation: teamFactoryOperation(value.operation),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
	};
}

function teamFactoryOperation(value: unknown): TeamFactoryOperation {
	if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.status !== "string") {
		throw new Error("WTK returned an invalid operation");
	}
	if (!["queued", "running", "paused", "succeeded", "failed", "cancelled"].includes(value.status)) {
		throw new Error(`WTK returned unsupported status ${value.status}`);
	}
	return {
		id: value.id,
		status: value.status as TeamFactoryOperation["status"],
		...(value.result !== undefined ? { result: value.result } : {}),
		...(isJsonObject(value.error) && typeof value.error.message === "string"
			? { error: { message: value.error.message } }
			: {}),
		...(isJsonObject(value.progress) && typeof value.progress.message === "string"
			? { progress: { message: value.progress.message } }
			: {}),
	};
}

function persistTeamFactoryDraft(): void {
	if (teamFactoryDraft) localStorage.setItem("pi-team-factory-draft-v1", JSON.stringify(teamFactoryDraft));
	else localStorage.removeItem("pi-team-factory-draft-v1");
}

function readStoredTeamFactoryDraft(): TeamFactoryDraft | undefined {
	try {
		const raw = localStorage.getItem("pi-team-factory-draft-v1");
		if (!raw) return undefined;
		const value: unknown = JSON.parse(raw);
		if (!isJsonObject(value) || !Array.isArray(value.messages) || typeof value.phase !== "string") return undefined;
		const phases: TeamFactoryPhase[] = ["intake", "research", "build", "deliver", "prepare", "failed"];
		if (!phases.includes(value.phase as TeamFactoryPhase)) return undefined;
		const messages = value.messages.filter(
			(message): message is { role: "user" | "assistant"; text: string } =>
				isJsonObject(message) &&
				(message.role === "user" || message.role === "assistant") &&
				typeof message.text === "string",
		);
		return {
			phase: value.phase as TeamFactoryPhase,
			messages,
			...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
			...(typeof value.operationId === "string" ? { operationId: value.operationId } : {}),
			...(typeof value.pkgId === "string" ? { pkgId: value.pkgId } : {}),
			...(typeof value.reviewReady === "boolean" ? { reviewReady: value.reviewReady } : {}),
			...(typeof value.paused === "boolean" ? { paused: value.paused } : {}),
		};
	} catch {
		return undefined;
	}
}

function typeStringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPiAgentTeamPreview(value: unknown): value is PiAgentTeamPreview {
	if (!isJsonObject(value) || value.schemaVersion !== "pi.agents.team-preview.v1") return false;
	if (typeof value.approvalDigest !== "string" || !isJsonObject(value.team) || !isJsonObject(value.bindings)) {
		return false;
	}
	return (
		typeof value.team.name === "string" &&
		typeof value.team.coordinatorRoleId === "string" &&
		Array.isArray(value.team.roles) &&
		isJsonObject(value.team.workflow) &&
		typeof value.bindings.projectRoot === "string" &&
		Array.isArray(value.bindings.credentialRefs)
	);
}

function teamLaunchCoordinatorAgentId(value: unknown): string {
	if (!isJsonObject(value) || !isJsonObject(value.target) || typeof value.target.coordinatorAgentId !== "string") {
		throw new Error("Pi returned an invalid team launch result");
	}
	return value.target.coordinatorAgentId;
}

function builderDisplayItem(item: TranscriptItem): TranscriptItem {
	if (item.role === "assistant")
		return {
			...item,
			content: item.content.map((content) => {
				if (content.type !== "text") return content;
				const visible = content.text.replace(/\s*\[AGENT_DRAFT\][\s\S]*?\[\/AGENT_DRAFT\]\s*/g, "\n").trim();
				return { ...content, text: visible || "Draft ready to review." };
			}),
		};
	if (item.role !== "user") return item;
	const requestMarker = "\nUser request: ";
	return {
		...item,
		content: item.content.map((content) => {
			if (content.type !== "text") return content;
			if (!content.text.startsWith(agentBuilderBootstrapPrefix)) return content;
			const requestStart = content.text.lastIndexOf(requestMarker);
			return {
				...content,
				text:
					requestStart >= 0
						? content.text.slice(requestStart + requestMarker.length).trim()
						: "Update agent settings",
			};
		}),
	};
}

function renderExternalRun(run: ExternalRunSummary): void {
	if (activeExternalRunId !== run.id) return;
	const elapsedBucket = run.status === "starting" || run.status === "running" ? Math.floor(Date.now() / 5_000) : 0;
	const renderSignature = `${run.id}:${run.status}:${run.progress ?? ""}:${run.lastActivityAt ?? 0}:${elapsedBucket}:${run.error ?? ""}:${externalResultByRunId.get(run.id) ?? ""}`;
	if (renderSignature === renderedExternalRunSignature) return;
	renderedExternalRunSignature = renderSignature;
	const connection = externalConnections.find((entry) => entry.id === run.connectionId);
	const heading = document.createElement("section");
	heading.className = "subagent-inspector-heading";
	const title = document.createElement("strong");
	title.textContent = connection?.name ?? run.connectionId;
	const state = document.createElement("span");
	state.textContent = externalRunStatusLabel(run.status);
	const task = document.createElement("p");
	task.textContent = run.prompt;
	heading.append(title, state, task);

	const body = document.createElement("section");
	body.className = "subagent-timeline";
	const result = externalResultByRunId.get(run.id);
	if (result) {
		const message = document.createElement("div");
		message.className = "agent-message-content";
		appendAgentMarkdown(message, result);
		body.append(message);
	} else if (run.error) {
		appendText(body, run.error, "run-error");
	} else {
		const progress = document.createElement("div");
		progress.className = "agent-running";
		progress.append(document.createElement("i"), document.createTextNode(externalRunProgressLabel(run)));
		body.append(progress);
	}

	const actions = document.createElement("div");
	actions.className = "result-actions";
	if (run.status === "starting" || run.status === "running") {
		const stop = document.createElement("button");
		stop.type = "button";
		stop.className = "abort";
		stop.textContent = "Stop";
		stop.addEventListener("click", () => void abortExternalRun(run.id));
		actions.append(stop);
	}
	if (run.status === "failed" || run.status === "aborted") {
		const retry = document.createElement("button");
		retry.type = "button";
		retry.textContent = "Retry";
		retry.addEventListener("click", () => void retryExternalRun(run));
		actions.append(retry);
	}
	if (run.status === "succeeded") {
		const use = document.createElement("button");
		use.type = "button";
		use.textContent = "Send result to Pi";
		use.addEventListener("click", () => void sendExternalResultToPi(run));
		actions.append(use);
	}
	if (actions.childElementCount > 0) body.append(actions);

	transcript.replaceChildren(heading, body);
	transcript.scrollTop = transcript.scrollHeight;
	phase.textContent = run.status;
	input.disabled = true;
	input.value = "";
	input.placeholder = "Delegated run output";
	send.disabled = true;
	replacePrimaryModelOptions(connection?.models ?? availableModels);
	model.value = `${run.model.provider}/${run.model.id}`;
	model.disabled = true;
	modelPicker.refresh();
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	attachmentList.replaceChildren();
	setSessionPath(run.cwd, false);
	sessionStats.textContent = `${run.model.provider}/${run.model.id}`;
	sessionStats.title = "Delegated model";
	setStatus(`${connection?.name ?? run.connectionId} · ${externalRunStatusLabel(run.status)}`);
	if (run.status === "succeeded" && !result) void loadExternalResultIntoTab(run);
}

function renderExternalConversation(connection: ExternalConnectionSummary): void {
	if (activeExternalConnectionId !== connection.id) return;
	const runs = externalRuns
		.filter((run) => run.connectionId === connection.id)
		.sort((left, right) => left.createdAt - right.createdAt);
	const configuredCwd = requiredElement<HTMLInputElement>("external-cwd");
	if (!configuredCwd.value) {
		configuredCwd.value =
			localStorage.getItem(`pi-serve-external-cwd:${connection.id}`) ??
			runs.at(-1)?.cwd ??
			session?.snapshot?.cwd ??
			"";
	}
	const heading = document.createElement("section");
	heading.className = "external-chat-heading";
	const title = document.createElement("strong");
	title.textContent = connection.name;
	const profile = document.createElement("span");
	profile.className = "muted";
	profile.textContent = `${connection.authentication === "subscription" ? "Subscription" : connection.authentication === "api-key" ? "API" : "Configured"} · ${connection.defaultModel.id}`;
	heading.append(title, profile);
	const timeline = document.createElement("section");
	timeline.className = "subagent-timeline";
	if (runs.length === 0) appendText(timeline, `Message ${connection.name} below to start.`, "muted");
	for (const run of runs) {
		const turn = document.createElement("article");
		turn.className = "external-chat-turn";
		const user = document.createElement("div");
		user.className = "external-chat-user";
		user.textContent = run.prompt;
		const agent = document.createElement("div");
		agent.className = "external-chat-agent agent-message-content";
		const result = externalResultByRunId.get(run.id);
		if (result) appendAgentMarkdown(agent, result);
		else if (run.error) appendText(agent, run.error, "run-error");
		else {
			const progress = document.createElement("div");
			progress.className = "agent-running";
			progress.append(document.createElement("i"), document.createTextNode(externalRunProgressLabel(run)));
			agent.append(progress);
		}
		const actions = document.createElement("div");
		actions.className = "result-actions";
		if (run.status === "succeeded") {
			const sendToPi = document.createElement("button");
			sendToPi.type = "button";
			sendToPi.textContent = "↗ Pi";
			sendToPi.title = "Send this response to Pi";
			sendToPi.addEventListener("click", () => void sendExternalResultToPi(run));
			actions.append(sendToPi);
		}
		turn.append(user, agent);
		if (actions.childElementCount > 0) turn.append(actions);
		timeline.append(turn);
		if (run.status === "succeeded" && !result) void loadExternalResultIntoTab(run);
	}
	transcript.replaceChildren(heading, timeline);
	transcript.scrollTop = transcript.scrollHeight;
	const activeRun = runs.findLast((run) => run.status === "starting" || run.status === "running");
	phase.textContent = activeRun ? externalRunStatusLabel(activeRun.status) : "ready";
	input.disabled = false;
	input.placeholder = `Message ${connection.name}…`;
	input.setAttribute("aria-label", `Message ${connection.name}`);
	resizeComposer();
	send.disabled = false;
	send.classList.toggle("is-stopping", activeRun !== undefined);
	send.setAttribute("aria-label", activeRun ? "Stop delegated response" : "Send message");
	const storedModel = localStorage.getItem(`pi-serve-external-model:${connection.id}`);
	const currentModel = storedModel ?? model.value;
	const currentModelIsSupported = connection.models.some((entry) => `${entry.provider}/${entry.id}` === currentModel);
	const delegatedModel =
		activeRun?.model ??
		(currentModelIsSupported ? modelRefFromValue(currentModel) : undefined) ??
		runs.at(-1)?.model ??
		connection.defaultModel;
	replacePrimaryModelOptions(connection.models);
	model.value = `${delegatedModel.provider}/${delegatedModel.id}`;
	model.disabled = activeRun !== undefined || connection.models.length < 2;
	modelPicker.refresh();
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	attachmentList.replaceChildren();
	const cwd = configuredCwd.value || runs.at(-1)?.cwd;
	setSessionPath(cwd || "Delegated session", activeRun === undefined);
	sessionStats.textContent = `${connection.defaultModel.provider}/${connection.defaultModel.id}`;
	sessionStats.title = "Delegated model";
	setStatus(`${connection.name} · ${activeRun ? externalRunStatusLabel(activeRun.status) : "Ready"}`);
}

function externalRunStatusLabel(value: string): string {
	if (value === "succeeded") return "Completed";
	if (value === "failed") return "Failed";
	if (value === "aborted") return "Stopped";
	if (value === "starting") return "Starting";
	return "Running";
}

function externalRunProgressLabel(run: ExternalRunSummary): string {
	if (run.status !== "starting" && run.status !== "running") return externalRunStatusLabel(run.status);
	const elapsed = Math.max(0, Math.floor((Date.now() - (run.startedAt ?? run.createdAt)) / 1000));
	const activity = run.progress ? run.progress.replaceAll("_", " ") : externalRunStatusLabel(run.status);
	return `${activity} · ${formatElapsed(elapsed)}`;
}

function formatElapsed(totalSeconds: number): string {
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

async function loadExternalResultIntoTab(run: ExternalRunSummary): Promise<void> {
	try {
		externalResultByRunId.set(run.id, await externalResult(run.id));
		if (activeExternalRunId === run.id) renderExternalRun(run);
		if (activeExternalConnectionId === run.connectionId) {
			const connection = externalConnections.find((entry) => entry.id === run.connectionId);
			if (connection) renderExternalConversation(connection);
		}
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	}
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
	const currentModel = availableModels.find(
		(entry) => entry.provider === snapshot.model.provider && entry.id === snapshot.model.id,
	);
	const costPresentation = getSessionCostPresentation(
		snapshot.model.provider,
		currentModel?.cost,
		totals.cost,
		totals.input + totals.output + totals.cacheRead + totals.cacheWrite > 0,
	);
	if (costPresentation) {
		appendStat("$", costPresentation.value, costPresentation.title, "session-stat-cost");
	}
	const children: HTMLElement[] = [];
	if (totalsLabel.childElementCount > 0) children.push(totalsLabel);
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
		if (content.type === "text" && item.role === "assistant") {
			for (const [segmentIndex, segment] of splitInlineThinking(content.text).entries()) {
				if (segment.type === "thinking")
					article.append(renderThinkingActivity(item, segment.text, index * 1_000 + segmentIndex));
				else appendText(article, segment.text);
			}
		} else if (content.type === "text") appendText(article, content.text);
		else if (item.role === "assistant" && content.type === "thinking") {
			article.append(renderThinkingActivity(item, content.thinking, index));
		} else if (content.type === "toolCall" && content.toolName !== "subagent") {
			appendText(article, `Using ${content.toolName}`, "tool-call");
		} else if (content.type === "image") appendText(article, `[image: ${content.mimeType}]`);
	}
	if (item.role === "assistant" && (item.status === "error" || item.status === "aborted") && item.errorMessage) {
		appendText(article, friendlyAssistantError(item.errorMessage), "run-error");
	}
	return article;
}

function friendlyAssistantError(message: string): string {
	if (/no credits remaining/i.test(message)) {
		return "OpenAI API credits are exhausted. Add API credits, choose another configured API model, or use the Codex ChatGPT subscription connection under Agents.";
	}
	return message;
}

function renderThinkingActivity(
	item: Extract<TranscriptItem, { role: "assistant" }>,
	content: string,
	index: number,
): HTMLDetailsElement {
	const thinkingId = `${item.id}:${index}`;
	return renderThinkingDisclosure(thinkingId, content, item.status === "streaming");
}

function renderThinkingDisclosure(thinkingId: string, content: string, streaming: boolean): HTMLDetailsElement {
	const details = document.createElement("details");
	details.className = `thinking-activity${streaming ? " is-streaming" : ""}`;
	details.dataset.thinkingId = thinkingId;
	if (streaming) {
		streamingThinking.add(thinkingId);
	}
	details.open = expandedThinking.get(thinkingId) ?? false;
	details.addEventListener("toggle", () => expandedThinking.set(thinkingId, details.open));

	const summary = document.createElement("summary");
	const label = document.createElement("span");
	label.textContent = streaming ? "Thinking" : "Thought process";
	const dots = document.createElement("span");
	dots.className = "thinking-dots";
	dots.setAttribute("aria-hidden", "true");
	dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
	summary.append(label, dots);

	const body = document.createElement("div");
	body.className = "thinking-body";
	body.textContent = content;
	details.append(summary, body);

	if (!streaming && streamingThinking.delete(thinkingId) && !thinkingCollapseTimers.has(thinkingId)) {
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

function modelOptionLabel(entry: { provider: string; name: string }): string {
	return `${entry.name} · ${modelProviderLabels[entry.provider] ?? entry.provider}`;
}

function populateModels(models: readonly ModelMetadata[], includeAgentModels = false): void {
	const presentedModels = filterPresentedModels(models);
	availableModels = presentedModels;
	modelCostPresentations = getModelSelectionCostPresentations(presentedModels);
	replacePrimaryModelOptions(presentedModels);
	if (!includeAgentModels) return;
	const inherit = document.createElement("option");
	inherit.value = "";
	inherit.textContent = "Inherit current session";
	agentModel.replaceChildren(
		inherit,
		...presentedModels.map((entry) => {
			const option = document.createElement("option");
			option.value = `${entry.provider}/${entry.id}`;
			const recommended = entry.provider === recommendedAgentModel.provider && entry.id === recommendedAgentModel.id;
			option.textContent = `${modelOptionLabel(entry)}${recommended ? " · Recommended" : ""}`;
			applyModelCostPresentation(option, entry);
			return option;
		}),
	);
	if (!agentModelsInitialized) {
		const recommendedModelValue = `${recommendedAgentModel.provider}/${recommendedAgentModel.id}`;
		agentModel.value = presentedModels.some(
			(entry) => entry.provider === recommendedAgentModel.provider && entry.id === recommendedAgentModel.id,
		)
			? recommendedModelValue
			: "";
		agentModelsInitialized = true;
	}
	agentModelPicker.refresh();
	refreshRoutineEditorOptions();
}

function replacePrimaryModelOptions(models: readonly { provider: string; id: string; name: string }[]): void {
	const options = models.map((entry) => {
		const option = document.createElement("option");
		option.value = `${entry.provider}/${entry.id}`;
		option.textContent = modelOptionLabel(entry);
		applyModelCostPresentation(option, entry);
		return option;
	});
	model.replaceChildren(...options);
	modelPicker.refresh();
}

function applyModelCostPresentation(option: HTMLOptionElement, modelRef: { provider: string; id: string }): void {
	const presentation = modelCostPresentations.get(modelSelectionCostKey(modelRef.provider, modelRef.id));
	if (!presentation) return;
	option.dataset.optionAccent = presentation.color;
	option.dataset.optionKind = presentation.band;
	option.title = presentation.title;
}

function modelRefFromValue(value: string): { provider: string; id: string } | undefined {
	const separator = value.indexOf("/");
	return separator > 0 ? { provider: value.slice(0, separator), id: value.slice(separator + 1) } : undefined;
}

function updateThinkingLevelAvailability(
	select: HTMLSelectElement,
	modelValue: string,
	preferredLevel?: ThinkingLevel,
): void {
	const modelRef = modelRefFromValue(modelValue);
	const metadata = modelRef
		? availableModels.find((entry) => entry.provider === modelRef.provider && entry.id === modelRef.id)
		: undefined;
	if (!metadata) {
		for (const option of select.options) {
			option.disabled = false;
			option.style.color = "#f4f4f5";
			option.style.backgroundColor = "#17171b";
			delete option.dataset.thinkingSupported;
			option.removeAttribute("title");
		}
		select.removeAttribute("title");
		if (preferredLevel) select.value = preferredLevel;
		refreshThinkingPicker(select);
		return;
	}

	const supportedLevels = new Set<ThinkingLevel>(metadata.supportedThinkingLevels);
	for (const option of select.options) {
		const level = option.value as ThinkingLevel;
		const supported = supportedLevels.has(level);
		option.disabled = !supported;
		option.dataset.thinkingSupported = String(supported);
		option.style.color = supported ? "#f4f4f5" : "#666873";
		option.style.backgroundColor = supported ? "#17171b" : "#111114";
		option.title = supported
			? `${level} thinking is supported by ${metadata.name}`
			: `${metadata.name} does not support ${level} thinking`;
	}

	if (preferredLevel && supportedLevels.has(preferredLevel)) select.value = preferredLevel;
	if (!supportedLevels.has(select.value as ThinkingLevel)) select.value = metadata.supportedThinkingLevels[0];
	select.title = `${metadata.name} supports ${metadata.supportedThinkingLevels.join(", ")} thinking. Unsupported levels are disabled.`;
	refreshThinkingPicker(select);
}

function refreshThinkingPicker(select: HTMLSelectElement): void {
	if (select === thinking) thinkingPicker.refresh();
	else if (select === agentThinking) agentThinkingPicker.refresh();
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
				!activeAgentId &&
					!activeSubagentKey &&
					!activeExternalConnectionId &&
					!activeExternalRunId &&
					!activeArtifactId &&
					target.key === activeTargetKey,
			);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab";
			button.classList.toggle(
				"active",
				!activeAgentId &&
					!activeSubagentKey &&
					!activeExternalConnectionId &&
					!activeExternalRunId &&
					!activeArtifactId &&
					target.key === activeTargetKey,
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
		...openExternalConnectionIds.flatMap((connectionId) => {
			const connection = externalConnections.find((entry) => entry.id === connectionId);
			if (!connection) return [];
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle("active", connection.id === activeExternalConnectionId);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab agent-session-tab";
			button.textContent = connection.name;
			button.title = `Open ${connection.name} chat`;
			button.addEventListener("click", () => openExternalConnection(connection));
			const close = document.createElement("button");
			close.type = "button";
			close.className = "session-tab-close";
			close.textContent = "×";
			close.title = `Close ${connection.name} chat`;
			close.setAttribute("aria-label", close.title);
			close.addEventListener("click", () => closeExternalConnectionTab(connection.id));
			wrapper.append(button, close);
			return [wrapper];
		}),
		...openExternalRunIds.flatMap((runId) => {
			const run = externalRuns.find((entry) => entry.id === runId);
			if (!run) return [];
			const connection = externalConnections.find((entry) => entry.id === run.connectionId);
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle("active", run.id === activeExternalRunId);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab agent-session-tab";
			button.textContent = connection?.name ?? run.connectionId;
			button.title = `${externalRunStatusLabel(run.status)} · ${run.prompt}`;
			button.addEventListener("click", () => openExternalRun(run));
			const close = document.createElement("button");
			close.type = "button";
			close.className = "session-tab-close";
			close.textContent = "×";
			close.title = `Close ${connection?.name ?? run.connectionId} result`;
			close.setAttribute("aria-label", close.title);
			close.addEventListener("click", () => closeExternalRunTab(run.id));
			wrapper.append(button, close);
			return [wrapper];
		}),
		...openArtifactIds.flatMap((artifactId) => {
			const artifact = artifacts.find((entry) => entry.id === artifactId);
			if (!artifact) return [];
			const wrapper = document.createElement("div");
			wrapper.className = "session-tab-wrap";
			wrapper.classList.toggle("active", artifact.id === activeArtifactId);
			const button = document.createElement("button");
			button.type = "button";
			button.className = "session-tab artifact-session-tab";
			button.textContent = artifact.title;
			button.title = `Open ${artifact.title}`;
			button.addEventListener("click", () => void openArtifact(artifact.id));
			const close = document.createElement("button");
			close.type = "button";
			close.className = "session-tab-close";
			close.textContent = "×";
			close.title = `Close ${artifact.title}`;
			close.setAttribute("aria-label", close.title);
			close.addEventListener("click", () => closeArtifactTab(artifact.id));
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
				button.classList.toggle(
					"active",
					!activeAgentId &&
						!activeSubagentKey &&
						!activeExternalRunId &&
						!activeArtifactId &&
						target.key === activeTargetKey,
				);
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
		renderAgentNavigationGroup(),
	);
}

function renderAgentNavigationGroup(): HTMLElement {
	const group = document.createElement("section");
	group.className = "connection-group agent-navigation-group";
	const heading = document.createElement("div");
	heading.className = "connection-heading";
	const indicator = document.createElement("i");
	const label = document.createElement("span");
	label.textContent = "Agents";
	const create = document.createElement("button");
	create.type = "button";
	create.textContent = "+";
	create.title = "Build a new agent";
	create.setAttribute("aria-label", create.title);
	create.addEventListener("click", () => void openAgentBuilder());
	heading.append(indicator, label, create);
	group.append(heading);
	if (agents.length === 0) {
		const empty = document.createElement("p");
		empty.className = "agent-activity-empty";
		empty.textContent = "No published agents";
		group.append(empty);
		return group;
	}
	for (const agent of agents) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "nav-item session-entry";
		button.classList.toggle("active", activeAgentId === agent.id);
		const name = document.createElement("strong");
		name.textContent = agent.name;
		const state = document.createElement("span");
		state.className = "muted";
		const build = agentBuilds.find((candidate) => candidate.agentId === agent.id);
		state.textContent = build
			? `${agentBuildStageLabel(build)} · revision ${agent.revision}`
			: `Revision ${agent.revision}`;
		button.append(name, state);
		button.addEventListener("click", () => void openAgent(agent));
		group.append(button);
	}
	return group;
}

async function switchSession(target: SessionTarget, preserveWorkspace = false): Promise<void> {
	if (target.key === activeTargetKey && session?.attached) {
		if (!preserveWorkspace) {
			builderActive = false;
			activeAgentId = undefined;
			activeSubagentKey = undefined;
			activeExternalRunId = undefined;
			activeExternalConnectionId = undefined;
			activeArtifactId = undefined;
			persistExternalRunTabs();
			persistExternalConnectionTabs();
		}
		if (session.snapshot) {
			if (builderActive) renderBuilderConversation(session.snapshot);
			else render(session.snapshot);
		}
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
	if (!preserveWorkspace) {
		builderActive = false;
		activeAgentId = undefined;
		activeSubagentKey = undefined;
		activeExternalRunId = undefined;
		activeExternalConnectionId = undefined;
		activeArtifactId = undefined;
		persistExternalRunTabs();
		persistExternalConnectionTabs();
	}
	populateModels(entry.client.snapshot?.models ?? []);
	unsubscribeSession = session.subscribe((snapshot) => {
		if (builderActive) renderBuilderConversation(snapshot);
		else render(snapshot);
	});
	if (session.snapshot) {
		if (builderActive) renderBuilderConversation(session.snapshot);
		else render(session.snapshot);
	}
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
	previewSessionsWithoutCapture.delete(activePreviewSessionId);
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

async function loadPreviewCapture(): Promise<boolean> {
	if (!capabilityToken || !activePreviewSessionId) return false;
	const sessionId = activePreviewSessionId;
	if (previewSessionsWithoutCapture.has(sessionId)) return true;
	const response = await fetch(
		`/browser/sessions/${encodeURIComponent(sessionId)}/capture?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (response.status === 404) {
		const sessionResponse = await fetch(
			`/browser/sessions/${encodeURIComponent(sessionId)}/diagnostics?token=${encodeURIComponent(capabilityToken)}`,
		);
		if (sessionResponse.status !== 404) {
			previewCapture = undefined;
			previewSessionsWithoutCapture.add(sessionId);
			renderPreviewRecording();
			return true;
		}
		previewCapture = undefined;
		selectedPreviewSessionId = undefined;
		activePreviewSessionId = undefined;
		activePreviewSession = undefined;
		previewImage.removeAttribute("src");
		previewStream?.close();
		previewStream = undefined;
		previewStreamSessionId = undefined;
		setPreviewControls(undefined);
		renderPreviewRecording();
		setPreviewMessage("Browser session ended. Start or select another managed browser.");
		return false;
	}
	if (!response.ok) throw new Error(await responseError(response, "Could not load browser recording"));
	const value: unknown = await response.json();
	if (!isBrowserCaptureSummary(value)) throw new Error("Browser recording response is invalid");
	previewCapture = value;
	renderPreviewRecording();
	return true;
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
		const actionStateKey = `${workflow.id}@${workflow.version}`;
		if (workflow.status === "compiled") {
			actions.append(
				browserWorkflowAction(
					"✓",
					"Validate workflow in a fresh browser",
					() => browserWorkflowRequest(workflow, "validate", workflowParameterValues(body)),
					actionStateKey,
				),
			);
		}
		if (workflow.status === "validated") {
			actions.append(
				browserWorkflowAction(
					"●",
					"Activate validated workflow",
					() => browserWorkflowRequest(workflow, "activate", {}),
					actionStateKey,
				),
			);
		}
		if (workflow.status === "active") {
			actions.append(
				browserWorkflowAction(
					"▶",
					"Run active workflow",
					() => browserWorkflowRequest(workflow, "run", workflowParameterValues(body)),
					actionStateKey,
				),
				browserWorkflowAction(
					"◇",
					"Create a reusable Pi skill reference",
					() => browserWorkflowReferenceRequest(workflow, "create-skill"),
					actionStateKey,
				),
				browserWorkflowAction(
					"⊞",
					"Use as a frontend test for this project",
					() => browserWorkflowReferenceRequest(workflow, "frontend-test"),
					actionStateKey,
				),
			);
		}
		actions.append(browserWorkflowDeleteAction(workflow, actionStateKey));
		body.append(actions, renderBrowserWorkflowActionState(actionStateKey));
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

function browserWorkflowAction(
	label: string,
	title: string,
	action: () => Promise<void>,
	stateKey?: string,
): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = label;
	button.title = title;
	button.setAttribute("aria-label", title);
	if (stateKey && browserWorkflowActionStates.get(stateKey)?.status === "running") {
		button.disabled = true;
		button.setAttribute("aria-busy", "true");
	}
	button.addEventListener("click", () => {
		button.disabled = true;
		button.setAttribute("aria-busy", "true");
		if (stateKey) {
			browserWorkflowActionStates.set(stateKey, { status: "running", message: `${title}…` });
			void renderBrowserWorkflows();
		}
		void action()
			.then(() => {
				if (stateKey) {
					browserWorkflowActionStates.set(stateKey, { status: "completed", message: `${title} completed` });
				}
				return loadBrowserWorkflows(true);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (stateKey) browserWorkflowActionStates.set(stateKey, { status: "failed", message });
				setPreviewMessage(message, true);
				return renderBrowserWorkflows();
			})
			.finally(() => {
				button.disabled = false;
				button.removeAttribute("aria-busy");
			});
	});
	return button;
}

function renderBrowserWorkflowActionState(stateKey: string): HTMLElement {
	const output = document.createElement("span");
	output.className = "browser-workflow-action-state";
	const state = browserWorkflowActionStates.get(stateKey);
	if (!state) return output;
	output.dataset.status = state.status;
	output.setAttribute("role", "status");
	output.textContent = state.message;
	return output;
}

function browserWorkflowDeleteAction(workflow: BrowserWorkflowSummary, stateKey: string): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "danger";
	button.textContent = "×";
	button.title = "Delete recorded workflow";
	button.setAttribute("aria-label", `Delete recorded workflow ${workflow.name}`);
	button.addEventListener("click", () => {
		if (
			!window.confirm(
				`Delete browser workflow "${workflow.name}" and all of its versions? Agents and routines that reference it will no longer run.`,
			)
		) {
			return;
		}
		browserWorkflowActionStates.set(stateKey, { status: "running", message: "Deleting workflow…" });
		void renderBrowserWorkflows();
		void deleteBrowserWorkflow(workflow)
			.then(() => {
				browserWorkflowActionStates.delete(stateKey);
				setPreviewMessage(`${workflow.name}: deleted`);
				return loadBrowserWorkflows(true);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				browserWorkflowActionStates.set(stateKey, { status: "failed", message });
				setPreviewMessage(message, true);
				return renderBrowserWorkflows();
			});
	});
	return button;
}

async function deleteBrowserWorkflow(workflow: BrowserWorkflowSummary): Promise<void> {
	if (!capabilityToken) throw new Error("Browser workflow access is unavailable");
	const response = await fetch(
		`/browser/workflows/${encodeURIComponent(workflow.id)}?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "DELETE" },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not delete browser workflow"));
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
	if (!(await loadPreviewCapture())) return;
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
	const restoredExternalConnectionId = activeExternalConnectionId;
	const primary = await addConnection(location.href, true);
	populateModels(primary.client.snapshot?.models ?? [], true);
	const initial = sessionTargets().find((target) => target.connectionId === primary.id);
	if (!initial) throw new Error("The active Pi session is unavailable");
	await switchSession(initial);
	if (restoredExternalConnectionId && openExternalConnectionIds.includes(restoredExternalConnectionId)) {
		activeExternalConnectionId = restoredExternalConnectionId;
		persistExternalConnectionTabs();
	}
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
			loadCredentialVault().catch(() => {}),
			loadExternalConnections()
				.then(loadExternalRuns)
				.catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true)),
		]);
	}, 0);
}

async function loadCredentialVault(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/credential-vault?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not load credential vault"));
	const payload: unknown = await response.json();
	if (!isCredentialVaultManagementStatus(payload)) throw new Error("Credential vault returned an invalid response");
	credentialVaultStatus = payload;
	renderSettingsSecurity();
}

async function mutateCredentialVault(
	action: "initialize" | "unlock" | "lock" | "migrate" | "remove-migrated-legacy",
	passphrase?: string,
): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/credential-vault?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, ...(passphrase ? { passphrase } : {}) }),
	});
	if (!response.ok) throw new Error(await responseError(response, "Credential vault operation failed"));
	await Promise.all([loadCredentialVault(), loadCapabilities()]);
	setStatus(
		action === "migrate"
			? "Legacy credentials imported"
			: action === "remove-migrated-legacy"
				? "Migrated legacy entries removed"
				: `Credential vault ${action === "initialize" ? "initialized" : `${action}ed`}`,
	);
}

function isCredentialVaultManagementStatus(value: unknown): value is CredentialVaultManagementStatus {
	if (typeof value !== "object" || value === null || !("vault" in value) || !("legacy" in value)) return false;
	const vault = value.vault;
	const legacy = value.legacy;
	return (
		typeof vault === "object" &&
		vault !== null &&
		"initialized" in vault &&
		typeof vault.initialized === "boolean" &&
		"locked" in vault &&
		typeof vault.locked === "boolean" &&
		typeof legacy === "object" &&
		legacy !== null &&
		"configuredFields" in legacy &&
		Array.isArray(legacy.configuredFields) &&
		"migratedFields" in legacy &&
		Array.isArray(legacy.migratedFields) &&
		"unmanagedNames" in legacy &&
		Array.isArray(legacy.unmanagedNames)
	);
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
	capabilityCatalogSnapshot = payload;
	capabilitySnapshot = payload.broker;
	const query = ensureCapabilitySearch().value.trim().toLowerCase();
	const groups: Array<["local" | "remote", string, CapabilityEntry[], boolean]> = [
		["local", "Tools", payload.tools, false],
		["local", "Skills", payload.skills, false],
		["local", "Extensions", payload.extensions, false],
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
	renderSettings();
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
	renderSettings();
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
		const defaultProvider = resolveCapabilityProvider(broker, capability);
		const connectionState = defaultProvider
			? providerCapabilityConnectionState(defaultProvider, capability.id)
			: "missing";
		const connectionReady = connectionState === "not-required" || connectionState === "ready";
		checkbox.disabled = capability.status !== "active" || !connectionReady;
		checkbox.title =
			capability.status !== "active"
				? defaultProvider?.authentication && !defaultProvider.authentication.configured
					? "Configure the provider first"
					: "Review and enable a healthy provider first"
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
		state.textContent = canonicalCapabilityState(capability, defaultProvider, connectionState);
		summary.append(grant, state);
		const body = document.createElement("div");
		body.className = "capability-body";
		appendText(body, capability.description, "muted");
		appendText(
			body,
			`${capability.category} · ${capability.effect} · ${capability.defaultProviderId ?? "no default provider"}`,
			"capability-meta",
		);
		if (checkbox.disabled && defaultProvider) {
			const configure = document.createElement("button");
			configure.type = "button";
			configure.textContent = settingsRemediationLabel(defaultProvider, connectionState);
			configure.addEventListener("click", () => openProviderSettings(defaultProvider));
			body.append(configure);
		}
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

	return [capabilitySection];
}

function providerConfigurationForm(provider: CapabilityProvider): HTMLFormElement {
	const form = document.createElement("form");
	form.className = "configuration-form provider-configuration-form";
	const configurationAllowed = location.protocol === "https:" || isLoopbackHostname(location.hostname);
	const connections = capabilityConnections.filter(
		(entry) => entry.providerId === provider.id && entry.status === "active" && entry.id !== "plaid-all",
	);
	const connection = connections[0];
	if (connections.length > 0) {
		appendText(
			form,
			connections.length === 1
				? `Connected account: ${connection!.accountLabel}`
				: `${connections.length} connected accounts: ${connections.map((entry) => entry.accountLabel).join(", ")}`,
			"provider-account",
		);
	}
	if (provider.id === "google-workspace" && !isLoopbackHostname(location.hostname)) {
		appendText(
			form,
			"If the registered callback uses 127.0.0.1, complete authorization in a browser on this Pi host.",
			"muted",
		);
	}
	for (const field of provider.authentication?.fields ?? []) {
		if (field.operatorEditable === false) continue;
		const label = document.createElement("label");
		label.textContent = `${field.label}${field.required ? " *" : ""}`;
		const fieldRow = document.createElement("div");
		fieldRow.className = "provider-field-row";
		const input = field.options ? document.createElement("select") : document.createElement("input");
		input.name = field.env;
		if (input instanceof HTMLInputElement) {
			input.type = field.secret ? "password" : field.format === "url" ? "url" : "text";
			input.autocomplete = "off";
		} else {
			for (const optionValue of field.options ?? []) {
				const option = document.createElement("option");
				option.value = optionValue.value;
				option.textContent = optionValue.label;
				input.append(option);
			}
		}
		input.disabled = !configurationAllowed;
		if (!field.secret && field.value) input.value = field.value;
		if (input instanceof HTMLInputElement) {
			input.placeholder = field.configured ? "Configured" : "Enter value";
		}
		const store = providerFieldActionButton("store", `Save ${field.label} to vault`);
		store.disabled = !configurationAllowed || (input instanceof HTMLInputElement && input.value === "");
		store.addEventListener("click", () => {
			const value = input.value;
			if (!value) return;
			store.disabled = true;
			void configureCapabilityProviderField(provider.id, field.env, value, false).catch((error: unknown) => {
				setStatus(error instanceof Error ? error.message : String(error), true);
				store.disabled = false;
			});
		});
		input.addEventListener("input", () => {
			store.disabled = !configurationAllowed || input.value === "";
		});
		fieldRow.append(input, store);
		if (field.configured) {
			const remove = providerFieldActionButton("remove", `Remove ${field.label} from vault`);
			remove.disabled = !configurationAllowed;
			remove.classList.add("danger");
			remove.addEventListener("click", () => {
				if (!window.confirm(`Remove ${field.label} from the encrypted vault?`)) return;
				remove.disabled = true;
				void configureCapabilityProviderField(provider.id, field.env, "", true).catch((error: unknown) => {
					setStatus(error instanceof Error ? error.message : String(error), true);
					remove.disabled = false;
				});
			});
			fieldRow.append(remove);
		}
		label.append(fieldRow);
		form.append(label);
	}
	if (!configurationAllowed) {
		appendText(form, "Edit credentials on this Pi host or through authenticated HTTPS.", "muted");
	}
	if (provider.authentication?.kind === "oauth2" || provider.authentication?.kind === "plaid-link") {
		if (provider.authentication.capabilityGroups?.length) {
			form.append(providerCapabilityPermissions(provider, connection));
		}
		const connected = connections.length > 0;
		const plaid = provider.authentication.kind === "plaid-link";
		const authorize = document.createElement("button");
		authorize.type = "button";
		authorize.textContent = plaid
			? connected
				? "Connect another account"
				: "Connect financial account"
			: connected
				? "Update Google access"
				: "Connect Google account";
		authorize.disabled = !provider.authentication.configured;
		authorize.title = authorize.disabled ? "Save the required OAuth configuration first" : "";
		authorize.addEventListener("click", () => {
			authorize.disabled = true;
			authorize.textContent = "Connecting…";
			void startProviderAuthorization(provider.id, form).catch((error: unknown) => {
				setStatus(error instanceof Error ? error.message : String(error), true);
				authorize.disabled = false;
				authorize.textContent = plaid
					? connected
						? "Connect another account"
						: "Connect financial account"
					: connected
						? "Update Google access"
						: "Connect Google account";
			});
		});
		form.append(authorize);
		if (connected) {
			const revoke = document.createElement("button");
			revoke.type = "button";
			revoke.className = "danger";
			revoke.textContent = "Revoke";
			revoke.addEventListener("click", () => void revokeProviderAuthorization(provider.id));
			form.append(revoke);
		}
	}
	form.addEventListener("submit", (event) => {
		event.preventDefault();
	});
	return form;
}

function providerFieldActionButton(action: "store" | "remove", label: string): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "provider-field-action";
	button.title = label;
	button.setAttribute("aria-label", label);
	const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	icon.setAttribute("viewBox", "0 0 24 24");
	icon.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute(
		"d",
		action === "store" ? "M4 12h14m-5-5 5 5-5 5M5 5v14" : "M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14",
	);
	icon.append(path);
	button.append(icon);
	return button;
}

function providerCapabilityPermissions(
	provider: CapabilityProvider,
	connection: CapabilityConnectionSummary | undefined,
): HTMLElement {
	const section = document.createElement("div");
	section.className = "provider-permissions";
	appendText(
		section,
		connection
			? `Connected ${provider.authentication?.kind === "plaid-link" ? "financial data" : "Google access"}`
			: `${provider.authentication?.kind === "plaid-link" ? "Financial data" : "Google access"} to request`,
		"provider-permissions-title",
	);
	const selected = new Set(connection?.capabilityIds ?? provider.authentication?.defaultCapabilityIds ?? []);
	for (const group of provider.authentication?.capabilityGroups ?? []) {
		const service = document.createElement("fieldset");
		service.className = "provider-service";
		const supported = group.capabilityIds.filter((capabilityId) =>
			providerCapabilitySupported(provider, capabilityId),
		);
		const connected = supported.filter((capabilityId) => connection?.capabilityIds.includes(capabilityId));
		const legend = document.createElement("legend");
		legend.textContent = group.label;
		const state = document.createElement("span");
		state.className = connected.length > 0 ? "provider-service-state available" : "provider-service-state";
		state.textContent =
			supported.length === 0
				? "Adapter required"
				: connection
					? `${connected.length} connected`
					: `${supported.length} supported`;
		legend.append(state);
		service.append(legend);
		for (const capabilityId of group.capabilityIds) {
			const capability = capabilitySnapshot?.capabilities.find((entry) => entry.id === capabilityId);
			const label = document.createElement("label");
			label.className = "provider-capability";
			const checkbox = document.createElement("input");
			checkbox.type = "checkbox";
			checkbox.dataset.authorizationCapability = capabilityId;
			checkbox.checked = selected.has(capabilityId);
			checkbox.disabled = !providerCapabilitySupported(provider, capabilityId);
			label.append(checkbox, capability?.name ?? capabilityId);
			service.append(label);
		}
		section.append(service);
	}
	return section;
}

function providerCapabilitySupported(provider: CapabilityProvider, capabilityId: string): boolean {
	const binding = provider.bindings.find((entry) => entry.capabilityId === capabilityId);
	return Boolean(binding && (!binding.toolName || !provider.missingTools.includes(binding.toolName)));
}

async function startProviderAuthorization(providerId: string, form: HTMLFormElement): Promise<void> {
	if (!capabilityToken) return;
	const capabilityIds = [...form.querySelectorAll<HTMLInputElement>("input[data-authorization-capability]:checked")]
		.filter((input) => !input.disabled)
		.map((input) => input.dataset.authorizationCapability ?? "")
		.filter(Boolean);
	if (capabilityIds.length === 0) throw new Error("Select at least one available provider capability");
	const existingConnectionIds = new Set(
		capabilityConnections
			.filter((connection) => connection.providerId === providerId && connection.status === "active")
			.map((connection) => connection.id),
	);
	const popup = window.open("", "pi-provider-authorization", "popup,width=620,height=760");
	if (!popup) throw new Error("Allow popups to authorize this provider");
	const response = await fetch(
		`/capability-providers/${encodeURIComponent(providerId)}/authorize?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ capabilityIds }),
		},
	);
	if (!response.ok) {
		popup.close();
		throw new Error(await responseError(response, "Could not start provider authorization"));
	}
	const payload: unknown = await response.json();
	if (
		typeof payload !== "object" ||
		payload === null ||
		!("authorizationUrl" in payload) ||
		typeof payload.authorizationUrl !== "string"
	)
		throw new Error("Provider authorization returned an invalid URL");
	popup.location.href = payload.authorizationUrl;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await new Promise((resolve) => window.setTimeout(resolve, 2_000));
		await loadCapabilityConnections();
		const activeConnections = capabilityConnections.filter(
			(connection) => connection.providerId === providerId && connection.status === "active",
		);
		if (
			activeConnections.some((connection) => !existingConnectionIds.has(connection.id)) ||
			(providerId !== "plaid" && activeConnections.length > 0)
		) {
			await loadCapabilities();
			setStatus("Provider connected");
			return;
		}
	}
	throw new Error("Provider authorization did not complete within two minutes");
}

async function revokeProviderAuthorization(providerId: string): Promise<void> {
	if (!capabilityToken || !window.confirm(`Revoke ${providerId} authorization?`)) return;
	const response = await fetch(
		`/capability-providers/${encodeURIComponent(providerId)}/revoke?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not revoke provider authorization"));
	await Promise.all([loadCapabilityConnections(), loadCapabilities(), loadRoutines()]);
	setStatus("Provider authorization revoked");
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

async function configureCapabilityProviderField(
	providerId: string,
	name: string,
	value: string,
	clear: boolean,
): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/capability-providers/${encodeURIComponent(providerId)}/configuration?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ values: clear ? {} : { [name]: value }, clear: clear ? [name] : [] }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not configure provider"));
	await loadCapabilities();
	setStatus(clear ? "Vault value removed" : "Vault value saved");
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
		const matchingConnections = capabilityConnections.filter(
			(entry) =>
				entry.status === "active" &&
				entry.providerId === capability.defaultProviderId &&
				entry.capabilityIds.includes(capability.id),
		);
		const connection = matchingConnections.find((entry) => entry.id === "plaid-all") ?? matchingConnections[0];
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
	updateAgentBuilderReadiness();
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
	updateAgentBuilderReadiness();
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

function loadAgents(): Promise<void> {
	agentsLoadPromise ??= loadAgentsNow().finally(() => {
		agentsLoadPromise = undefined;
	});
	return agentsLoadPromise;
}

async function loadAgentsNow(): Promise<void> {
	if (!capabilityToken) return;
	const [response, buildsResponse] = await Promise.all([
		fetch(`/agents.json?token=${encodeURIComponent(capabilityToken)}`),
		fetch(`/agent-builds.json?token=${encodeURIComponent(capabilityToken)}`),
	]);
	if (!response.ok) throw new Error(`Could not load agents: HTTP ${response.status}`);
	if (!buildsResponse.ok) throw new Error(`Could not load agent drafts: HTTP ${buildsResponse.status}`);
	const payload: unknown = await response.json();
	const buildsPayload: unknown = await buildsResponse.json();
	if (!isAgentList(payload)) throw new Error("Agent registry returned an invalid response");
	if (!isAgentBuildList(buildsPayload)) throw new Error("Agent build service returned an invalid response");
	agents = payload.agents;
	agentBuilds = buildsPayload.builds;
	for (let index = openAgentIds.length - 1; index >= 0; index -= 1) {
		if (!agents.some((agent) => agent.id === openAgentIds[index])) openAgentIds.splice(index, 1);
	}
	agentList.replaceChildren(
		...agentBuilds.filter((build) => !build.agentId).map(renderAgentBuildDraftCard),
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
			menu.addEventListener("toggle", () => {
				if (menu.open) closeAgentMenus(menu);
			});
			const menuButton = document.createElement("summary");
			menuButton.textContent = "⋯";
			menuButton.title = "Agent actions";
			const actions = document.createElement("div");
			actions.addEventListener("click", () => {
				menu.open = false;
			});
			const edit = document.createElement("button");
			edit.type = "button";
			edit.textContent = "Edit";
			edit.addEventListener("click", () => void openAgentBuilder(agent));
			const improve = document.createElement("button");
			improve.type = "button";
			improve.textContent = "Improve";
			improve.addEventListener("click", () => openAgentImprovementReview(agent));
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
			actions.append(edit, improve, duplicate, remove);
			menu.append(menuButton, actions);
			card.append(button, menu);
			return card;
		}),
	);
	refreshRoutineEditorOptions();
	refreshWorkflowEditorOptions();
	renderSessionNavigation();
	await loadAgentActivity();
}

function renderAgentBuildDraftCard(build: AgentBuildRecord): HTMLElement {
	const card = document.createElement("div");
	card.className = "agent-entry-card agent-draft-card";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "nav-item agent-entry";
	button.title = build.objective;
	const icon = document.createElement("span");
	icon.className = "agent-icon";
	icon.textContent = "○";
	const copy = document.createElement("span");
	const name = document.createElement("strong");
	name.className = "agent-name";
	name.textContent = build.name;
	const state = document.createElement("small");
	state.textContent = "Draft";
	copy.append(name, state);
	button.append(icon, copy);
	button.addEventListener("click", () => void resumeAgentBuildDraft(build));
	card.append(button);
	return card;
}

async function resumeAgentBuildDraft(build: AgentBuildRecord): Promise<void> {
	await openAgentBuilder();
	activeAgentBuild = build;
	if (build.configuration) applyAgentBuildConfiguration(build.configuration);
	else {
		requiredElement<HTMLInputElement>("agent-name").value = build.name;
		requiredElement<HTMLTextAreaElement>("agent-description").value = build.objective.startsWith("Refine the purpose")
			? ""
			: build.objective;
		requiredElement<HTMLInputElement>("agent-project-root").value = build.projectRoot;
	}
	updateAgentBuilderReadiness();
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
	input.focus();
	setStatus(`Resumed draft ${build.name}`);
}

function applyAgentBuildConfiguration(configuration: NonNullable<AgentBuildRecord["configuration"]>): void {
	requiredElement<HTMLInputElement>("agent-name").value = configuration.name;
	requiredElement<HTMLTextAreaElement>("agent-description").value = configuration.description;
	requiredElement<HTMLTextAreaElement>("agent-persona").value = configuration.persona;
	requiredElement<HTMLInputElement>("agent-project-root").value = configuration.projectRoot;
	requiredElement<HTMLInputElement>("agent-tools").value = configuration.tools.join(",");
	requiredElement<HTMLSelectElement>("agent-memory").value = configuration.memory;
	requiredElement<HTMLSelectElement>("agent-executor").value = configuration.executor;
	requiredElement<HTMLSelectElement>("agent-permissions").value = configuration.permissionPolicy;
	requiredElement<HTMLSelectElement>("agent-browser-access").value = configuration.browserAccess;
	requiredElement<HTMLInputElement>("agent-delegates").value = configuration.delegateAgentIds.join(",");
	requiredElement<HTMLInputElement>("agent-a2a").checked = configuration.exposeA2a;
	if (configuration.model) {
		requiredElement<HTMLSelectElement>("agent-model").value =
			`${configuration.model.provider}/${configuration.model.id}`;
		agentModelPicker.refresh();
	}
	if (configuration.thinking) requiredElement<HTMLSelectElement>("agent-thinking").value = configuration.thinking;
	updateThinkingLevelAvailability(
		requiredElement<HTMLSelectElement>("agent-thinking"),
		requiredElement<HTMLSelectElement>("agent-model").value,
		configuration.thinking,
	);
	updateAgentBrowserProfileFields();
	updateBuilderCapabilitySummary();
}

function closeAgentMenus(except?: HTMLDetailsElement): void {
	for (const menu of document.querySelectorAll<HTMLDetailsElement>(".agent-menu[open]")) {
		if (menu !== except) menu.open = false;
	}
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

function isAgentBuildList(value: unknown): value is { builds: AgentBuildRecord[] } {
	if (typeof value !== "object" || value === null || !("builds" in value) || !Array.isArray(value.builds)) {
		return false;
	}
	return value.builds.every(isAgentBuildRecord);
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

function createClaudeAuthFlow(): {
	panel: HTMLElement;
	message: HTMLElement;
	link: HTMLAnchorElement;
	cancel: HTMLButtonElement;
} {
	const panel = document.createElement("div");
	panel.className = "card external-auth-flow hidden";
	panel.setAttribute("role", "status");
	panel.setAttribute("aria-live", "polite");
	const title = document.createElement("strong");
	title.textContent = "Connect Claude subscription";
	const message = document.createElement("p");
	message.className = "muted";
	const actions = document.createElement("div");
	actions.className = "external-auth-actions";
	const link = document.createElement("a");
	link.className = "hidden";
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.textContent = "Continue sign-in";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "hidden";
	cancel.textContent = "Cancel";
	actions.append(link, cancel);
	panel.append(title, message, actions);
	externalConnectionList.after(panel);
	cancel.addEventListener("click", () => void cancelClaudeSubscriptionLogin());
	return { panel, message, link, cancel };
}

let claudeAuthPoll: number | undefined;

async function startClaudeSubscriptionLogin(): Promise<void> {
	if (!capabilityToken) return;
	claudeAuthFlow.panel.classList.remove("hidden");
	claudeAuthFlow.message.textContent = "Starting Claude Code sign-in…";
	const response = await fetch(`/auth/claude-subscription?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not start Claude subscription login"));
	const status: unknown = await response.json();
	if (!isClaudeSubscriptionLoginStatus(status)) throw new Error("Claude login returned an invalid response");
	renderClaudeSubscriptionLogin(status);
}

async function pollClaudeSubscriptionLogin(): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(`/auth/claude-subscription?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(await responseError(response, "Could not read Claude subscription login"));
	const status: unknown = await response.json();
	if (!isClaudeSubscriptionLoginStatus(status)) throw new Error("Claude login returned an invalid response");
	renderClaudeSubscriptionLogin(status);
}

async function cancelClaudeSubscriptionLogin(): Promise<void> {
	if (!capabilityToken) return;
	if (claudeAuthPoll !== undefined) window.clearTimeout(claudeAuthPoll);
	const response = await fetch(`/auth/claude-subscription?token=${encodeURIComponent(capabilityToken)}`, {
		method: "DELETE",
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not cancel Claude subscription login"));
	const status: unknown = await response.json();
	if (!isClaudeSubscriptionLoginStatus(status)) throw new Error("Claude login returned an invalid response");
	renderClaudeSubscriptionLogin(status);
}

function renderClaudeSubscriptionLogin(status: ClaudeSubscriptionLoginStatus): void {
	claudeAuthFlow.panel.classList.toggle("hidden", status.status === "succeeded");
	claudeAuthFlow.link.classList.toggle("hidden", status.status !== "running" || status.authorizationUrl === undefined);
	if (status.authorizationUrl) claudeAuthFlow.link.href = status.authorizationUrl;
	claudeAuthFlow.cancel.classList.toggle("hidden", status.status !== "running");
	claudeAuthFlow.message.textContent =
		status.status === "running"
			? status.authorizationUrl
				? "Finish authorization in the Claude sign-in page."
				: "Waiting for Claude authorization. A sign-in page may open on the Pi host."
			: status.status === "succeeded"
				? "Claude subscription is connected and ready."
				: status.status === "failed"
					? (status.error ?? "Claude subscription login failed")
					: "Claude subscription is not connected.";
	if (status.status === "running") {
		if (claudeAuthPoll !== undefined) window.clearTimeout(claudeAuthPoll);
		claudeAuthPoll = window.setTimeout(() => {
			void pollClaudeSubscriptionLogin().catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		}, 1_000);
	} else {
		claudeAuthPoll = undefined;
		if (status.authenticated) {
			setStatus("Claude subscription connected");
			void loadExternalConnections();
		}
	}
}

function isClaudeSubscriptionLoginStatus(value: unknown): value is ClaudeSubscriptionLoginStatus {
	return (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		(value.status === "idle" ||
			value.status === "running" ||
			value.status === "succeeded" ||
			value.status === "failed") &&
		"authenticated" in value &&
		typeof value.authenticated === "boolean" &&
		(!("authorizationUrl" in value) ||
			value.authorizationUrl === undefined ||
			typeof value.authorizationUrl === "string") &&
		(!("error" in value) || value.error === undefined || typeof value.error === "string")
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
			const canConnectSubscription = connection.id === "claude-code-subscription" && !connection.available;
			button.type = "button";
			button.className = "nav-item external-connection-entry";
			button.classList.toggle("active", connection.id === selectedExternalConnectionId);
			button.disabled = !connection.available && !canConnectSubscription;
			const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			icon.classList.add("external-connection-icon");
			icon.dataset.provider = connection.provider;
			icon.setAttribute("viewBox", "0 0 24 24");
			icon.setAttribute("aria-hidden", "true");
			const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
			use.setAttribute(
				"href",
				connection.provider === "anthropic"
					? "#external-icon-anthropic"
					: connection.provider === "openai"
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
				? `${connection.authentication === "subscription" ? "Subscription" : connection.authentication === "api-key" ? "API" : "Configured"} · ${connection.defaultModel.id}`
				: canConnectSubscription
					? "Connect"
					: "Unavailable";
			copy.append(name, state);
			button.append(icon, copy);
			button.title = connection.description;
			button.addEventListener("click", () => {
				if (canConnectSubscription) {
					void startClaudeSubscriptionLogin().catch((error: unknown) =>
						setStatus(error instanceof Error ? error.message : String(error), true),
					);
					return;
				}
				openExternalConnection(connection);
			});
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
			"provider" in connection &&
			(connection.provider === "anthropic" ||
				connection.provider === "openai" ||
				connection.provider === "hermes") &&
			"authentication" in connection &&
			(connection.authentication === "subscription" ||
				connection.authentication === "api-key" ||
				connection.authentication === "configured") &&
			"billing" in connection &&
			(connection.billing === "subscription" ||
				connection.billing === "usage-based" ||
				connection.billing === "configured") &&
			"available" in connection &&
			typeof connection.available === "boolean" &&
			"models" in connection &&
			Array.isArray(connection.models),
	);
}

function openExternalConnection(connection: ExternalConnectionSummary): void {
	selectedExternalConnectionId = connection.id;
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activeExternalRunId = undefined;
	activeExternalConnectionId = connection.id;
	activeArtifactId = undefined;
	if (!openExternalConnectionIds.includes(connection.id)) openExternalConnectionIds.push(connection.id);
	requiredElement<HTMLInputElement>("external-id").value = connection.id;
	element("external-title").textContent = connection.name;
	element("external-description").textContent = connection.description;
	element("external-warning").textContent = connection.warning ?? "";
	element("external-prompt-label").childNodes[0].textContent = connection.inputLabel;
	requiredElement<HTMLTextAreaElement>("external-prompt").placeholder =
		`${connection.inputLabel} for ${connection.name}`;
	const latestRun = externalRuns
		.filter((run) => run.connectionId === connection.id)
		.sort((left, right) => right.createdAt - left.createdAt)[0];
	requiredElement<HTMLInputElement>("external-cwd").value =
		localStorage.getItem(`pi-serve-external-cwd:${connection.id}`) ?? latestRun?.cwd ?? session?.snapshot?.cwd ?? "";
	externalModel.replaceChildren(
		...connection.models.map((entry) => {
			const option = document.createElement("option");
			option.value = `${entry.provider}/${entry.id}`;
			option.textContent = modelOptionLabel(entry);
			applyModelCostPresentation(option, entry);
			return option;
		}),
	);
	externalModel.value = `${connection.defaultModel.provider}/${connection.defaultModel.id}`;
	externalModelPicker.refresh();
	element("external-delegate").classList.add("hidden");
	activateTab("agents-workspace");
	mobilePanelNone.checked = true;
	persistExternalConnectionTabs();
	renderExternalConversation(connection);
	renderSessionNavigation();
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

interface BuilderRequirement {
	fieldId: string;
	label: string;
	panelId: string;
}

const builderRequirements: BuilderRequirement[] = [
	{ fieldId: "agent-name", label: "Name", panelId: "builder-profile-panel" },
	{ fieldId: "agent-description", label: "Description", panelId: "builder-profile-panel" },
	{ fieldId: "agent-project-root", label: "Project folder", panelId: "builder-profile-panel" },
	{ fieldId: "agent-persona", label: "Persona instructions", panelId: "builder-profile-panel" },
];

const agentBuilderTrackedFieldIds = [
	"agent-id",
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
	"agent-tools",
	"agent-capabilities",
	"agent-browser-workflows",
	"agent-delegates",
	"agent-a2a",
] as const;

function agentBuilderDraftSignature(): string {
	return JSON.stringify(
		agentBuilderTrackedFieldIds.map((fieldId) => {
			const field = requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(fieldId);
			return [fieldId, field instanceof HTMLInputElement && field.type === "checkbox" ? field.checked : field.value];
		}),
	);
}

function agentBuilderConfigurationError(): string | undefined {
	const permissions = requiredElement<HTMLSelectElement>("agent-permissions").value;
	if (permissions === "read-only" && selectedAgentTools().has("write"))
		return "Read-only agents cannot enable the write tool.";
	return undefined;
}

function installAgentBuilderStepControls(): void {
	const panelIds = [
		"builder-profile-panel",
		"builder-tools-panel",
		"builder-capabilities-panel",
		"builder-connections-panel",
		"builder-automation-panel",
	];
	panelIds.forEach((panelId, index) => {
		const panel = element(panelId);
		const controls = document.createElement("div");
		controls.className = "routine-actions";
		if (index > 0) {
			const back = document.createElement("button");
			back.type = "button";
			back.className = "secondary-action";
			back.textContent = "Back";
			back.addEventListener("click", () => activateBuilderTab(panelIds[index - 1] ?? panelId));
			controls.append(back);
		}
		if (index < panelIds.length - 1) {
			const next = document.createElement("button");
			next.type = "button";
			next.className = "secondary-action";
			next.textContent = "Next";
			next.addEventListener("click", () => {
				const missing = missingBuilderRequirements().find((entry) => entry.panelId === panelId);
				if (missing) {
					const field = requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
						missing.fieldId,
					);
					field.focus();
					field.reportValidity();
					setStatus(`${missing.label} is required before continuing`, true);
					return;
				}
				activateBuilderTab(panelIds[index + 1] ?? panelId);
			});
			controls.append(next);
		}
		panel.append(controls);
	});
}

function missingBuilderRequirements(): BuilderRequirement[] {
	const missing = builderRequirements.filter((requirement) => {
		const field = requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(requirement.fieldId);
		return !field.value.trim() || !field.checkValidity();
	});
	const profileKind = requiredElement<HTMLSelectElement>("agent-browser-profile-kind").value;
	const profile = requiredElement<HTMLInputElement>("agent-browser-profile-id");
	if (profileKind === "named" && (!profile.value.trim() || !profile.checkValidity()))
		missing.push({
			fieldId: "agent-browser-profile-id",
			label: "Browser profile name",
			panelId: "builder-tools-panel",
		});
	return missing;
}

function updateAgentBuilderReadiness(): void {
	const missing = missingBuilderRequirements();
	const ready = missing.length === 0;
	const configurationError = agentBuilderConfigurationError();
	const dirty = agentBuilderDraftSignature() !== agentBuilderBaseline;
	const canApply = ready && configurationError === undefined && dirty;
	agentSubmit.disabled = !canApply;
	agentSubmit.setAttribute("aria-disabled", String(!canApply));
	agentSubmit.title = !ready
		? `Required: ${missing.map((entry) => entry.label).join(", ")}`
		: (configurationError ?? (dirty ? "Apply these changes to the agent" : "No changes to apply"));
	agentSubmit.style.opacity = canApply ? "" : ".55";
	const chatApply = document.getElementById("builder-chat-apply");
	if (chatApply instanceof HTMLButtonElement) {
		chatApply.disabled = !canApply;
		chatApply.setAttribute("aria-disabled", String(!canApply));
		chatApply.title = agentSubmit.title;
	}
	agentValidation.className = ready && configurationError === undefined ? "muted" : "run-error";
	agentValidation.textContent = !ready
		? `Complete ${missing.map((entry) => entry.label).join(", ")} before deployment.`
		: configurationError
			? configurationError
			: dirty
				? "Unsaved changes. Review them, then apply the update."
				: agentBuilderFeedback || "No changes to apply.";
	const incompletePanels = new Set(missing.map((entry) => entry.panelId));
	for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-builder-tab]")) {
		const base = tab.dataset.baseLabel ?? tab.textContent?.replace(/[ ✓•]+$/, "") ?? "Step";
		tab.dataset.baseLabel = base;
		tab.textContent = `${base} ${incompletePanels.has(tab.dataset.builderTab ?? "") ? "•" : "✓"}`;
	}
}

function validateAgentBuilder(): boolean {
	updateAgentBuilderReadiness();
	const first = missingBuilderRequirements()[0];
	if (!first) {
		const configurationError = agentBuilderConfigurationError();
		if (configurationError) {
			activateBuilderTab("builder-tools-panel");
			setStatus(configurationError, true);
			return false;
		}
		if (agentBuilderDraftSignature() === agentBuilderBaseline) {
			setStatus("No agent changes to apply");
			return false;
		}
		return true;
	}
	activateBuilderTab(first.panelId);
	const field = requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(first.fieldId);
	field.focus();
	field.reportValidity();
	setStatus(`${first.label} is required before the agent can be deployed`, true);
	return false;
}

function agentBuildDraftInput():
	| {
			name: string;
			objective: string;
			projectRoot: string;
			configuration?: AgentBuildRecord["configuration"];
			criteria?: unknown[];
	  }
	| undefined {
	const name = requiredElement<HTMLInputElement>("agent-name").value.trim();
	const projectRoot = requiredElement<HTMLInputElement>("agent-project-root").value.trim();
	if (!name || !projectRoot) return undefined;
	const description = requiredElement<HTMLTextAreaElement>("agent-description").value.trim();
	return {
		name,
		objective: description || `Refine the purpose and expected outcome of ${name}.`,
		projectRoot,
		configuration: agentBuildConfigurationInput(),
		criteria: draftedAgentCriteria ?? activeAgentBuild?.criteria,
	};
}

function agentBuildConfigurationInput(): AgentBuildRecord["configuration"] | undefined {
	const value = (id: string) =>
		requiredElement<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value.trim();
	const name = value("agent-name");
	const description = value("agent-description");
	const persona = value("agent-persona");
	const projectRoot = value("agent-project-root");
	if (!name || !description || !persona || !projectRoot) return undefined;
	const modelReference = value("agent-model");
	const separator = modelReference.indexOf("/");
	return {
		name,
		description,
		persona,
		projectRoot,
		tools: value("agent-tools")
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean),
		model:
			separator > 0
				? { provider: modelReference.slice(0, separator), id: modelReference.slice(separator + 1) }
				: undefined,
		thinking: value("agent-thinking") as ThinkingLevel,
		memory: value("agent-memory") as "none" | "notes",
		executor: value("agent-executor") as "session" | "harness",
		permissionPolicy: value("agent-permissions") as "read-only" | "workspace-write",
		browserAccess: value("agent-browser-access") as "disabled" | "loopback" | "public-web" | "private-network",
		delegateAgentIds: value("agent-delegates")
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean),
		exposeA2a: requiredElement<HTMLInputElement>("agent-a2a").checked,
	};
}

function scheduleAgentBuildDraftPersistence(): void {
	if (activeAgentBuild?.agentId) return;
	if (agentBuildDraftTimer !== undefined) window.clearTimeout(agentBuildDraftTimer);
	agentBuildDraftTimer = window.setTimeout(() => {
		agentBuildDraftTimer = undefined;
		void persistAgentBuildDraft().catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		);
	}, 350);
}

async function persistAgentBuildDraft(): Promise<void> {
	if (!capabilityToken) return;
	const draft = agentBuildDraftInput();
	if (!draft) return;
	const path = activeAgentBuild ? `/agent-builds/${encodeURIComponent(activeAgentBuild.id)}` : "/agent-builds/draft";
	const response = await fetch(`${path}?token=${encodeURIComponent(capabilityToken)}`, {
		method: activeAgentBuild ? "PUT" : "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(draft),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not save agent draft"));
	const payload: unknown = await response.json();
	if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid draft");
	activeAgentBuild = payload;
	draftedAgentCriteria = payload.criteria;
	if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
}

async function loadAgentBuildForAgent(agentId: string): Promise<AgentBuildRecord | undefined> {
	if (!capabilityToken) return undefined;
	const response = await fetch(`/agent-builds/for-agent?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agentId }),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not load agent build lifecycle"));
	const payload: unknown = await response.json();
	if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid record");
	activeAgentBuild = payload;
	draftedAgentCriteria = payload.criteria;
	return payload;
}

async function linkActiveAgentBuild(agentId: string): Promise<void> {
	if (!capabilityToken) return;
	if (!activeAgentBuild) {
		await loadAgentBuildForAgent(agentId);
		return;
	}
	const response = await fetch(
		`/agent-builds/${encodeURIComponent(activeAgentBuild.id)}/link-agent?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not link the agent build"));
	const payload: unknown = await response.json();
	if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid record");
	activeAgentBuild = payload;
	draftedAgentCriteria = payload.criteria;
	await loadAgents();
}

async function refreshActiveAgentBuild(): Promise<void> {
	if (!capabilityToken || !activeAgentBuild) return;
	const previousRevision = activeAgentBuild.revision;
	const response = await fetch(
		`/agent-builds/${encodeURIComponent(activeAgentBuild.id)}?token=${encodeURIComponent(capabilityToken)}`,
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not refresh agent build lifecycle"));
	const payload: unknown = await response.json();
	if (!isAgentBuildRecord(payload)) throw new Error("Agent build service returned an invalid record");
	activeAgentBuild = payload;
	draftedAgentCriteria = payload.criteria;
	if (payload.revision !== previousRevision && payload.stage === "draft" && payload.configuration) {
		applyAgentBuildConfiguration(payload.configuration);
		agentBuilderFeedback = `Staged revision ${payload.revision} is ready to review and apply.`;
		updateAgentBuilderReadiness();
	}
	if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
}

function isAgentBuildRecord(value: unknown): value is AgentBuildRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<AgentBuildRecord>;
	return (
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.objective === "string" &&
		typeof record.projectRoot === "string" &&
		[
			"draft",
			"ready-to-test",
			"testing",
			"proof-ready",
			"needs-refinement",
			"proven",
			"promoted",
			"automated",
		].includes(String(record.stage))
	);
}

function applyLatestAgentBuilderDraft(snapshot: SessionSnapshot): void {
	const encoded = latestAgentBuilderDraftFromSnapshot(snapshot);
	if (!encoded || encoded === lastAppliedBuilderDraft) return;
	applyAgentBuilderDraft(encoded);
}

function applyAgentBuilderDraft(encoded: string): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(encoded);
	} catch (error) {
		const message = `Agent draft JSON is invalid: ${error instanceof Error ? error.message : String(error)}`;
		agentBuilderFeedback = message;
		agentValidation.className = "run-error";
		agentValidation.textContent = message;
		setStatus(message, true);
		return;
	}
	const draft = objectRecord(parsed);
	if (!draft) {
		const message = "Agent draft marker must contain one JSON object";
		agentBuilderFeedback = message;
		agentValidation.className = "run-error";
		agentValidation.textContent = message;
		setStatus(message, true);
		return;
	}
	lastAppliedBuilderDraft = encoded;
	agentBuilderFeedback = "";
	const warnings: string[] = [];
	const supportedFields = new Set([
		"name",
		"description",
		"projectRoot",
		"personaId",
		"persona",
		"systemPrompt",
		"model",
		"thinking",
		"executor",
		"permissionPolicy",
		"browserAccess",
		"tools",
		"delegateAgentIds",
		"criteria",
	]);
	const unsupported = Object.keys(draft).filter((field) => !supportedFields.has(field));
	if (unsupported.length > 0) warnings.push(`Unsupported fields: ${unsupported.join(", ")}`);
	setBuilderDraftText("agent-name", draft.name);
	setBuilderDraftText("agent-description", draft.description);
	setBuilderDraftText("agent-project-root", draft.projectRoot);
	if (typeof draft.personaId === "string" && personas.some((entry) => entry.id === draft.personaId)) {
		if (personaSelect.value !== draft.personaId) {
			personaSelect.value = draft.personaId;
			updatePersonaPreview(true);
		}
	} else if (typeof draft.persona === "string" || typeof draft.systemPrompt === "string") {
		const instructions = typeof draft.persona === "string" ? draft.persona : String(draft.systemPrompt);
		const persona = personas.find((entry) => entry.id === instructions);
		if (persona && personaSelect.value !== persona.id) {
			personaSelect.value = persona.id;
			updatePersonaPreview(true);
		} else if (!persona) setBuilderDraftText("agent-persona", instructions);
	}
	if (!setBuilderDraftSelect("agent-model", draft.model)) warnings.push(`Unavailable model ${String(draft.model)}`);
	setBuilderDraftSelect("agent-thinking", draft.thinking);
	setBuilderDraftSelect("agent-executor", draft.executor);
	setBuilderDraftSelect("agent-permissions", draft.permissionPolicy);
	setBuilderDraftSelect("agent-browser-access", draft.browserAccess);
	if (Array.isArray(draft.tools) && draft.tools.every((entry) => typeof entry === "string")) {
		const permissions = requiredElement<HTMLSelectElement>("agent-permissions").value;
		if (permissions === "read-only" && draft.tools.includes("write"))
			warnings.push("Ignored write tool because the draft is read-only");
		else requiredElement<HTMLInputElement>("agent-tools").value = draft.tools.join(",");
	}
	if (Array.isArray(draft.delegateAgentIds) && draft.delegateAgentIds.every((entry) => typeof entry === "string"))
		requiredElement<HTMLInputElement>("agent-delegates").value = draft.delegateAgentIds.join(", ");
	if (draft.criteria !== undefined) {
		if (Array.isArray(draft.criteria)) draftedAgentCriteria = draft.criteria;
		else warnings.push("Improvement criteria must be an array");
	}
	updateAgentBrowserProfileFields();
	agentModelPicker.refresh();
	updateThinkingLevelAvailability(
		agentThinking,
		agentModel.value || (session?.snapshot ? `${session.snapshot.model.provider}/${session.snapshot.model.id}` : ""),
		agentThinking.value as ThinkingLevel,
	);
	agentThinkingPicker.refresh();
	updateAgentBuilderReadiness();
	element("builder-title").textContent = requiredElement<HTMLInputElement>("agent-name").value || "Build a new agent";
	void loadCapabilities().catch(() => {});
	scheduleAgentBuildDraftPersistence();
	setStatus(
		warnings.length > 0
			? `Agent Builder applied the valid draft fields. ${warnings.join(". ")}.`
			: "Agent Builder applied a draft. Review each step, then apply the update.",
		warnings.length > 0,
	);
}

function latestAgentBuilderDraft(content: string): string | undefined {
	const matches = [...content.matchAll(/\[AGENT_DRAFT\]([\s\S]*?)\[\/AGENT_DRAFT\]/g)];
	return matches.at(-1)?.[1]?.trim();
}

function latestAgentBuilderDraftFromSnapshot(snapshot: SessionSnapshot | undefined): string {
	if (!snapshot) return "";
	const text = snapshot.transcript
		.filter((item) => item.role === "assistant")
		.flatMap((item) => item.content)
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	return latestAgentBuilderDraft(text) ?? "";
}

function setBuilderDraftText(fieldId: string, value: unknown): void {
	if (typeof value !== "string" || !value.trim()) return;
	requiredElement<HTMLInputElement | HTMLTextAreaElement>(fieldId).value = value.trim();
}

function setBuilderDraftSelect(fieldId: string, value: unknown): boolean {
	if (typeof value !== "string") return true;
	const select = requiredElement<HTMLSelectElement>(fieldId);
	if (![...select.options].some((option) => option.value === value)) return false;
	select.value = value;
	return true;
}

function resizeComposer(): void {
	const minimumHeight = 44;
	const compact = window.matchMedia(
		"(max-width: 1024px), (max-width: 1366px) and (hover: none) and (pointer: coarse)",
	).matches;
	const maximumHeight = compact ? 112 : 180;
	input.style.height = "auto";
	const nextHeight = input.value.length === 0 ? minimumHeight : Math.max(minimumHeight, input.scrollHeight);
	input.style.height = `${Math.min(nextHeight, maximumHeight)}px`;
	input.style.overflowY = nextHeight > maximumHeight ? "auto" : "hidden";
}

function activePromptHistory(): PromptHistory | undefined {
	const key = builderActive
		? `builder:${activeSidebarAgent?.id ?? "new"}:${session?.id ?? ""}`
		: activeAgentId
			? `agent:${activeAgentId}`
			: activeExternalConnectionId
				? `external:${activeExternalConnectionId}`
				: session?.id;
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

function installRailSectionResizer(): void {
	const resizer = element("rail-section-resizer");
	const sessionsPanel = element("sessions");
	const activityPanel = element("agent-activity");
	const minimum = 96;
	const combinedHeight = () =>
		sessionsPanel.getBoundingClientRect().height + activityPanel.getBoundingClientRect().height;
	const setHeight = (value: number) => {
		const height = Math.max(minimum, Math.min(combinedHeight() - minimum, value));
		sessionsPanel.style.flexBasis = `${height}px`;
		resizer.setAttribute("aria-valuenow", String(Math.round(height)));
		return height;
	};
	const stored = Number(localStorage.getItem("pi-serve-sessions-height"));
	if (Number.isFinite(stored) && stored >= minimum) setHeight(stored);
	resizer.setAttribute("aria-valuemin", String(minimum));
	resizer.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const height = setHeight(sessionsPanel.getBoundingClientRect().height + (event.key === "ArrowDown" ? 12 : -12));
		localStorage.setItem("pi-serve-sessions-height", String(Math.round(height)));
	});
	resizer.addEventListener("pointerdown", (event) => {
		const pointer = event as PointerEvent;
		const startY = pointer.clientY;
		const current = sessionsPanel.getBoundingClientRect().height;
		resizer.classList.add("dragging");
		resizer.setPointerCapture(pointer.pointerId);
		const move = (moveEvent: PointerEvent) => setHeight(current + moveEvent.clientY - startY);
		const finish = () => {
			resizer.classList.remove("dragging");
			resizer.removeEventListener("pointermove", move);
			resizer.removeEventListener("pointerup", finish);
			resizer.removeEventListener("pointercancel", finish);
			localStorage.setItem(
				"pi-serve-sessions-height",
				String(Math.round(sessionsPanel.getBoundingClientRect().height)),
			);
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
	activeExternalRunId = undefined;
	activeExternalConnectionId = undefined;
	activeArtifactId = undefined;
	persistExternalRunTabs();
	persistExternalConnectionTabs();
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
	activeExternalRunId = undefined;
	activeExternalConnectionId = undefined;
	activeArtifactId = undefined;
	persistExternalRunTabs();
	persistExternalConnectionTabs();
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

function openExternalRun(run: ExternalRunSummary): void {
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activeExternalConnectionId = undefined;
	activeExternalRunId = run.id;
	activeArtifactId = undefined;
	if (!openExternalRunIds.includes(run.id)) openExternalRunIds.push(run.id);
	persistExternalRunTabs();
	persistExternalConnectionTabs();
	mobilePanelNone.checked = true;
	renderedExternalRunSignature = "";
	renderExternalRun(run);
	renderSessionNavigation();
}

function closeExternalRunTab(runId: string): void {
	const index = openExternalRunIds.indexOf(runId);
	if (index >= 0) openExternalRunIds.splice(index, 1);
	persistExternalRunTabs();
	if (activeExternalRunId !== runId) {
		renderSessionNavigation();
		return;
	}
	activeExternalRunId = undefined;
	persistExternalRunTabs();
	const fallbackId = openExternalRunIds.at(-1);
	const fallback = fallbackId ? externalRuns.find((entry) => entry.id === fallbackId) : undefined;
	if (fallback) {
		openExternalRun(fallback);
		return;
	}
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

function closeExternalConnectionTab(connectionId: string): void {
	const index = openExternalConnectionIds.indexOf(connectionId);
	if (index >= 0) openExternalConnectionIds.splice(index, 1);
	if (activeExternalConnectionId !== connectionId) {
		persistExternalConnectionTabs();
		renderSessionNavigation();
		return;
	}
	activeExternalConnectionId = undefined;
	persistExternalConnectionTabs();
	const fallbackId = openExternalConnectionIds.at(-1);
	const fallback = fallbackId ? externalConnections.find((entry) => entry.id === fallbackId) : undefined;
	if (fallback) {
		openExternalConnection(fallback);
		return;
	}
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

function persistExternalConnectionTabs(): void {
	localStorage.setItem("pi-serve-external-connection-tabs", JSON.stringify(openExternalConnectionIds));
	if (activeExternalConnectionId)
		localStorage.setItem("pi-serve-active-external-connection", activeExternalConnectionId);
	else localStorage.removeItem("pi-serve-active-external-connection");
}

function persistExternalRunTabs(): void {
	localStorage.setItem("pi-serve-external-run-tabs-v2", JSON.stringify(openExternalRunIds));
	if (activeExternalRunId) localStorage.setItem("pi-serve-active-external-run-v2", activeExternalRunId);
	else localStorage.removeItem("pi-serve-active-external-run-v2");
}

function readStoredStringArray(key: string): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
	} catch {
		return [];
	}
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

async function openArtifact(artifactId: string): Promise<void> {
	if (!capabilityToken) return;
	let artifact = artifacts.find((entry) => entry.id === artifactId);
	if (!artifact) {
		const response = await fetch(
			`/artifacts/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(capabilityToken)}`,
		);
		if (!response.ok) throw new Error(await responseError(response, "Could not open artifact"));
		const payload: unknown = await response.json();
		if (!isArtifactSummary(payload)) throw new Error("Artifact service returned an invalid record");
		artifact = payload;
		artifacts = [artifact, ...artifacts.filter((entry) => entry.id !== artifactId)];
	}
	if (!openArtifactIds.includes(artifactId)) openArtifactIds.push(artifactId);
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activeExternalRunId = undefined;
	activeExternalConnectionId = undefined;
	activeArtifactId = artifactId;
	mobilePanelNone.checked = true;
	await renderArtifact(artifact);
	renderSessionNavigation();
}

async function openArtifactLibrary(): Promise<void> {
	if (!capabilityToken) return;
	if (artifacts.length === 0) await loadAgentActivity();
	builderActive = false;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activeExternalRunId = undefined;
	activeExternalConnectionId = undefined;
	activeArtifactId = artifactLibraryId;
	mobilePanelNone.checked = true;
	renderArtifactLibrary();
	renderSessionNavigation();
}

function renderArtifactLibrary(): void {
	if (activeArtifactId !== artifactLibraryId) return;
	const heading = document.createElement("header");
	heading.className = "artifact-header";
	const identity = document.createElement("div");
	const title = document.createElement("strong");
	title.textContent = "Artifacts";
	const meta = document.createElement("span");
	meta.textContent = `${artifacts.filter((artifact) => artifact.archivedAt === undefined).length} available`;
	identity.append(title, meta);
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.title = "Close artifact library";
	close.setAttribute("aria-label", close.title);
	close.addEventListener("click", closeArtifactLibrary);
	const actions = document.createElement("nav");
	actions.className = "artifact-actions";
	actions.append(close);
	heading.append(identity, actions);

	const controls = document.createElement("div");
	controls.className = "artifact-library-controls";
	const search = document.createElement("input");
	search.type = "search";
	search.placeholder = "Search artifacts";
	search.setAttribute("aria-label", "Search artifacts");
	const kind = document.createElement("select");
	kind.setAttribute("aria-label", "Filter artifacts by type");
	for (const value of ["all", ...new Set(artifacts.map((artifact) => artifact.kind))]) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = value === "all" ? "All types" : value.replaceAll("_", " ");
		kind.append(option);
	}
	controls.append(search, kind);
	const results = document.createElement("section");
	results.className = "artifact-library-results";
	const renderResults = () => {
		const query = search.value.trim().toLowerCase();
		const visible = artifacts
			.filter((artifact) => artifact.archivedAt === undefined)
			.filter((artifact) => kind.value === "all" || artifact.kind === kind.value)
			.filter((artifact) => !query || artifact.title.toLowerCase().includes(query))
			.sort((left, right) => right.updatedAt - left.updatedAt);
		if (visible.length === 0) {
			const empty = document.createElement("p");
			empty.className = "settings-empty";
			empty.textContent = "No matching artifacts";
			results.replaceChildren(empty);
			return;
		}
		results.replaceChildren(
			...visible.map((artifact) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "artifact-library-card";
				const name = document.createElement("strong");
				name.textContent = artifact.title;
				const details = document.createElement("span");
				details.textContent = `${artifact.kind.replaceAll("_", " ")} · ${activityAge(artifact.updatedAt)}`;
				button.append(name, details);
				button.addEventListener("click", () => void openArtifact(artifact.id));
				return button;
			}),
		);
	};
	search.addEventListener("input", renderResults);
	kind.addEventListener("change", renderResults);
	renderResults();
	const content = document.createElement("section");
	content.className = "artifact-library";
	content.append(controls, results);
	transcript.replaceChildren(heading, content);
	transcript.scrollTop = 0;
	phase.textContent = "artifacts";
	input.disabled = true;
	input.placeholder = "Artifact library";
	send.disabled = true;
	model.disabled = true;
	modelPicker.refresh();
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	setSessionPath(session?.snapshot?.cwd ?? "Artifacts", false);
	sessionStats.textContent = "Recent results";
	sessionStats.title = "Managed artifacts";
	setStatus("Artifacts");
}

function closeArtifactLibrary(): void {
	if (activeArtifactId !== artifactLibraryId) return;
	activeArtifactId = undefined;
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

async function renderArtifact(artifact: ArtifactSummary, versionId = artifact.currentVersionId): Promise<void> {
	if (!capabilityToken || activeArtifactId !== artifact.id) return;
	if (activeArtifactObjectUrl) {
		URL.revokeObjectURL(activeArtifactObjectUrl);
		activeArtifactObjectUrl = undefined;
	}
	const header = document.createElement("header");
	header.className = "artifact-header";
	const identity = document.createElement("div");
	const title = document.createElement("strong");
	title.textContent = artifact.title;
	const meta = document.createElement("span");
	meta.textContent = `${artifact.kind.replaceAll("_", " ")} · updated ${activityAge(artifact.updatedAt)}`;
	identity.append(title, meta);
	const actions = document.createElement("nav");
	actions.className = "artifact-actions";
	const version = document.createElement("select");
	version.title = "Artifact version";
	version.setAttribute("aria-label", "Artifact version");
	for (const [index, id] of artifact.versionIds.entries()) {
		const option = document.createElement("option");
		option.value = id;
		option.textContent = `v${index + 1}`;
		version.append(option);
	}
	version.value = versionId;
	version.addEventListener("change", () => void renderArtifact(artifact, version.value));
	actions.append(version);
	const originTask = [...agentTasksByAgent.values()].flat().find((task) => task.id === artifact.taskId);
	const originAgent = artifact.agentId ? agents.find((entry) => entry.id === artifact.agentId) : undefined;
	if (originAgent) {
		const origin = document.createElement("button");
		origin.type = "button";
		origin.textContent = "↖";
		origin.title = `Back to ${originAgent.name}`;
		origin.setAttribute("aria-label", origin.title);
		origin.addEventListener("click", () => void openAgent(originAgent));
		actions.append(origin);
	}
	const refresh = document.createElement("button");
	refresh.type = "button";
	refresh.textContent = "↻";
	refresh.title = "Refresh through the originating agent";
	refresh.setAttribute("aria-label", refresh.title);
	refresh.addEventListener("click", () => {
		void refreshArtifact(artifact.id).catch((error: unknown) =>
			setStatus(error instanceof Error ? error.message : String(error), true),
		);
	});
	actions.append(refresh);
	if (versionId !== artifact.currentVersionId) {
		const restore = document.createElement("button");
		restore.type = "button";
		restore.textContent = "↶";
		restore.title = "Restore this version as a new version";
		restore.setAttribute("aria-label", restore.title);
		restore.addEventListener("click", () => {
			void restoreArtifactVersion(artifact.id, versionId).catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
		});
		actions.append(restore);
	}
	const download = document.createElement("a");
	download.textContent = "↓";
	download.title = "Download";
	download.setAttribute("aria-label", "Download artifact");
	download.href = `/artifacts/${encodeURIComponent(artifact.id)}/content?version=${encodeURIComponent(versionId)}&token=${encodeURIComponent(capabilityToken)}`;
	actions.append(download);
	header.append(identity, actions);
	const content = document.createElement("section");
	content.className = "artifact-content";
	const previewUrl = `/artifacts/${encodeURIComponent(artifact.id)}/preview?version=${encodeURIComponent(versionId)}&token=${encodeURIComponent(capabilityToken)}`;
	if (artifact.kind === "image") {
		const image = document.createElement("img");
		image.src = previewUrl;
		image.alt = artifact.title;
		content.append(image);
	} else if (artifact.kind === "html" || artifact.kind === "pdf") {
		const response = await fetch(previewUrl);
		if (!response.ok) throw new Error(await responseError(response, "Could not preview artifact"));
		const objectUrl = URL.createObjectURL(await response.blob());
		if (activeArtifactId !== artifact.id) {
			URL.revokeObjectURL(objectUrl);
			return;
		}
		activeArtifactObjectUrl = objectUrl;
		const frame = document.createElement("iframe");
		frame.src = objectUrl;
		frame.title = artifact.title;
		frame.setAttribute("sandbox", "");
		content.append(frame);
	} else if (artifact.kind === "text" || artifact.kind === "markdown" || artifact.kind === "dataset") {
		const response = await fetch(previewUrl);
		if (!response.ok) throw new Error(await responseError(response, "Could not preview artifact"));
		const body = document.createElement("div");
		body.className = "agent-message-content artifact-text";
		appendAgentMarkdown(body, await response.text());
		content.append(body);
	} else {
		const unavailable = document.createElement("div");
		unavailable.className = "artifact-text";
		unavailable.textContent = "Preview is not available for this format. Download the artifact to open it locally.";
		content.append(unavailable);
	}
	if (activeArtifactId !== artifact.id) return;
	transcript.replaceChildren(header, content);
	transcript.scrollTop = 0;
	phase.textContent = "artifact";
	input.disabled = true;
	input.placeholder = "Artifact preview";
	send.disabled = true;
	model.disabled = true;
	modelPicker.refresh();
	thinking.disabled = true;
	attachmentButton.disabled = true;
	attachmentInput.disabled = true;
	setSessionPath(originAgent?.projectRoot ?? session?.snapshot?.cwd ?? "Artifact", false);
	sessionStats.textContent = `${artifact.versionIds.length} version${artifact.versionIds.length === 1 ? "" : "s"}`;
	sessionStats.title = `Created by task ${originTask?.id ?? artifact.taskId}`;
	setStatus(artifact.title);
}

async function refreshArtifact(artifactId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/artifacts/${encodeURIComponent(artifactId)}/refresh?token=${encodeURIComponent(capabilityToken)}`,
		{ method: "POST" },
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not refresh artifact"));
	setStatus("Artifact refresh started");
	await loadAgentActivity();
}

async function restoreArtifactVersion(artifactId: string, versionId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/artifacts/${encodeURIComponent(artifactId)}/restore?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ versionId }),
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not restore artifact version"));
	await loadAgentActivity();
	const artifact = artifacts.find((entry) => entry.id === artifactId);
	if (artifact) await renderArtifact(artifact);
	setStatus("Artifact version restored");
}

function closeArtifactTab(artifactId: string): void {
	const index = openArtifactIds.indexOf(artifactId);
	if (index >= 0) openArtifactIds.splice(index, 1);
	if (activeArtifactId !== artifactId) {
		renderSessionNavigation();
		return;
	}
	activeArtifactId = undefined;
	if (activeArtifactObjectUrl) {
		URL.revokeObjectURL(activeArtifactObjectUrl);
		activeArtifactObjectUrl = undefined;
	}
	const fallbackId = openArtifactIds.at(-1);
	if (fallbackId) {
		void openArtifact(fallbackId);
		return;
	}
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
}

async function openAgentBuilder(
	agent?: AgentSummary,
	showConversation = true,
	improvement?: AgentImprovementContext,
): Promise<void> {
	activeSidebarAgent = agent;
	activeAgentImprovement = improvement;
	teamFactoryAvailable = false;
	pendingTeamPackage = undefined;
	teamLaunchBusy = false;
	agentBuilderFeedback = "";
	activeAgentBuild = undefined;
	draftedAgentCriteria = undefined;
	if (agentBuildDraftTimer !== undefined) window.clearTimeout(agentBuildDraftTimer);
	if (agentBuildPollTimer !== undefined) window.clearTimeout(agentBuildPollTimer);
	agentBuildDraftTimer = undefined;
	agentBuildPollTimer = undefined;
	agentForm.reset();
	const catalogAgent = agent?.source === "pi-agent";
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
	updateThinkingLevelAvailability(
		requiredElement<HTMLSelectElement>("agent-thinking"),
		agentModel.value || (session?.snapshot ? `${session.snapshot.model.provider}/${session.snapshot.model.id}` : ""),
		agent?.thinking ?? "high",
	);
	updatePersonaPreview();
	agentBuilderBaseline = agentBuilderDraftSignature();
	updateAgentBuilderReadiness();
	element("builder-title").textContent = agent
		? catalogAgent
			? `${agent.name} · catalog source`
			: agent.name
		: "Build a new agent";
	builderLabel = agent ? `Edit ${agent.name}` : "Agent Builder";
	agentSubmit.textContent = agent ? "Save candidate revision" : "Publish agent";
	agentCancel.textContent = agent ? "Cancel editing" : "Cancel agent";
	activateTab(showConversation ? "agents-workspace" : "agent-builder");
	activateBuilderTab("builder-profile-panel");
	builderActive = true;
	activeAgentId = undefined;
	activeSubagentKey = undefined;
	activeExternalRunId = undefined;
	activeExternalConnectionId = undefined;
	activeArtifactId = undefined;
	persistExternalRunTabs();
	persistExternalConnectionTabs();
	lastAppliedBuilderDraft = latestAgentBuilderDraftFromSnapshot(session?.snapshot);
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
	if (showConversation) mobilePanelNone.checked = true;
	renderSessionNavigation();
	refreshRoutineEditorOptions();
	clearRoutineEditor();
	let loadedBuild: AgentBuildRecord | undefined;
	try {
		[, , , loadedBuild] = await Promise.all([
			loadCapabilities(),
			loadRoutines(),
			loadTeamFactoryStatus(),
			agent ? loadAgentBuildForAgent(agent.id) : Promise.resolve(undefined),
		]);
	} catch (error) {
		setStatus(error instanceof Error ? error.message : String(error), true);
	}
	if (loadedBuild?.stage === "draft" && loadedBuild.configuration) {
		applyAgentBuildConfiguration(loadedBuild.configuration);
		updateAgentBuilderReadiness();
		setStatus(`Loaded staged changes for ${loadedBuild.name}`);
	}
	if (session?.snapshot) renderBuilderConversation(session.snapshot);
}

function closeBuilderChat(): void {
	builderActive = false;
	activeAgentImprovement = undefined;
	activeAgentBuild = undefined;
	draftedAgentCriteria = undefined;
	if (agentBuildDraftTimer !== undefined) window.clearTimeout(agentBuildDraftTimer);
	if (agentBuildPollTimer !== undefined) window.clearTimeout(agentBuildPollTimer);
	agentBuildDraftTimer = undefined;
	agentBuildPollTimer = undefined;
	pendingTeamPackage = undefined;
	teamLaunchBusy = false;
	activeSidebarAgent = undefined;
	activateTab("agents-workspace");
	mobilePanelNone.checked = true;
	if (session?.snapshot) render(session.snapshot);
	renderSessionNavigation();
	renderAttachments();
	setStatus("Ready");
}

function loadSelectedAgent(): Promise<void> {
	if (!capabilityToken || !activeSidebarAgent) return Promise.resolve();
	const agent = activeSidebarAgent;
	const token = capabilityToken;
	const active = selectedAgentLoadPromises.get(agent.id);
	if (active) return active;
	const load = loadSelectedAgentNow(agent, token).finally(() => {
		selectedAgentLoadPromises.delete(agent.id);
	});
	selectedAgentLoadPromises.set(agent.id, load);
	return load;
}

async function loadSelectedAgentNow(agent: AgentSummary, token: string): Promise<void> {
	const [conversationsResponse, teamResponse] = await Promise.all([
		fetch(`/agent-conversations.json?agentId=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(token)}`),
		fetch(`/agent-teams?coordinatorAgentId=${encodeURIComponent(agent.id)}&token=${encodeURIComponent(token)}`),
	]);
	if (!conversationsResponse.ok)
		throw new Error(await responseError(conversationsResponse, "Could not load agent conversation"));
	if (!teamResponse.ok) throw new Error(await responseError(teamResponse, "Could not load agent team state"));
	const teamPayload: unknown = await teamResponse.json();
	if (!isAgentTeamState(teamPayload)) throw new Error("Agent team service returned an invalid response");
	agentTeamStates.set(agent.id, teamPayload);
	const conversationsPayload: unknown = await conversationsResponse.json();
	const conversationId = conversationIdFromPayload(conversationsPayload);
	let messages: AgentMessageSummary[] = [];
	if (conversationId && !teamPayload.installed) {
		const messagesResponse = await fetch(
			`/agent-conversations/${encodeURIComponent(conversationId)}/messages?token=${encodeURIComponent(token)}`,
		);
		if (!messagesResponse.ok) throw new Error(await responseError(messagesResponse, "Could not load agent messages"));
		const payload: unknown = await messagesResponse.json();
		messages = messagesFromPayload(payload);
	}
	if (conversationId && !teamPayload.installed) agentConversationIds.set(agent.id, conversationId);
	else agentConversationIds.delete(agent.id);
	const tasks = await loadAgentTasks(agent);
	if (activeAgentId === agent.id) renderAgentConversation(agent, messages, tasks, teamPayload);
}

function renderAgentConversation(
	agent: AgentSummary,
	messages: AgentMessageSummary[],
	tasks: AgentTaskSummary[],
	teamState: AgentTeamState,
): void {
	const activeTask = tasks.find((task) =>
		["queued", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(task.status),
	);
	const activeTeamRun = teamState.team?.runs.find((run) => run.status === "running");
	const items = [
		...(teamState.team?.runs ?? []).flatMap((run, index) => renderAgentTeamRun(run, index > 0)),
		...messages.map((message) =>
			renderAgentMessage(
				agent,
				message,
				tasks.find((task) => task.id === message.taskId),
			),
		),
	];
	if (activeTask && !teamState.installed) {
		const running = document.createElement("article");
		running.className = "message assistant agent-running";
		const dot = document.createElement("i");
		const label = document.createElement("span");
		label.textContent = `${agent.name} · ${agentTaskPhase(activeTask)}`;
		running.append(dot, label);
		if (activeTask.progressMessage) {
			const detail = document.createElement("small");
			detail.textContent = activeTask.progressMessage;
			running.append(detail);
		}
		items.push(running);
	}
	transcript.replaceChildren(...items);
	transcript.scrollTop = transcript.scrollHeight;
	phase.textContent = activeTeamRun ? "team running" : activeTask ? agentTaskPhase(activeTask) : "idle";
	send.classList.toggle("is-stopping", Boolean(activeTask || activeTeamRun));
	send.setAttribute("aria-label", activeTask || activeTeamRun ? `Stop ${agent.name}` : `Message ${agent.name}`);
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
	updateThinkingLevelAvailability(thinking, model.value, thinking.value as ThinkingLevel);
	setSessionPath(agent.projectRoot, agent.source === "managed" && activeTask === undefined && !activeTeamRun);
	sessionStats.textContent = activeTeamRun
		? `${teamState.team?.workflow.name ?? agent.name} · team running`
		: activeTask
			? `${agent.name} · ${agentTaskPhase(activeTask)}${activeTask.lastActivityAt ? ` · ${activityAge(activeTask.lastActivityAt)}` : ""}`
			: agent.name;
	sessionStats.title = teamState.installed ? "Active team conversation" : "Active agent conversation";
	setStatus(
		activeTeamRun
			? `${teamState.team?.workflow.name ?? agent.name} is running`
			: activeTask
				? `${agent.name} is running a task`
				: agent.projectRoot,
	);
}

function renderAgentTeamRun(run: AgentTeamRun, historical: boolean): HTMLElement[] {
	if (historical) {
		const article = document.createElement("article");
		article.className = "message assistant agent-team-history";
		const disclosure = document.createElement("details");
		const summary = document.createElement("summary");
		const date = new Date(run.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
		summary.textContent = `${run.status} · ${date} · ${run.prompt.slice(0, 80)}${run.prompt.length > 80 ? "…" : ""}`;
		const body = document.createElement("div");
		body.className = "agent-message-content";
		appendText(body, run.prompt, "muted");
		if (run.result) appendAgentMarkdown(body, run.result);
		else appendText(body, run.error ?? "The team run did not produce a result.", "run-error");
		disclosure.append(summary, body);
		article.append(disclosure);
		return [article];
	}
	const request = document.createElement("article");
	request.className = "message user";
	appendText(request, "you", "message-label");
	const requestBody = document.createElement("div");
	requestBody.className = "agent-message-content";
	appendAgentMarkdown(requestBody, run.prompt);
	request.append(requestBody);

	const response = document.createElement("article");
	response.className = "message assistant agent-team-run";
	appendText(response, run.status === "running" ? "team · running" : `team · ${run.status}`, "message-label");
	const body = document.createElement("div");
	body.className = "agent-message-content";
	if (run.status === "running") {
		for (const node of run.nodes) {
			const line = document.createElement("p");
			line.className = `agent-team-node agent-team-node-${node.status}`;
			line.textContent = `${node.label} · ${node.progress ?? node.status}`;
			body.append(line);
		}
	} else if (run.result) appendAgentMarkdown(body, run.result);
	else appendText(body, run.error ?? "The team run did not produce a result.", "run-error");
	response.append(body);
	return [request, response];
}

function agentTaskPhase(task: AgentTaskSummary): string {
	return (task.phase ?? task.status).replaceAll("-", " ");
}

function activityAge(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	return seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
}

function renderAgentMessage(
	agent: AgentSummary,
	message: AgentMessageSummary,
	task: AgentTaskSummary | undefined,
): HTMLElement {
	const article = document.createElement("article");
	article.className = `message ${message.role === "agent" ? "assistant" : "user"}`;
	const label = document.createElement("div");
	label.className = "message-label";
	label.textContent = message.role === "agent" ? agent.name : "you";
	const body = document.createElement("div");
	body.className = "agent-message-content";
	if (message.role === "agent") {
		for (const [index, segment] of splitInlineThinking(message.text).entries()) {
			if (segment.type === "thinking")
				body.append(renderThinkingDisclosure(`${message.id}:${index}`, segment.text, false));
			else appendAgentMarkdown(body, segment.text);
		}
	} else appendAgentMarkdown(body, message.text);
	article.append(label, body);
	if (message.role === "agent" && task?.artifactIds.length) {
		const outputs = document.createElement("div");
		outputs.className = "message-artifacts";
		for (const artifactId of task.artifactIds) {
			const artifact = artifacts.find((entry) => entry.id === artifactId);
			const open = document.createElement("button");
			open.type = "button";
			open.textContent = artifact?.title ?? "Open result";
			open.addEventListener("click", () => void openArtifact(artifactId));
			outputs.append(open);
		}
		article.append(outputs);
	}
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
	return payload.tasks;
}

async function loadAgentActivity(): Promise<void> {
	if (!capabilityToken) return;
	const [taskResponse, attentionResponse, artifactResponse] = await Promise.all([
		fetch(`/agent-tasks.json?token=${encodeURIComponent(capabilityToken)}`),
		fetch(`/attention.json?status=open&token=${encodeURIComponent(capabilityToken)}`),
		fetch(`/artifacts.json?token=${encodeURIComponent(capabilityToken)}`),
	]);
	if (!taskResponse.ok) throw new Error(`Could not load agent activity: HTTP ${taskResponse.status}`);
	if (!attentionResponse.ok) throw new Error(`Could not load Attention: HTTP ${attentionResponse.status}`);
	if (!artifactResponse.ok) throw new Error(`Could not load artifacts: HTTP ${artifactResponse.status}`);
	const payload: unknown = await taskResponse.json();
	if (!isAgentTaskList(payload)) throw new Error("Agent task service returned an invalid response");
	const attentionPayload: unknown = await attentionResponse.json();
	const artifactPayload: unknown = await artifactResponse.json();
	attentionItems = attentionFromPayload(attentionPayload);
	artifacts = artifactsFromPayload(artifactPayload);
	for (const agent of agents) {
		agentTasksByAgent.set(
			agent.id,
			payload.tasks.filter((task) => task.agentId === agent.id),
		);
	}
	renderAgentActivity(payload.tasks, attentionItems);
	if (activeArtifactId === artifactLibraryId) {
		renderArtifactLibrary();
	} else if (activeArtifactId) {
		const artifact = artifacts.find((entry) => entry.id === activeArtifactId);
		if (artifact) await renderArtifact(artifact);
	}
}

function renderAgentActivity(tasks: AgentTaskSummary[], attention: AttentionSummary[]): void {
	const active = tasks
		.filter((task) =>
			["queued", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(task.status),
		)
		.sort((left, right) => right.createdAt - left.createdAt);
	const priority = { approval: 0, question: 1, failure: 2, completed: 3 } as const;
	const openAttention = attention
		.filter((item) => item.status === "open")
		.sort((left, right) => priority[left.kind] - priority[right.kind] || right.createdAt - left.createdAt);
	const workflowBuilds = agentBuilds
		.filter((build) => build.stage !== "automated")
		.sort((left, right) => right.updatedAt - left.updatedAt);
	const attentionCount = openAttention.length + workflowBuilds.length;
	attentionHeading.textContent = attentionCount > 0 ? `Workflow · ${attentionCount}` : "Workflow";
	const workflowTab = document.querySelector<HTMLButtonElement>('[data-tab="agents-workspace"]');
	if (workflowTab) workflowTab.textContent = attentionCount > 0 ? `Workflow · ${attentionCount}` : "Workflow";
	const workflowBadge = document.getElementById("workflow-badge");
	if (workflowBadge) {
		workflowBadge.textContent = String(attentionCount);
		workflowBadge.classList.toggle("hidden", attentionCount === 0);
	}
	openArtifactsButton.disabled = artifacts.length === 0;
	if (active.length === 0 && openAttention.length === 0 && workflowBuilds.length === 0) {
		const empty = document.createElement("p");
		empty.className = "agent-activity-empty";
		empty.textContent = "Nothing needs attention";
		agentActivityList.replaceChildren(empty);
		return;
	}
	agentActivityList.replaceChildren(
		...workflowBuilds.slice(0, 5).map(renderBuildWorkflowEntry),
		...active.slice(0, 5).map((task) => renderTaskActivityEntry(task)),
		...openAttention.slice(0, 5).map((item) => renderAttentionEntry(item, tasks)),
	);
}

function renderBuildWorkflowEntry(build: AgentBuildRecord): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "agent-activity-entry";
	button.dataset.status =
		build.stage === "needs-refinement" ? "failed" : build.stage === "testing" ? "running" : "waiting_for_input";
	button.title = `${build.name}: ${agentBuildStageLabel(build)}`;
	const indicator = document.createElement("i");
	indicator.className = "agent-activity-status";
	const copy = document.createElement("span");
	const name = document.createElement("strong");
	name.textContent = build.name;
	const next = document.createElement("small");
	next.textContent = buildWorkflowNextAction(build);
	copy.append(name, next);
	const state = document.createElement("time");
	state.dateTime = new Date(build.updatedAt).toISOString();
	state.textContent = agentBuildStageLabel(build);
	button.append(indicator, copy, state);
	button.addEventListener("click", () => {
		activeAgentBuild = build;
		const agent = agents.find((candidate) => candidate.id === build.agentId);
		void openAgentBuilder(agent).then(() => {
			if (
				build.stage === "proof-ready" ||
				(build.stage === "needs-refinement" && build.proof?.status === "succeeded")
			) {
				void openAgentBuildProofReview();
			}
		});
	});
	return button;
}

function buildWorkflowNextAction(build: AgentBuildRecord): string {
	if (build.stage === "draft") return build.agentId ? "Review candidate changes" : "Review and publish draft";
	if (build.stage === "ready-to-test") return "Run one proof";
	if (build.stage === "testing") return "Proof is running";
	if (build.stage === "proof-ready") return "Review evidence and decide";
	if (build.stage === "needs-refinement") return "Review failed criteria and improve";
	if (build.stage === "proven") return "Promote accepted revision";
	return "Review and enable schedule";
}

function renderTaskActivityEntry(task: AgentTaskSummary): HTMLButtonElement {
	const agent = agents.find((entry) => entry.id === task.agentId);
	const button = document.createElement("button");
	button.type = "button";
	button.className = "agent-activity-entry";
	button.dataset.status = task.status;
	button.disabled = !agent;
	button.title = task.prompt;
	const indicator = document.createElement("i");
	indicator.className = "agent-activity-status";
	const copy = document.createElement("span");
	const name = document.createElement("strong");
	name.textContent = agent?.name ?? task.agentId;
	const prompt = document.createElement("small");
	prompt.textContent = task.progressMessage ?? task.prompt;
	copy.append(name, prompt);
	const state = document.createElement("time");
	state.dateTime = new Date(task.createdAt).toISOString();
	state.textContent = agentTaskPhase(task);
	button.append(indicator, copy, state);
	if (agent) button.addEventListener("click", () => void openAgent(agent));
	return button;
}

function renderAttentionEntry(item: AttentionSummary, tasks: AgentTaskSummary[]): HTMLDivElement {
	const task = tasks.find((entry) => entry.id === item.taskId);
	const agent = task ? agents.find((entry) => entry.id === task.agentId) : undefined;
	const row = document.createElement("div");
	row.className = "attention-entry-wrap";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "agent-activity-entry attention-entry";
	button.dataset.status = item.kind === "failure" ? "failed" : item.kind;
	button.title = item.summary;
	const indicator = document.createElement("i");
	indicator.className = "agent-activity-status";
	const copy = document.createElement("span");
	const title = document.createElement("strong");
	title.textContent = item.title;
	const summary = document.createElement("small");
	summary.textContent = item.summary;
	copy.append(title, summary);
	const state = document.createElement("time");
	state.dateTime = new Date(item.createdAt).toISOString();
	state.textContent = item.kind;
	button.append(indicator, copy, state);
	button.addEventListener("click", () => {
		const artifactId = task?.artifactIds[0];
		if (artifactId) void openArtifact(artifactId);
		else if (agent) void openAgent(agent);
	});
	row.append(button);
	if (item.kind === "failure" && task) {
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "attention-inline-action";
		retry.textContent = "↻";
		retry.title = "Retry";
		retry.setAttribute("aria-label", `Retry ${item.title}`);
		retry.addEventListener("click", () => void retryAgentTask(task.id));
		row.append(retry);
	}
	if ((item.kind === "failure" || item.kind === "completed") && task && agent) {
		const improve = document.createElement("button");
		improve.type = "button";
		improve.className = "attention-inline-action";
		improve.textContent = "↑";
		improve.title = item.kind === "failure" ? "Repair agent from this run" : "Improve agent from this run";
		improve.setAttribute("aria-label", `${improve.title}: ${item.title}`);
		improve.addEventListener("click", () => openAgentImprovementReview(agent, task));
		row.append(improve);
	}
	if (item.kind === "failure" || item.kind === "completed") {
		const dismiss = document.createElement("button");
		dismiss.type = "button";
		dismiss.className = "attention-inline-action";
		dismiss.textContent = "×";
		dismiss.title = "Dismiss";
		dismiss.setAttribute("aria-label", `Dismiss ${item.title}`);
		dismiss.addEventListener("click", () => void dismissAttention(item.id));
		row.append(dismiss);
	}
	return row;
}

function improvementRoute(task: AgentTaskSummary | undefined): AgentImprovementContext["route"] {
	if (task?.status === "completed") return "refine";
	if (task && ["failed", "cancelled", "interrupted"].includes(task.status)) return "repair";
	return "diagnose";
}

function improvementRouteLabel(route: AgentImprovementContext["route"]): string {
	if (route === "repair") return "Repair";
	if (route === "refine") return "Refine";
	return "Assess";
}

function openAgentImprovementReview(agent: AgentSummary, task?: AgentTaskSummary): void {
	const route = improvementRoute(task);
	const dialog = document.createElement("dialog");
	dialog.className = "promotion-dialog";
	const form = document.createElement("form");
	form.method = "dialog";
	const heading = document.createElement("strong");
	heading.textContent = `${improvementRouteLabel(route)} ${agent.name}`;
	const explanation = document.createElement("p");
	explanation.className = "muted";
	explanation.textContent =
		route === "repair"
			? "Pi will use the failed run as evidence and preserve the current agent until you approve a repair."
			: route === "refine"
				? "Pi will compare a candidate against the successful baseline. A passing candidate is not applied automatically."
				: "Pi will assess the current agent before deciding whether it needs repair or refinement.";
	const objective = document.createElement("textarea");
	objective.required = true;
	objective.maxLength = 2_048;
	objective.value = task
		? `${route === "repair" ? "Fix" : "Improve"} the selected ${task.status} run: ${boundedTaskEvidence(task.prompt, 240)}`
		: `Improve ${agent.name} while preserving its existing successful behavior.`;
	const successCriteria = document.createElement("textarea");
	successCriteria.required = true;
	successCriteria.maxLength = 2_048;
	successCriteria.placeholder = "Describe the observable result that would prove the improvement worked.";
	const scope = document.createElement("select");
	for (const [value, label] of [
		["auto", "Let Pi choose agent or team"],
		["agent", "Keep this a single agent"],
		["team", "Evaluate an agent team"],
	] as const) {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		scope.append(option);
	}
	const field = (label: string, control: HTMLTextAreaElement | HTMLSelectElement): HTMLLabelElement => {
		const wrapper = document.createElement("label");
		wrapper.append(document.createTextNode(label), control);
		return wrapper;
	};
	const actions = document.createElement("div");
	actions.className = "promotion-actions";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary-action";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => dialog.close());
	const start = document.createElement("button");
	start.type = "submit";
	start.textContent = "Start improvement";
	actions.append(cancel, start);
	form.append(
		heading,
		explanation,
		field("Improvement goal", objective),
		field("Success criteria", successCriteria),
		field("Execution scope", scope),
		actions,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		const context: AgentImprovementContext = {
			route,
			scope: scope.value as AgentImprovementContext["scope"],
			objective: objective.value.trim(),
			successCriteria: successCriteria.value.trim(),
			baselineRevision: agent.revision,
			task: task
				? {
						id: task.id,
						status: task.status,
						prompt: task.prompt,
						attemptIds: task.attemptIds,
						result: task.result,
						error: task.error,
					}
				: undefined,
		};
		dialog.close();
		void openAgentBuilder(agent, true, context).then(() => {
			input.value = `Propose the smallest reviewed change that meets this improvement goal: ${context.objective}`;
			resizeComposer();
			input.focus();
			setStatus("Improvement brief ready. Review the request, then send it to Pi.");
		});
	});
	dialog.addEventListener("close", () => dialog.remove());
	dialog.append(form);
	document.body.append(dialog);
	dialog.showModal();
	objective.focus();
}

function openSkillPromotionReview(task: AgentTaskSummary, agent: AgentSummary): void {
	const runId = task.attemptIds.at(-1);
	if (!runId || !capabilityToken) {
		setStatus("The successful worker result is unavailable for promotion", true);
		return;
	}
	const dialog = document.createElement("dialog");
	dialog.className = "promotion-dialog";
	const form = document.createElement("form");
	form.method = "dialog";
	const heading = document.createElement("strong");
	heading.textContent = "Create a reusable skill";
	const explanation = document.createElement("p");
	explanation.className = "muted";
	explanation.textContent = `Review what ${agent.name} should repeat before saving it to Pi's local skill catalog.`;
	const name = document.createElement("input");
	name.required = true;
	name.pattern = "[a-z0-9]+(?:-[a-z0-9]+)*";
	name.maxLength = 64;
	name.value = skillNameFromTask(agent, task);
	const description = document.createElement("textarea");
	description.required = true;
	description.maxLength = 1_024;
	description.value = `Repeat the reviewed ${agent.name} workflow for similar requests.`;
	const instructions = document.createElement("textarea");
	instructions.required = true;
	instructions.maxLength = 65_536;
	instructions.value = [
		"Perform this task using the same reviewed approach:",
		"",
		boundedTaskEvidence(task.prompt, 2_000),
		"",
		"Respect the active workspace and capability grants. Verify the result before reporting completion.",
	].join("\n");
	const result = document.createElement("details");
	const resultSummary = document.createElement("summary");
	resultSummary.textContent = "Successful result used as evidence";
	const resultBody = document.createElement("pre");
	resultBody.textContent = task.result ?? "The successful result is stored with the source run.";
	result.append(resultSummary, resultBody);
	const actions = document.createElement("div");
	actions.className = "promotion-actions";
	const field = (text: string, control: HTMLInputElement | HTMLTextAreaElement): HTMLLabelElement => {
		const wrapper = document.createElement("label");
		wrapper.append(document.createTextNode(text), control);
		return wrapper;
	};
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.className = "secondary-action";
	cancel.textContent = "Cancel";
	cancel.addEventListener("click", () => dialog.close());
	const create = document.createElement("button");
	create.type = "submit";
	create.textContent = "Create skill";
	actions.append(cancel, create);
	form.append(
		heading,
		explanation,
		field("Skill name", name),
		field("When Pi should use it", description),
		field("Reviewed instructions", instructions),
		result,
		actions,
	);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		create.disabled = true;
		void fetch(`/runs/${encodeURIComponent(runId)}/promote-skill?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: name.value, description: description.value, instructions: instructions.value }),
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(await responseError(response, "Could not create skill"));
				dialog.close();
				await Promise.all([loadCapabilities(), loadRoutines(), refreshActiveAgentBuild()]);
				setStatus(`Skill ${name.value.trim()} created from the reviewed run`);
			})
			.catch((error: unknown) => {
				create.disabled = false;
				setStatus(error instanceof Error ? error.message : String(error), true);
			});
	});
	dialog.addEventListener("close", () => dialog.remove());
	dialog.append(form);
	document.body.append(dialog);
	dialog.showModal();
	name.focus();
	name.select();
}

function boundedTaskEvidence(value: string, maximumLength: number): string {
	const withoutHandoff = value.split(/\s+Predecessor\s+[^:]+\s+result:/i, 1)[0] ?? value;
	const compact = withoutHandoff.replace(/\s+/g, " ").trim();
	return compact.length > maximumLength ? `${compact.slice(0, maximumLength - 1)}…` : compact;
}

function skillNameFromTask(agent: AgentSummary, task: AgentTaskSummary): string {
	const promptFragment = task.prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 36)
		.replace(/-$/, "");
	const agentFragment = agent.id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 24)
		.replace(/-$/, "");
	return `${agentFragment || "agent"}-${promptFragment || "successful-run"}`.slice(0, 64).replace(/-$/, "");
}

async function stageRoutineFromTask(task: AgentTaskSummary, agent: AgentSummary): Promise<void> {
	await openAgentBuilder(agent, false);
	activateBuilderTab("builder-automation-panel");
	clearRoutineEditor();
	routineEditor.name.value = `${agent.name} routine`;
	routineEditor.prompt.value = task.prompt;
	routineEditor.targetKind.value = "agent";
	routineEditor.agent.value = agent.id;
	updateRoutineTargetFields();
	if (agent.model) {
		routineEditor.model.value = `${agent.model.provider}/${agent.model.id}`;
		routineModelPicker.refresh();
	}
	setStatus("Review the schedule, then save it. It remains editable and can be run immediately.");
}

function attentionFromPayload(value: unknown): AttentionSummary[] {
	if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) return [];
	return value.items.filter(isAttentionSummary);
}

function isAttentionSummary(value: unknown): value is AttentionSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"taskId" in value &&
		typeof value.taskId === "string" &&
		"kind" in value &&
		["approval", "question", "failure", "completed"].includes(String(value.kind)) &&
		"status" in value &&
		["open", "resolved", "dismissed"].includes(String(value.status)) &&
		"title" in value &&
		typeof value.title === "string" &&
		"summary" in value &&
		typeof value.summary === "string" &&
		"createdAt" in value &&
		typeof value.createdAt === "number"
	);
}

function artifactsFromPayload(value: unknown): ArtifactSummary[] {
	if (typeof value !== "object" || value === null || !("artifacts" in value) || !Array.isArray(value.artifacts)) {
		return [];
	}
	return value.artifacts.filter(isArtifactSummary);
}

function isArtifactSummary(value: unknown): value is ArtifactSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"title" in value &&
		typeof value.title === "string" &&
		"kind" in value &&
		typeof value.kind === "string" &&
		"taskId" in value &&
		typeof value.taskId === "string" &&
		"currentVersionId" in value &&
		typeof value.currentVersionId === "string" &&
		"versionIds" in value &&
		Array.isArray(value.versionIds) &&
		value.versionIds.every((entry) => typeof entry === "string") &&
		"createdAt" in value &&
		typeof value.createdAt === "number" &&
		"updatedAt" in value &&
		typeof value.updatedAt === "number" &&
		(!("archivedAt" in value) || value.archivedAt === undefined || typeof value.archivedAt === "number")
	);
}

async function dismissAttention(id: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/attention/${encodeURIComponent(id)}/dismiss?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not dismiss Attention item"));
	await loadAgentActivity();
}

async function retryAgentTask(taskId: string): Promise<void> {
	if (!capabilityToken) return;
	const response = await fetch(
		`/agent-tasks/${encodeURIComponent(taskId)}/retry?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: "POST",
		},
	);
	if (!response.ok) throw new Error(await responseError(response, "Could not retry task"));
	await loadAgentActivity();
	if (activeSidebarAgent) await loadSelectedAgent();
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
			[
				"queued",
				"running",
				"waiting_for_approval",
				"waiting_for_input",
				"stopping",
				"completed",
				"failed",
				"cancelled",
				"interrupted",
			].includes(String(entry.status)) &&
			"createdAt" in entry &&
			typeof entry.createdAt === "number" &&
			"attemptIds" in entry &&
			Array.isArray(entry.attemptIds) &&
			entry.attemptIds.every((attemptId: unknown) => typeof attemptId === "string") &&
			"artifactIds" in entry &&
			Array.isArray(entry.artifactIds) &&
			entry.artifactIds.every((artifactId: unknown) => typeof artifactId === "string") &&
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

async function loadExternalRuns(): Promise<void> {
	if (!capabilityToken) return;
	const previousTabSignature = externalTabSignature();
	const response = await fetch(`/external-runs.json?token=${encodeURIComponent(capabilityToken)}`);
	if (!response.ok) throw new Error(`Could not load external runs: HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isExternalRunList(payload)) throw new Error("External run manager returned an invalid response");
	externalRuns = payload.runs;
	for (let index = openExternalRunIds.length - 1; index >= 0; index--) {
		if (!externalRuns.some((run) => run.id === openExternalRunIds[index])) openExternalRunIds.splice(index, 1);
	}
	if (activeExternalRunId && !openExternalRunIds.includes(activeExternalRunId)) activeExternalRunId = undefined;
	persistExternalRunTabs();
	const runs = selectedExternalConnectionId
		? externalRuns.filter((run) => run.connectionId === selectedExternalConnectionId)
		: [];
	const listSignature = JSON.stringify(
		runs.map((run) => [run.id, run.status, run.error, run.prompt, run.model.provider, run.model.id]),
	);
	if (listSignature !== renderedExternalRunListSignature) {
		renderedExternalRunListSignature = listSignature;
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
					const inspect = document.createElement("button");
					inspect.type = "button";
					inspect.textContent = "Inspect run";
					inspect.addEventListener("click", () => openExternalRun(run));
					actions.append(open, inspect, use);
				}
				if (run.status === "failed" || run.status === "aborted") {
					const retry = document.createElement("button");
					retry.type = "button";
					retry.textContent = "Retry";
					retry.addEventListener("click", () => void retryExternalRun(run));
					const inspect = document.createElement("button");
					inspect.type = "button";
					inspect.textContent = "Inspect run";
					inspect.addEventListener("click", () => openExternalRun(run));
					actions.append(inspect, retry);
				}
				if (actions.childElementCount > 0) card.append(actions);
				return card;
			}),
		);
	}
	const activeRun = activeExternalRunId ? externalRuns.find((entry) => entry.id === activeExternalRunId) : undefined;
	if (activeRun) renderExternalRun(activeRun);
	const activeConnection = activeExternalConnectionId
		? externalConnections.find((entry) => entry.id === activeExternalConnectionId)
		: undefined;
	if (activeConnection) renderExternalConversation(activeConnection);
	if (previousTabSignature !== externalTabSignature()) renderSessionNavigation();
}

function externalTabSignature(): string {
	return openExternalRunIds
		.map((id) => {
			const run = externalRuns.find((entry) => entry.id === id);
			return `${id}:${run?.status ?? "missing"}`;
		})
		.join("|");
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

async function retryExternalRun(run: ExternalRunSummary): Promise<void> {
	await startExternalRun(run.connectionId, run.prompt, run.cwd, run.model);
}

async function startExternalRun(
	connectionId: string,
	prompt: string,
	cwd: string,
	selectedModel: { provider: string; id: string },
): Promise<void> {
	if (!capabilityToken) throw new Error("The capability token is missing");
	const response = await fetch(`/external-runs?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ connectionId, prompt, cwd, model: selectedModel }),
	});
	if (!response.ok) throw new Error(await responseError(response, "Could not start delegated run"));
	const value: unknown = await response.json();
	if (!isExternalRunSummary(value)) throw new Error("External run manager returned an invalid run");
	externalRuns = [value, ...externalRuns.filter((entry) => entry.id !== value.id)];
	const connection = externalConnections.find((entry) => entry.id === connectionId);
	if (connection) openExternalConnection(connection);
	await loadExternalRuns();
	setStatus(`Delegated to ${connectionId}`);
}

function isExternalRunSummary(value: unknown): value is ExternalRunSummary {
	return isExternalRunList({ runs: [value] });
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
	if (activeSidebarAgent) routineEditor.agent.value = activeSidebarAgent.id;
	refreshRoutineModels();
}

function applyRoutineAgentScope(): void {
	const agent = activeSidebarAgent;
	routineEditor.targetKind.value = "agent";
	routineEditor.targetKind.disabled = true;
	routineEditor.agent.disabled = true;
	routineEditor.saveButton.disabled = !agent;
	routineEditor.scope.textContent = agent
		? `Schedules run ${agent.name} in its configured project folder.`
		: "Save and deploy this agent before adding a schedule.";
	if (agent) routineEditor.agent.value = agent.id;
	updateRoutineTargetFields();
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
			option.textContent = modelOptionLabel(entry);
			applyModelCostPresentation(option, entry);
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
	routineEditor.enabled.checked = true;
	routineEditor.deleteButton.disabled = true;
	routineEditor.runButton.disabled = true;
	element("routine-editor-title").textContent = "New schedule";
	routineList.querySelectorAll(".routine-card").forEach((card) => {
		card.classList.remove("active");
	});
	applyRoutineAgentScope();
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
	const agent = activeSidebarAgent;
	const agentRoutines = agent
		? payload.routines.filter((routine) => routine.target.kind === "agent" && routine.target.agentId === agent.id)
		: [];
	if (!agent) {
		const empty = document.createElement("div");
		empty.className = "settings-empty";
		empty.textContent = "Save and deploy this agent before adding schedules.";
		routineList.replaceChildren(empty);
		return;
	}
	if (agentRoutines.length === 0) {
		const empty = document.createElement("div");
		empty.className = "settings-empty";
		empty.textContent = `No schedules for ${agent.name}. Add one above when this agent should run automatically.`;
		routineList.replaceChildren(empty);
		return;
	}
	routineList.replaceChildren(
		...agentRoutines.map((routine) => {
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
			if (routine.lastRunAt) {
				appendText(card, `Last run ${new Date(routine.lastRunAt).toLocaleString()}`, "muted");
			}
			appendText(card, routine.prompt, "muted");
			if (routine.lastError) appendText(card, routine.lastError, "run-error");
			if (routine.availabilityError) appendText(card, routine.availabilityError, "run-error");
			card.addEventListener("click", () => editRoutine(routine));
			return card;
		}),
	);
	const selected = agentRoutines.find((routine) => routine.id === routineEditor.id.value);
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

interface AgentTeamState {
	schemaVersion: "pi.agents.team-state.v1";
	installed: boolean;
	team?: {
		bundleId: string;
		packageId: string;
		coordinatorAgentId: string;
		agentIds: string[];
		workflow: { id: string; name: string };
		runs: AgentTeamRun[];
	};
}

interface AgentTeamRun {
	id: string;
	status: "running" | "completed" | "failed" | "cancelled";
	prompt: string;
	createdAt: number;
	finishedAt?: number;
	result?: string;
	error?: string;
	nodes: Array<{
		id: string;
		label: string;
		status: "queued" | "running" | "completed" | "failed" | "blocked";
		progress?: string;
		result?: string;
		error?: string;
	}>;
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

function isAgentTeamState(value: unknown): value is AgentTeamState {
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== "pi.agents.team-state.v1" ||
		!("installed" in value) ||
		typeof value.installed !== "boolean"
	) {
		return false;
	}
	if (!value.installed) return true;
	if (!("team" in value) || typeof value.team !== "object" || value.team === null) return false;
	const team = value.team;
	return (
		"coordinatorAgentId" in team &&
		typeof team.coordinatorAgentId === "string" &&
		"workflow" in team &&
		typeof team.workflow === "object" &&
		team.workflow !== null &&
		"id" in team.workflow &&
		typeof team.workflow.id === "string" &&
		"runs" in team &&
		Array.isArray(team.runs) &&
		team.runs.every(
			(run) =>
				typeof run === "object" &&
				run !== null &&
				"id" in run &&
				typeof run.id === "string" &&
				"status" in run &&
				typeof run.status === "string" &&
				"prompt" in run &&
				typeof run.prompt === "string" &&
				"nodes" in run &&
				Array.isArray(run.nodes),
		)
	);
}

async function reconnect(entry: ConnectionEntry): Promise<void> {
	if (reconnecting.has(entry.id)) return;
	reconnecting.add(entry.id);
	const activeSessionId = activeTargetKey?.startsWith(`${entry.id}:`) ? session?.id : undefined;
	const preserveWorkspace =
		builderActive ||
		activeAgentId !== undefined ||
		activeSubagentKey !== undefined ||
		activeExternalRunId !== undefined ||
		activeExternalConnectionId !== undefined ||
		activeArtifactId !== undefined;
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
				await switchSession(target, preserveWorkspace);
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

sessionPath.addEventListener("click", openSessionPathEditor);
sessionPathCancel.addEventListener("click", closeSessionPathEditor);
sessionPathInput.addEventListener("keydown", (event) => {
	if (event.key === "Escape") closeSessionPathEditor();
});
sessionPathForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void saveTargetPath(sessionPathInput.value).catch((error: unknown) => {
		closeSessionPathEditor();
		setStatus(error instanceof Error ? error.message : String(error), true);
	});
});

async function submitComposer(): Promise<void> {
	if (activeSubagentKey || activeExternalRunId) return;
	if (activeExternalConnectionId) {
		await submitExternalComposer(activeExternalConnectionId);
		return;
	}
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

async function submitExternalComposer(connectionId: string): Promise<void> {
	const connection = externalConnections.find((entry) => entry.id === connectionId);
	if (!connection) throw new Error("The selected delegation connection is unavailable");
	const activeRun = externalRuns.find(
		(run) => run.connectionId === connectionId && (run.status === "starting" || run.status === "running"),
	);
	if (activeRun) {
		await abortExternalRun(activeRun.id);
		return;
	}
	const prompt = input.value.trim();
	if (!prompt) return;
	recordPromptHistory(prompt);
	input.value = "";
	resizeComposer();
	const latest = externalRuns
		.filter((run) => run.connectionId === connectionId)
		.sort((left, right) => right.createdAt - left.createdAt)[0];
	const cwd = requiredElement<HTMLInputElement>("external-cwd").value || latest?.cwd || session?.snapshot?.cwd;
	if (!cwd) throw new Error("A working directory is required for the delegated chat");
	const selectedModel = modelRefFromValue(model.value);
	if (
		!selectedModel ||
		!connection.models.some(
			(candidate) => candidate.provider === selectedModel.provider && candidate.id === selectedModel.id,
		)
	) {
		throw new Error("Select a model supported by this delegation connection");
	}
	await startExternalRun(connectionId, prompt, cwd, selectedModel);
}

function agentBuilderModelCandidates(prompt: string): string {
	const normalizedPrompt = prompt.toLowerCase();
	const compactPrompt = normalizedPrompt.replace(/[^a-z0-9]/g, "");
	const matches = availableModels.filter((entry) => {
		const provider = entry.provider.toLowerCase();
		const providerLabel = modelProviderLabels[entry.provider]?.toLowerCase();
		const id = entry.id.toLowerCase().replace(/[^a-z0-9]/g, "");
		const name = entry.name.toLowerCase().replace(/[^a-z0-9]/g, "");
		return (
			normalizedPrompt.includes(provider) ||
			(providerLabel !== undefined && normalizedPrompt.includes(providerLabel)) ||
			(id.length >= 4 && compactPrompt.includes(id)) ||
			(name.length >= 4 && compactPrompt.includes(name))
		);
	});
	const values = new Set<string>();
	if (agentModel.value) values.add(agentModel.value);
	for (const entry of matches) values.add(`${entry.provider}/${entry.id}`);
	if (values.size === 0) values.add(`${recommendedAgentModel.provider}/${recommendedAgentModel.id}`);
	return [...values].slice(0, 40).join(", ");
}

async function submitBuilderComposer(): Promise<void> {
	const chatSession = session;
	if (!chatSession) return;
	await pendingSessionConfigurationUpdates.get(chatSession.id);
	if (chatSession.snapshot?.phase !== "idle") {
		await chatSession.abort();
		return;
	}
	const prompt = input.value.trim();
	if (!prompt) return;
	if (!activeSidebarAgent && teamFactoryDraft) {
		recordPromptHistory(prompt);
		input.value = "";
		resizeComposer();
		await submitTeamFactory(prompt);
		return;
	}
	if (/^(?:apply|save|confirm|proceed)(?:\s+(?:this|the))?\s+(?:update|change|draft)(?:\s+now)?[.!]?$/i.test(prompt)) {
		const latestDraft = latestAgentBuilderDraftFromSnapshot(chatSession.snapshot);
		if (latestDraft && latestDraft !== lastAppliedBuilderDraft) applyAgentBuilderDraft(latestDraft);
		if (agentBuilderDraftSignature() === agentBuilderBaseline) {
			setStatus("No drafted agent changes are ready to apply", true);
			return;
		}
		recordPromptHistory(prompt);
		input.value = "";
		resizeComposer();
		agentForm.requestSubmit();
		return;
	}
	recordPromptHistory(prompt);
	input.value = "";
	resizeComposer();
	const editingExistingAgent = requiredElement<HTMLInputElement>("agent-id").value.length > 0;
	const improvementContext = activeAgentImprovement
		? [
				`Improvement route: ${activeAgentImprovement.route}`,
				`Improvement goal: ${activeAgentImprovement.objective}`,
				`Success criteria: ${activeAgentImprovement.successCriteria}`,
				`Execution scope: ${activeAgentImprovement.scope === "auto" ? "Decide whether one agent or a coordinated team is justified" : activeAgentImprovement.scope}`,
				...(activeAgentImprovement.scope === "agent"
					? []
					: [
							`Available agent roles: ${
								agents
									.filter((candidate) => candidate.id !== activeSidebarAgent?.id)
									.map((candidate) => `${candidate.id} (${boundedTaskEvidence(candidate.description, 120)})`)
									.join(", ") || "none"
							}`,
						]),
				"Use a team only when distinct roles can work independently or provide a necessary review boundary. If required roles do not exist, describe them before changing delegate IDs.",
				`Last-known-good agent revision: ${activeAgentImprovement.baselineRevision}`,
				activeAgentImprovement.task
					? `Retained run evidence: task ${activeAgentImprovement.task.id}; status ${activeAgentImprovement.task.status}; attempts ${activeAgentImprovement.task.attemptIds.join(", ") || "none"}; request ${boundedTaskEvidence(activeAgentImprovement.task.prompt, 2_000)}; result ${boundedTaskEvidence(activeAgentImprovement.task.result ?? "none", 2_000)}; error ${boundedTaskEvidence(activeAgentImprovement.task.error ?? "none", 1_000)}`
					: "Retained run evidence: no specific run was selected; diagnose before proposing a change.",
				"Preserve the current agent as the baseline. Propose a candidate only. Do not claim improvement without evidence against the stated success criteria.",
			]
		: [];
	const message = [
		agentBuilderBootstrapPrefix,
		"Work progressively. Start from the user's name and intended outcome, then ask at most one concise question only when it blocks the smallest useful draft.",
		"Do not front-load persona, memory, model, tools, permissions, schedules, or team topology. Recommend each only when the concrete task requires it.",
		"The visible configuration form remains the source of truth. The console persists the named draft independently of this conversation.",
		"Do not call agent_deploy or modify agent files. Return a draft marker only; the user applies the reviewed form.",
		"Never propose or create automation in this conversation. Pi unlocks that only after a one-time proof is reviewed, accepted, and promoted to a skill.",
		editingExistingAgent
			? "This is an edit. Include only fields the user explicitly requested to change; omit every unchanged field."
			: "This is a new agent. Include every required field that is known and omit unknown optional fields.",
		"When feedback identifies an observable regression, include a criteria array in the draft marker. Each item needs id, label, description, category, expectation, and evaluator. Use human for judgment; tool-receipt/tool-errors/workspace-mutation for retained tool evidence; result-text/artifact-text/artifact-change for deterministic output checks. Preserve existing passing criteria.",
		'End with exactly one one-line JSON marker. For a model-only edit, use: [AGENT_DRAFT]{"model":"provider/model"}[/AGENT_DRAFT]',
		"Never invent a model ID. Use an exact candidate below. If there is one clear match, use it without asking; otherwise ask the user to choose in Advanced configuration.",
		`Exact model candidates for this request: ${agentBuilderModelCandidates(prompt)}`,
		"The console applies valid marker fields to the draft only. Tell the user to review and apply the update.",
		`Current name: ${requiredElement<HTMLInputElement>("agent-name").value || "not set"}`,
		`Current description: ${requiredElement<HTMLTextAreaElement>("agent-description").value || "not set"}`,
		`Current project folder: ${requiredElement<HTMLInputElement>("agent-project-root").value || "not set"}`,
		`Current persona profile: ${personaSelect.value || "custom"}. Omit persona fields unless the user requested a persona change.`,
		`Current tools: ${requiredElement<HTMLInputElement>("agent-tools").value || "none"}`,
		`Current model: ${agentModel.value || "inherit current session"}`,
		`Current thinking: ${agentThinking.value}`,
		`Current executor: ${requiredElement<HTMLSelectElement>("agent-executor").value}`,
		`Current permission policy: ${requiredElement<HTMLSelectElement>("agent-permissions").value}`,
		`Current browser access: ${requiredElement<HTMLSelectElement>("agent-browser-access").value}`,
		`Current delegates: ${requiredElement<HTMLInputElement>("agent-delegates").value || "none"}`,
		`Current build lifecycle: ${activeAgentBuild?.stage ?? "unnamed draft"}`,
		...improvementContext,
		`User request: ${prompt}`,
	].join("\n");
	try {
		await chatSession.prompt(message);
		if (builderActive && session === chatSession) await refreshActiveAgentBuild();
	} catch (error) {
		if (!input.value.trim()) {
			input.value = prompt;
			resizeComposer();
		}
		throw error;
	}
}

async function submitAgentComposer(agentId: string): Promise<void> {
	if (!capabilityToken) return;
	const agent = agents.find((entry) => entry.id === agentId);
	if (!agent) throw new Error("The selected agent is unavailable");
	const teamState = agentTeamStates.get(agentId);
	const activeTeamRun = teamState?.team?.runs.find((run) => run.status === "running");
	if (activeTeamRun) {
		const response = await fetch(`/agent-teams/cancel?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ coordinatorAgentId: agentId, runId: activeTeamRun.id }),
		});
		if (!response.ok) throw new Error(await responseError(response, "Could not stop team run"));
		await loadSelectedAgent();
		return;
	}
	const activeTask = agentTasksByAgent
		.get(agentId)
		?.find((task) =>
			["queued", "running", "waiting_for_approval", "waiting_for_input", "stopping"].includes(task.status),
		);
	if (activeTask) {
		await cancelAgentTask(activeTask.id);
		return;
	}
	const prompt = input.value.trim();
	if (!prompt) return;
	recordPromptHistory(prompt);
	input.value = "";
	resizeComposer();
	if (teamState?.installed) {
		const response = await fetch(`/agent-teams/run?token=${encodeURIComponent(capabilityToken)}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ coordinatorAgentId: agentId, prompt }),
		});
		if (!response.ok) throw new Error(await responseError(response, "Could not start team run"));
		await loadSelectedAgent();
		return;
	}
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
teamPackageInput.addEventListener("change", () => {
	const files = [...(teamPackageInput.files ?? [])];
	teamPackageInput.value = "";
	if (files.length === 0) return;
	void prepareTeamPackageFiles(files).catch((error: unknown) =>
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
		(!activeAgentId && session?.snapshot?.phase !== "idle")
	)
		return;
	event.preventDefault();
	form.requestSubmit();
});

model.addEventListener("change", () => {
	const separator = model.value.indexOf("/");
	if (separator < 1) return;
	if (activeExternalConnectionId) {
		const connection = externalConnections.find((entry) => entry.id === activeExternalConnectionId);
		if (connection?.models.some((entry) => `${entry.provider}/${entry.id}` === model.value)) {
			localStorage.setItem(`pi-serve-external-model:${connection.id}`, model.value);
			setStatus(`${connection.name} · ${model.options[model.selectedIndex]?.textContent ?? model.value}`);
		}
		return;
	}
	updateThinkingLevelAvailability(thinking, model.value, thinking.value as ThinkingLevel);
	const targetSession = session;
	if (!targetSession || activeAgentId || activeSubagentKey || activeExternalRunId || activeExternalConnectionId)
		return;
	trackSessionConfigurationUpdate(
		targetSession,
		targetSession.setModel({ provider: model.value.slice(0, separator), id: model.value.slice(separator + 1) }),
		`Switching to ${model.options[model.selectedIndex]?.textContent ?? model.value}…`,
	);
});

agentModel.addEventListener("change", () => {
	const agentThinking = requiredElement<HTMLSelectElement>("agent-thinking");
	const inheritedModel = session?.snapshot ? `${session.snapshot.model.provider}/${session.snapshot.model.id}` : "";
	updateThinkingLevelAvailability(
		agentThinking,
		agentModel.value || inheritedModel,
		agentThinking.value as ThinkingLevel,
	);
});

thinking.addEventListener("change", () => {
	const targetSession = session;
	if (targetSession && !activeAgentId && !activeSubagentKey && !activeExternalRunId && !activeExternalConnectionId)
		trackSessionConfigurationUpdate(
			targetSession,
			targetSession.setThinking(thinking.value as ThinkingLevel),
			`Switching thinking to ${thinking.value}…`,
		);
});

function trackSessionConfigurationUpdate(
	targetSession: PiSessionHandle,
	update: Promise<SessionSnapshot>,
	pendingMessage: string,
): void {
	pendingSessionConfigurationUpdates.set(targetSession.id, update);
	setStatus(pendingMessage);
	void update.then(
		() => {
			if (pendingSessionConfigurationUpdates.get(targetSession.id) === update)
				pendingSessionConfigurationUpdates.delete(targetSession.id);
			setStatus(builderActive ? `${builderLabel} ready` : "Ready");
		},
		(error: unknown) => {
			if (pendingSessionConfigurationUpdates.get(targetSession.id) === update)
				pendingSessionConfigurationUpdates.delete(targetSession.id);
			if (targetSession.snapshot) {
				model.value = `${targetSession.snapshot.model.provider}/${targetSession.snapshot.model.id}`;
				modelPicker.refresh();
				thinking.value = targetSession.snapshot.thinkingLevel;
				updateThinkingLevelAvailability(thinking, model.value, targetSession.snapshot.thinkingLevel);
			}
			setStatus(error instanceof Error ? error.message : String(error), true);
		},
	);
}

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
			if (builderActive) void loadCapabilities().catch((error: unknown) => setStatus(String(error), true));
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
			void Promise.all([loadEverydayConfigurations(), loadRoutines()]).catch((error: unknown) =>
				setStatus(error instanceof Error ? error.message : String(error), true),
			);
	});
}

newAgent.addEventListener("click", () => {
	void openAgentBuilder().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});

document.addEventListener("pointerdown", (event) => {
	if (event.target instanceof Element && event.target.closest(".agent-menu")) return;
	closeAgentMenus();
});

showConnectionForm.addEventListener("click", () => {
	connectionForm.classList.toggle("hidden");
	if (!connectionForm.classList.contains("hidden")) connectionUrl.focus();
});

openSettingsButton.addEventListener("click", () => {
	mobilePanelNone.checked = true;
	openSettings("models");
});
openArtifactsButton.addEventListener("click", () => {
	void openArtifactLibrary().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
settingsClose.addEventListener("click", closeSettings);
window.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	closeAgentMenus();
	if (!settingsWorkspace.classList.contains("hidden")) closeSettings();
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
	if (!validateAgentBuilder()) return;
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
	if (id) {
		if (activeAgentBuild?.agentId !== id) {
			setStatus("The durable build record is unavailable. Reopen this agent before saving a candidate.", true);
			return;
		}
		setStatus("Saving candidate revision…");
		void persistAgentBuildDraft()
			.then(async () => {
				agentBuilderBaseline = agentBuilderDraftSignature();
				agentBuilderFeedback = `Candidate revision ${activeAgentBuild?.candidateRevision ?? ""} saved. The active agent remains unchanged until proof acceptance and promotion.`;
				activeAgentImprovement = undefined;
				updateAgentBuilderReadiness();
				await loadAgents();
				if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
				setStatus(agentBuilderFeedback);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				agentValidation.className = "run-error";
				agentValidation.textContent = message;
				setStatus(message, true);
			});
		return;
	}
	const path = "/agents";
	const savedAgentName = definition.name;
	setStatus("Publishing agent…");
	void fetch(`${path}?token=${encodeURIComponent(capabilityToken)}`, {
		method: "POST",
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
			void (async () => {
				await loadAgents();
				await Promise.all([loadRoutines(), loadWorkflows()]);
				const savedId =
					typeof saved === "object" && saved !== null && "id" in saved && typeof saved.id === "string"
						? saved.id
						: id;
				if (savedId) {
					requiredElement<HTMLInputElement>("agent-id").value = savedId;
					activeSidebarAgent = agents.find((entry) => entry.id === savedId) ?? activeSidebarAgent;
					await linkActiveAgentBuild(savedId);
				}
				builderLabel = `Edit ${savedAgentName}`;
				agentSubmit.textContent = "Save candidate revision";
				agentCancel.textContent = "Cancel editing";
				agentBuilderBaseline = agentBuilderDraftSignature();
				agentBuilderFeedback = `Agent ${savedAgentName} published.`;
				activeAgentImprovement = undefined;
				updateAgentBuilderReadiness();
				if (session?.snapshot && builderActive) renderBuilderConversation(session.snapshot);
				setStatus(agentBuilderFeedback);
			})().catch((error: unknown) => {
				setStatus(
					`Agent saved; background refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					true,
				);
			});
		})
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			agentValidation.className = "run-error";
			agentValidation.textContent = message;
			setStatus(message, true);
		});
});

agentCancel.addEventListener("click", () => void closeBuilderChat());

personaSelect.addEventListener("change", () => {
	updatePersonaPreview(true);
	updateAgentBuilderReadiness();
});
requiredElement<HTMLSelectElement>("agent-executor").addEventListener("change", () => {
	void loadCapabilities().catch((error: unknown) =>
		setStatus(error instanceof Error ? error.message : String(error), true),
	);
});
requiredElement<HTMLSelectElement>("agent-browser-profile-kind").addEventListener("change", () => {
	updateAgentBrowserProfileFields();
	updateAgentBuilderReadiness();
});
agentForm.addEventListener("input", () => {
	updateAgentBuilderReadiness();
	scheduleAgentBuildDraftPersistence();
});
agentForm.addEventListener("change", () => {
	updateAgentBuilderReadiness();
	scheduleAgentBuildDraftPersistence();
});
for (const field of document.querySelectorAll<HTMLElement>('[form="agent-form"]')) {
	field.addEventListener("input", () => {
		updateAgentBuilderReadiness();
		scheduleAgentBuildDraftPersistence();
	});
	field.addEventListener("change", () => {
		updateAgentBuilderReadiness();
		scheduleAgentBuildDraftPersistence();
	});
}

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
	if (!externalRunForm.reportValidity()) {
		setStatus("Complete the delegation task, working directory, and model", true);
		return;
	}
	const connectionId = requiredElement<HTMLInputElement>("external-id").value;
	const prompt = requiredElement<HTMLTextAreaElement>("external-prompt").value.trim();
	const cwd = requiredElement<HTMLInputElement>("external-cwd").value.trim();
	const separator = externalModel.value.indexOf("/");
	if (!connectionId || !prompt || !cwd || separator < 1) {
		setStatus("Select a valid delegation connection and model", true);
		return;
	}
	void startExternalRun(connectionId, prompt, cwd, {
		provider: externalModel.value.slice(0, separator),
		id: externalModel.value.slice(separator + 1),
	})
		.then(() => {
			requiredElement<HTMLTextAreaElement>("external-prompt").value = "";
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
	if (!activeSidebarAgent) {
		setStatus("Save and deploy this agent before adding a schedule", true);
		return;
	}
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
	const automationConfirmed =
		!definition.enabled ||
		definition.target.kind !== "agent" ||
		window.confirm(
			`Enable ${definition.name} for ${activeSidebarAgent.name} using ${definition.timezone}? This will run without another prompt.`,
		);
	if (!automationConfirmed) {
		setStatus("Schedule not enabled; review it and save when ready");
		return;
	}
	const id = routineEditor.id.value;
	void fetch(
		`${id ? `/routines/${encodeURIComponent(id)}` : "/routines"}?token=${encodeURIComponent(capabilityToken)}`,
		{
			method: id ? "PUT" : "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...definition, automationConfirmed }),
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
			await Promise.all([loadRoutines(), refreshActiveAgentBuild()]);
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
		}
		if (activeTab === "agents-workspace" || activeExternalConnectionId || openExternalRunIds.length > 0)
			await loadExternalRuns();
		if (activeTab === "agent-builder") await Promise.all([loadRoutines(), loadWorkflows()]);
	})()
		.catch(() => {})
		.finally(() => {
			periodicRefreshPromise = undefined;
		});
}, 2500);

installPanelResizer("left-resizer", "--rail-width", "pi-serve-rail-width", 1, 190, 420);
installPanelResizer("right-resizer", "--details-width", "pi-serve-details-width", -1, 280, 560);
installRailSectionResizer();
resizeComposer();
clearRoutineEditor();
clearWorkflowEditor();
updateAgentBuilderReadiness();
if (location.hash.startsWith("#settings/")) applySettingsHash();
void connect().catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error), true));
