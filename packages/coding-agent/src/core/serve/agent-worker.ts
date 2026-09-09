import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { AgentSession } from "../agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../agent-session-services.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import {
	type AgentExecutionPhase,
	agentExecutionInstructions,
	agentExecutionResultFromMessages,
	agentIdentityInstructions,
} from "./agent-executor.ts";
import { createAgentSkillTool } from "./agent-skill-tools.ts";
import type {
	AgentWorkerCapabilityToolResponseMessage,
	AgentWorkerHostAction,
	AgentWorkerHostActionResponseMessage,
	AgentWorkerHostActionResult,
	AgentWorkerRequest,
	AgentWorkerResponse,
	AgentWorkerResultArtifact,
	AgentWorkerStartMessage,
} from "./agent-worker-protocol.ts";
import { BrowserArtifactStore } from "./browser-artifact-store.ts";
import { BrowserProfileStore } from "./browser-profile-store.ts";
import { BrowserSessionManager } from "./browser-session-manager.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { BrowserWorkflowCaptureStore } from "./browser-workflow-capture.ts";
import { BrowserWorkflowCompiler } from "./browser-workflow-compiler.ts";
import { BrowserWorkflowReferenceStore } from "./browser-workflow-reference-store.ts";
import { BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import { BrowserWorkflowRunner } from "./browser-workflow-runner.ts";
import { createBrowserWorkflowTools } from "./browser-workflow-tools.ts";
import { PlaywrightBrowserDriver } from "./playwright-browser-driver.ts";
import { createScopedAgentTools, type ScopedAgentFileOperations } from "./scoped-agent-tools.ts";
import { assertToolHandoffContribution, collectToolEvidence } from "./team-tool-handoff.ts";
import { recoverTeamTurn } from "./team-turn-recovery.ts";
import { createTeamContextTool, createTeamTurnTool, teamHistoryGuidance } from "./team-turn-tool.ts";
import { WorkspacePreviewServer } from "./workspace-preview-server.ts";

let activeSession: AgentSession | undefined;
let abortRequested = false;
let started = false;
let phase: AgentExecutionPhase = "initializing";
const pendingHostActions = new Map<
	string,
	{ resolve: (result: AgentWorkerHostActionResult) => void; reject: (error: Error) => void }
>();
const pendingCapabilityTools = new Map<
	string,
	{ resolve: (result: AgentToolResult<unknown>) => void; reject: (error: Error) => void; cleanup: () => void }
>();

process.on("message", (value: unknown) => {
	if (!isRequest(value)) return;
	if (value.type === "capability-tool-response") {
		handleCapabilityToolResponse(value);
		return;
	}
	if (value.type === "host-action-response") {
		handleHostActionResponse(value);
		return;
	}
	if (value.type === "abort") {
		abortRequested = true;
		rejectPendingHostActions(new Error("Agent worker was aborted"));
		rejectPendingCapabilityTools(new Error("Agent worker was aborted"));
		void activeSession?.abort();
		return;
	}
	if (started) return;
	started = true;
	void run(value);
});
process.once("disconnect", requestAbort);
process.once("SIGTERM", requestAbort);
process.once("SIGINT", requestAbort);

function requestAbort(): void {
	abortRequested = true;
	rejectPendingHostActions(new Error("Agent worker was aborted"));
	rejectPendingCapabilityTools(new Error("Agent worker was aborted"));
	void activeSession?.abort();
}

async function run(request: AgentWorkerStartMessage): Promise<void> {
	const cleanups: Array<() => Promise<void>> = [];
	let response: AgentWorkerResponse | undefined;
	const heartbeat = setInterval(() => {
		void send({ type: "heartbeat", phase, timestamp: Date.now() }).catch(() => undefined);
	}, 5_000);
	heartbeat.unref();
	try {
		await emitProgress("initializing", "Initializing isolated agent session");
		const definition = request.context.definition;
		const workspace = request.context.workspace;
		const services = await createAgentSessionServices({
			cwd: workspace,
			agentDir: request.agentDir,
			resourceLoaderOptions: {
				systemPromptOverride: (base) =>
					[
						base,
						agentIdentityInstructions(definition),
						"Continue the conversation as this agent and operate only through the provided tools.",
					]
						.filter((entry): entry is string => entry !== undefined && entry.length > 0)
						.join("\n\n"),
			},
		});
		if (request.modelApiKey && definition.model) {
			await services.modelRuntime.setRuntimeApiKey(definition.model.provider, request.modelApiKey);
		}
		const resolvedModel = definition.model
			? services.modelRuntime.getModel(definition.model.provider, definition.model.id)
			: services.modelRuntime.getAvailableSnapshot()[0];
		if (!resolvedModel) {
			throw new Error(
				definition.model
					? `Agent model ${definition.model.provider}/${definition.model.id} is unavailable`
					: "No model is available for the agent run",
			);
		}
		const model = definition.budget?.maxTokens
			? { ...resolvedModel, maxTokens: Math.min(resolvedModel.maxTokens, definition.budget.maxTokens) }
			: resolvedModel;
		const isolated = definition.executor === "harness";
		const customTools = (
			isolated ? [...createScopedAgentTools(definition, workspace, hostScopedFileOperations)] : []
		) as ToolDefinition[];
		const teamContext: unknown = definition.teamContext ? JSON.parse(definition.teamContext) : undefined;
		const historyGuidance = teamHistoryGuidance(teamContext);
		const completedAgentIds =
			typeof teamContext === "object" &&
			teamContext !== null &&
			"supervisorAgentId" in teamContext &&
			teamContext.supervisorAgentId === definition.id &&
			"completedAgentIds" in teamContext &&
			Array.isArray(teamContext.completedAgentIds)
				? teamContext.completedAgentIds.filter((id): id is string => typeof id === "string")
				: [];
		const teamTurn = definition.responseSchema
			? createTeamTurnTool(
					definition.responseSchema,
					completedAgentIds,
					() =>
						(activeSession?.messages ?? []).flatMap((message) =>
							message.role === "toolResult" &&
							!message.isError &&
							!["read_team_context", "read_agent_skill", "submit_team_turn"].includes(message.toolName)
								? [{ id: message.toolCallId, name: message.toolName }]
								: [],
						),
					(input) =>
						assertToolHandoffContribution(teamContext, definition.id, activeSession?.messages ?? [], input),
				)
			: undefined;
		if (isolated) customTools.push(createAgentSkillTool(services.resourceLoader.getSkills().skills));
		if (teamTurn) customTools.push(teamTurn.tool);
		if (teamTurn && definition.teamContext) customTools.push(createTeamContextTool(definition.teamContext));
		customTools.push(
			...request.capabilityTools.map(
				(tool): ToolDefinition => ({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters as TSchema,
					promptSnippet: tool.promptSnippet,
					promptGuidelines: tool.promptGuidelines,
					executionMode: tool.executionMode,
					execute(_toolCallId, input, signal) {
						return requestCapabilityTool(tool.name, input, signal);
					},
				}),
			),
		);
		if (
			definition.browser?.access &&
			definition.browser.access !== "disabled" &&
			!request.capabilityTools.some((tool) => tool.name === "browser_open")
		) {
			const browserRoot = join(request.serveRoot, "browser");
			const captureStore = new BrowserWorkflowCaptureStore(join(browserRoot, "captures"));
			await captureStore.initialize();
			const registry = new BrowserWorkflowRegistry(join(browserRoot, "workflows"));
			await registry.initialize();
			const driver = new PlaywrightBrowserDriver();
			const manager = new BrowserSessionManager(
				driver,
				new BrowserProfileStore(browserRoot),
				2,
				new BrowserArtifactStore(browserRoot),
				captureStore,
			);
			const preview = new WorkspacePreviewServer();
			const runner = new BrowserWorkflowRunner(registry, manager, join(browserRoot, "runs"));
			await runner.initialize();
			const references = new BrowserWorkflowReferenceStore(
				join(browserRoot, "references"),
				join(request.agentDir, "skills"),
				registry,
			);
			await references.initialize();
			const owner = { kind: "agent-run" as const, id: request.context.runId };
			const compiler = new BrowserWorkflowCompiler(registry);
			customTools.push(
				...createBrowserTools(manager, {
					owner,
					workspace: { id: definition.id, root: workspace },
					access: definition.browser.access,
					profile: definition.browser.profile,
					runtime: definition.browser.runtime,
					workspacePreview: preview,
					workflowCompiler: compiler,
				}),
				...createBrowserWorkflowTools(registry, runner, {
					owner,
					workspace: { id: definition.id, root: workspace },
					allowedWorkflows: definition.browserWorkflows,
					profile: definition.browser.profile,
					runtime: definition.browser.runtime,
					frontendTests: () =>
						references
							.listFrontendTests(workspace)
							.map((entry) => ({ id: entry.workflowId, version: entry.workflowVersion })),
				}),
			);
			cleanups.push(
				() => manager.closeOwner(owner),
				() => manager.dispose(),
				() => preview.close(),
			);
		}

		const toolNames = isolated
			? customTools.map((tool) => tool.name)
			: [
					...definition.tools.flatMap((tool) =>
						tool === "browser"
							? customTools.filter((entry) => entry.name.startsWith("browser_")).map((entry) => entry.name)
							: [tool === "list" ? "ls" : tool],
					),
					...request.capabilityTools.map((tool) => tool.name),
				];
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(workspace),
			model,
			thinkingLevel: definition.thinking,
			modelControls: definition.modelControls,
			tools: [
				...new Set([
					...toolNames,
					...(teamTurn ? [teamTurn.tool.name, ...(definition.teamContext ? ["read_team_context"] : [])] : []),
				]),
			],
			customTools: customTools.length > 0 ? customTools : undefined,
		});
		activeSession = created.session;
		const unsubscribe = activeSession.subscribe((event) => {
			void emitProgress(sessionEventPhase(event.type), event.type).catch(() => undefined);
		});
		cleanups.unshift(async () => {
			unsubscribe();
			activeSession?.dispose();
			activeSession = undefined;
		});
		if (abortRequested) throw new Error("Agent worker was aborted");
		const instructions = [
			agentExecutionInstructions(request.context),
			`Callable tools in this execution (host-observed, not just catalog entries): ${activeSession.getActiveToolNames().join(", ")}. Use the listed callable name and its schema. A catalog capability ID may differ from its callable name. Do not claim a listed tool is unavailable without an actual call result. Read discovered skills with read_agent_skill by name; workspace read does not grant access to external skill paths.`,
			"Current runtime: Gmail draft tools resolve direct user chat authorization internally. Users do not supply approval receipt IDs. For an approved draft, invoke the current tool or delegate to the member with email.draft, even if an earlier attempt reported a missing receipt. Leave recipients empty if unspecified. reportPath embeds and attaches the exact saved HTML file. A local draft preview does not satisfy a request for a Gmail draft; completion needs a successful provider draft ID and review URL. Sending always requires separate approval.",
			...(teamTurn
				? [
						"Use submit_team_turn to send your message and control action. Any JSON response descriptions above specify that tool's arguments, not your final answer. Call the tool exactly once; then finish with a brief conversational acknowledgment. Do not output the control JSON as prose.",
					]
				: []),
			...(historyGuidance ? [historyGuidance] : []),
			...(typeof teamContext === "object" && teamContext !== null && "toolHandoffs" in teamContext
				? [
						`Current host-verified report-tool handoffs: ${JSON.stringify(teamContext.toolHandoffs)}. Your member ID is ${definition.id}. If you are the builder and tool is missing, use report_tools action register with the improved definition and samples now. Registration runs validation itself; do not request permission to run the old tool for validation. If you are the consumer, invoke the exact tool named in the handoff and present its returned reportPath. Report only observed receipts.`,
					]
				: []),
		].join("\n\n");
		await emitProgress("waiting-for-model", "Waiting for model response");
		await activeSession.prompt(instructions, { source: "rpc" });
		let result = agentExecutionResultFromMessages(activeSession.messages);
		if (teamTurn) {
			if (abortRequested) throw new Error("Agent worker was aborted");
			await recoverTeamTurn(activeSession, teamTurn.result);
			result = agentExecutionResultFromMessages(activeSession.messages);
			const submitted = teamTurn.result();
			if (!submitted) throw new Error("Agent finished without submitting its team action");
			const properties = definition.responseSchema?.properties;
			result.output =
				typeof properties === "object" && properties !== null && "toolEvidence" in properties
					? JSON.stringify({ ...JSON.parse(submitted), toolEvidence: collectToolEvidence(activeSession.messages) })
					: submitted;
		}
		await emitProgress("writing-results", "Writing durable run results");
		await writeResultArtifact(request.resultPath, {
			status: "succeeded",
			output: result.output,
			transcript: [...result.transcript],
		});
		response = { type: "result" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			await writeResultArtifact(request.resultPath, { status: "failed", error: message });
			response = { type: "result" };
		} catch (artifactError) {
			response = {
				type: "error",
				error: `Agent failed: ${message}; completion persistence failed: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`,
			};
		}
	} finally {
		clearInterval(heartbeat);
		rejectPendingHostActions(new Error("Agent worker stopped"));
		rejectPendingCapabilityTools(new Error("Agent worker stopped"));
		for (const cleanup of cleanups) await cleanup().catch(() => undefined);
		if (response) await send(response).catch(() => undefined);
		process.disconnect?.();
	}
}

