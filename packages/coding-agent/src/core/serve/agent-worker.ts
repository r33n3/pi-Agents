import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../agent-session-services.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { SessionManager } from "../session-manager.ts";
import type { AgentWorkerRequest, AgentWorkerResponse, AgentWorkerStartMessage } from "./agent-worker-protocol.ts";
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
import { EverydayConfigurationRegistry } from "./everyday-configuration-registry.ts";
import { createEverydayDataTools } from "./everyday-data-tools.ts";
import { PlaywrightBrowserDriver } from "./playwright-browser-driver.ts";
import { createScopedAgentTools } from "./scoped-agent-tools.ts";
import { createSearxngTools } from "./searxng-tools.ts";
import { WorkspacePreviewServer } from "./workspace-preview-server.ts";

let activeSession: AgentSession | undefined;
let abortRequested = false;
let started = false;

process.on("message", (value: unknown) => {
	if (!isRequest(value)) return;
	if (value.type === "abort") {
		abortRequested = true;
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
	void activeSession?.abort();
}

async function run(request: AgentWorkerStartMessage): Promise<void> {
	const cleanups: Array<() => Promise<void>> = [];
	let response: AgentWorkerResponse | undefined;
	try {
		const definition = request.context.definition;
		const workspace = request.context.workspace;
		const services = await createAgentSessionServices({
			cwd: workspace,
			agentDir: request.agentDir,
			resourceLoaderOptions: {
				systemPromptOverride: (base) =>
					[
						base,
						`You are the locally deployed agent "${definition.name}".`,
						`Persona: ${definition.persona}`,
						`Mission: ${definition.description}`,
						"Continue the conversation as this agent and operate only through the provided tools.",
					]
						.filter((entry): entry is string => entry !== undefined && entry.length > 0)
						.join("\n\n"),
			},
		});
		const model = definition.model
			? services.modelRuntime.getModel(definition.model.provider, definition.model.id)
			: services.modelRuntime.getAvailableSnapshot()[0];
		if (!model) {
			throw new Error(
				definition.model
					? `Agent model ${definition.model.provider}/${definition.model.id} is unavailable`
					: "No model is available for the agent run",
			);
		}
		const isolated = definition.executor === "harness";
		const customTools = (isolated ? [...createScopedAgentTools(definition, workspace)] : []) as ToolDefinition[];
		const everydayConfigurations = new EverydayConfigurationRegistry(
			join(request.serveRoot, "capabilities", "everyday-data"),
		);
		await everydayConfigurations.initialize();
		const brokeredTools = [
			...createEverydayDataTools(join(request.serveRoot, "capabilities", "everyday-data"), everydayConfigurations),
			...createSearxngTools(process.env.SEARXNG_BASE_URL),
		];
		customTools.push(...brokeredTools.filter((tool) => request.capabilityToolNames.includes(tool.name)));

		if (definition.browser?.access && definition.browser.access !== "disabled") {
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
					...request.capabilityToolNames,
				];
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(workspace),
			model,
			thinkingLevel: definition.thinking,
			tools: toolNames,
			customTools: customTools.length > 0 ? customTools : undefined,
		});
		activeSession = created.session;
		const unsubscribe = activeSession.subscribe((event) => send({ type: "event", message: event.type }));
		cleanups.unshift(async () => {
			unsubscribe();
			activeSession?.dispose();
			activeSession = undefined;
		});
		if (abortRequested) throw new Error("Agent worker was aborted");
		const instructions = [
			`You are the locally deployed agent "${definition.name}".`,
			`Persona: ${definition.persona}`,
			`Mission: ${definition.description}`,
			"Operate only through the provided tools. All tool paths are confined to your assigned workspace.",
			`Task: ${request.context.prompt}`,
		].join("\n\n");
		await activeSession.prompt(instructions, { source: "rpc" });
		response = {
			type: "result",
			output: lastAssistantText(activeSession.messages),
			transcript: [...activeSession.messages],
		};
	} catch (error) {
		response = { type: "error", error: error instanceof Error ? error.message : String(error) };
	} finally {
		for (const cleanup of cleanups) await cleanup().catch(() => undefined);
		if (response) send(response);
		process.disconnect?.();
	}
}

function send(message: AgentWorkerResponse): void {
	if (process.connected) process.send?.(message);
}

function isRequest(value: unknown): value is AgentWorkerRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return type === "start" || type === "abort";
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		return message.content
			.filter((entry) => entry.type === "text")
			.map((entry) => entry.text)
			.join("\n");
	}
	return "";
}