async function emitProgress(nextPhase: AgentExecutionPhase, message: string): Promise<void> {
	phase = nextPhase;
	await send({ type: "event", phase, message, timestamp: Date.now() });
}

function sessionEventPhase(type: string): AgentExecutionPhase {
	if (type.startsWith("tool_execution_")) return "running-tool";
	if (type.includes("message_update") || type.includes("text_delta") || type.includes("thinking_delta")) {
		return "generating";
	}
	return "waiting-for-model";
}

function send(message: AgentWorkerResponse): Promise<void> {
	if (!process.connected || !process.send) return Promise.reject(new Error("Agent worker IPC channel is closed"));
	return new Promise((resolve, reject) => {
		process.send?.(message, (error) => (error ? reject(error) : resolve()));
	});
}

async function writeResultArtifact(path: string, artifact: AgentWorkerResultArtifact): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(artifact)}\n`, "utf8");
	await rename(temporaryPath, path);
}

function isRequest(value: unknown): value is AgentWorkerRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "start" || type === "abort" || type === "host-action-response" || type === "capability-tool-response"
	);
}

function requestCapabilityTool(
	toolName: string,
	input: unknown,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
	if (abortRequested || signal?.aborted) return Promise.reject(new Error("Agent worker was aborted"));
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		const abort = () => {
			pendingCapabilityTools.delete(requestId);
			reject(new Error("Capability tool call was aborted"));
		};
		pendingCapabilityTools.set(requestId, {
			resolve,
			reject,
			cleanup: () => signal?.removeEventListener("abort", abort),
		});
		signal?.addEventListener("abort", abort, { once: true });
		void send({ type: "capability-tool-request", requestId, toolName, input }).catch((error) => {
			pendingCapabilityTools.delete(requestId);
			signal?.removeEventListener("abort", abort);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function handleCapabilityToolResponse(message: AgentWorkerCapabilityToolResponseMessage): void {
	const pending = pendingCapabilityTools.get(message.requestId);
	if (!pending) return;
	pendingCapabilityTools.delete(message.requestId);
	pending.cleanup();
	if (message.error) {
		pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
		return;
	}
	if (!message.result) {
		pending.reject(new Error("Capability tool response has no result"));
		return;
	}
	pending.resolve(message.result);
}

function rejectPendingCapabilityTools(error: Error): void {
	for (const pending of pendingCapabilityTools.values()) {
		pending.cleanup();
		pending.reject(error);
	}
	pendingCapabilityTools.clear();
}

const hostScopedFileOperations: ScopedAgentFileOperations = {
	async readBytes(path) {
		const result = await requestHostAction({ family: "filesystem.read", path, binary: true });
		if (result.family !== "filesystem.read" || !result.binary)
			throw new Error("Host returned the wrong binary read result");
		return Buffer.from(result.content, "base64");
	},
	async read(path) {
		const result = await requestHostAction({ family: "filesystem.read", path });
		if (result.family !== "filesystem.read") throw new Error("Host returned the wrong filesystem result");
		return result.content;
	},
	async list(path) {
		const result = await requestHostAction({ family: "filesystem.list", path });
		if (result.family !== "filesystem.list") throw new Error("Host returned the wrong filesystem result");
		return result.entries;
	},
	async write(path, content) {
		const result = await requestHostAction({ family: "filesystem.write", path, content });
		if (result.family !== "filesystem.write") throw new Error("Host returned the wrong filesystem result");
		return result.bytesWritten;
	},
};

function requestHostAction(action: AgentWorkerHostAction): Promise<AgentWorkerHostActionResult> {
	if (abortRequested) return Promise.reject(new Error("Agent worker was aborted"));
	const requestId = randomUUID();
	return new Promise((resolve, reject) => {
		pendingHostActions.set(requestId, { resolve, reject });
		void send({ type: "host-action-request", requestId, action }).catch((error) => {
			pendingHostActions.delete(requestId);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function handleHostActionResponse(message: AgentWorkerHostActionResponseMessage): void {
	const pending = pendingHostActions.get(message.requestId);
	if (!pending) return;
	pendingHostActions.delete(message.requestId);
	if (message.error) {
		pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
		return;
	}
	if (!message.result) {
		pending.reject(new Error("Host action response has no result"));
		return;
	}
	pending.resolve(message.result);
}

function rejectPendingHostActions(error: Error): void {
	for (const pending of pendingHostActions.values()) pending.reject(error);
	pendingHostActions.clear();
}
