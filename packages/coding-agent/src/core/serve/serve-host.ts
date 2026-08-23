import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { PiServer } from "@earendil-works/pi-server";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { A2aAdapter } from "./a2a-adapter.ts";
import { AgentSessionExecutor } from "./agent-executor.ts";
import { type AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import { createAgentRegistryTools } from "./agent-registry-tools.ts";
import { AgentRoutineScheduler } from "./agent-routine-scheduler.ts";
import { AgentRunManager } from "./agent-run-manager.ts";
import { AgentTaskService } from "./agent-task-service.ts";
import { BrowserArtifactStore } from "./browser-artifact-store.ts";
import { BrowserConsoleService } from "./browser-console-service.ts";
import { BrowserProfileStore } from "./browser-profile-store.ts";
import { type BrowserOwner, BrowserSessionManager } from "./browser-session-manager.ts";
import { BrowserStreamServer } from "./browser-stream-server.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { BrowserWorkflowCaptureStore } from "./browser-workflow-capture.ts";
import { BrowserWorkflowCompiler } from "./browser-workflow-compiler.ts";
import { BrowserWorkflowReferenceStore } from "./browser-workflow-reference-store.ts";
import { BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import { BrowserWorkflowRunner } from "./browser-workflow-runner.ts";
import { createBrowserWorkflowTools } from "./browser-workflow-tools.ts";
import { CapabilityCatalog } from "./capability-catalog.ts";
import { CurrentSessionService } from "./current-session-service.ts";
import { type ExternalConnectionDefinition, ExternalConnectionManager } from "./external-connection-manager.ts";
import { PersonaCatalog, resolvePersonaProject } from "./persona-catalog.ts";
import { PlaywrightBrowserDriver } from "./playwright-browser-driver.ts";
import { PluginManagementService } from "./plugin-management-service.ts";
import { RoutineRegistry } from "./routine-registry.ts";
import { createScopedAgentTools } from "./scoped-agent-tools.ts";
import { ServeAttachmentStore } from "./serve-attachment-store.ts";
import { createServePage } from "./serve-page.ts";
import { WebSocketListener } from "./websocket-listener.ts";
import { WorkflowService } from "./workflow-service.ts";
import { WorkspacePreviewServer } from "./workspace-preview-server.ts";

export interface ServeHostOptions {
	agentDir: string;
	session: AgentSession;
	host?: string;
	port?: number;
	autoIncrementPort?: boolean;
	onError?: (error: Error) => void;
}

export interface ServeHostDiagnostic {
	type: "info";
	message: string;
}

export interface ServeHostStartResult {
	url: string;
	port: number;
	diagnostics: ServeHostDiagnostic[];
}

/** Owns all services and cleanup associated with one `pi --serve` listener. */
export class ServeHost implements AsyncDisposable {
	readonly #options: ServeHostOptions;
	#server: PiServer | undefined;
	#agentRunManager: AgentRunManager | undefined;
	#agentTaskService: AgentTaskService | undefined;
	#workflowService: WorkflowService | undefined;
	#agentRoutineScheduler: AgentRoutineScheduler | undefined;
	#externalConnectionManager: ExternalConnectionManager | undefined;
	#externalSessionExecutor: AgentSessionExecutor | undefined;
	#attachmentStore: ServeAttachmentStore | undefined;
	#browserSessionManager: BrowserSessionManager | undefined;
	#workspacePreviewServer: WorkspacePreviewServer | undefined;
	#startAttempted = false;
	#closePromise: Promise<void> | undefined;

	constructor(options: ServeHostOptions) {
		this.#options = options;
	}

	async start(): Promise<ServeHostStartResult> {
		if (this.#startAttempted) throw new Error("Serve host has already been started");
		if (this.#closePromise) throw new Error("Serve host is closed");
		this.#startAttempted = true;
		try {
			return await this.#start();
		} catch (error) {
			await this.close().catch(() => {});
			throw error;
		}
	}

	close(): Promise<void> {
		this.#closePromise ??= this.#close();
		return this.#closePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	async #start(): Promise<ServeHostStartResult> {
		const { agentDir, session } = this.#options;
		const modelRuntime = session.modelRuntime;
		const host = this.#options.host ?? "127.0.0.1";
		const requestedPort = this.#options.port ?? 4173;
		const token = randomBytes(32).toString("base64url");
		const serveRoot = join(agentDir, "serve");
		const browserDriver = new PlaywrightBrowserDriver();
		const browserCaptureStore = new BrowserWorkflowCaptureStore(join(serveRoot, "browser", "captures"));
		await browserCaptureStore.initialize();
		const browserWorkflowRegistry = new BrowserWorkflowRegistry(join(serveRoot, "browser", "workflows"));
		await browserWorkflowRegistry.initialize();
		const browserWorkflowCompiler = new BrowserWorkflowCompiler(browserWorkflowRegistry);
		this.#workspacePreviewServer = new WorkspacePreviewServer();
		const browserProfileStore = new BrowserProfileStore(join(serveRoot, "browser"));
		const browserArtifactStore = new BrowserArtifactStore(join(serveRoot, "browser"));
		this.#browserSessionManager = new BrowserSessionManager(
			browserDriver,
			browserProfileStore,
			4,
			browserArtifactStore,
			browserCaptureStore,
		);
		const browserWorkflowRunner = new BrowserWorkflowRunner(
			browserWorkflowRegistry,
			this.#browserSessionManager,
			join(serveRoot, "browser", "runs"),
		);
		await browserWorkflowRunner.initialize();
		const browserWorkflowReferences = new BrowserWorkflowReferenceStore(
			join(serveRoot, "browser", "references"),
			join(agentDir, "skills"),
			browserWorkflowRegistry,
		);
		await browserWorkflowReferences.initialize();
		const browserConsole = new BrowserConsoleService(
			this.#browserSessionManager,
			() => browserDriver.installationStatus(),
			browserWorkflowCompiler,
			browserWorkflowRegistry,
			browserWorkflowRunner,
			{
				owner: { kind: "pi-session", id: session.sessionId },
				workspace: { id: session.sessionId, root: session.sessionManager.getCwd() },
			},
			browserCaptureStore,
			browserProfileStore,
			browserWorkflowReferences,
			browserArtifactStore,
		);
		const browserStream = new BrowserStreamServer(browserConsole);
		session.registerCustomTools([
			...createBrowserTools(this.#browserSessionManager, {
				owner: { kind: "pi-session", id: session.sessionId },
				workspace: { id: session.sessionId, root: session.sessionManager.getCwd() },
				access: "loopback",
				workspacePreview: this.#workspacePreviewServer,
			}),
			...createBrowserWorkflowTools(browserWorkflowRegistry, browserWorkflowRunner, {
				owner: { kind: "pi-session", id: session.sessionId },
				workspace: { id: session.sessionId, root: session.sessionManager.getCwd() },
				frontendTests: () =>
					browserWorkflowReferences
						.listFrontendTests(session.sessionManager.getCwd())
						.map((reference) => ({ id: reference.workflowId, version: reference.workflowVersion })),
			}),
		]);
		const agentRegistry = new AgentRegistry(serveRoot, {
			catalogDirectory: join(agentDir, "agents"),
			personaDirectory: join(agentDir, "personas"),
			defaultWorkspace: session.sessionManager.getCwd(),
			modelCatalog: () =>
				session.modelRuntime
					.getAvailableSnapshot()
					.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
			browserWorkflowCatalog: (id, version) => browserWorkflowRunner.isActiveVersion(id, version),
		});
		await agentRegistry.initialize();
		session.registerCustomTools(createAgentRegistryTools(agentRegistry) as ToolDefinition[]);
		let personaCatalog: PersonaCatalog | undefined;
		const personaProject = resolvePersonaProject(agentDir);
		if (personaProject) {
			try {
				personaCatalog = new PersonaCatalog(personaProject);
				await personaCatalog.initialize();
			} catch {
				personaCatalog = undefined;
			}
		}

		const createConfiguredAgentSession = async (
			definition: AgentDefinition,
			workspace: string,
			agentSessionManager = SessionManager.inMemory(workspace),
			browserOwner?: BrowserOwner,
		) => {
			const requestedModel = definition.model;
			const agentModel = requestedModel
				? modelRuntime.getModel(requestedModel.provider, requestedModel.id)
				: session.model;
			if (!agentModel) {
				throw new Error(
					requestedModel
						? `Agent model ${requestedModel.provider}/${requestedModel.id} is unavailable`
						: "No model is available for the agent run",
				);
			}
			const isolated = definition.executor === "harness";
			const scopedTools = isolated ? createScopedAgentTools(definition, workspace) : [];
			const browserTools =
				definition.browser?.access && definition.browser.access !== "disabled" && browserOwner
					? createBrowserTools(this.#browserSessionManager!, {
							owner: browserOwner,
							workspace: { id: definition.id, root: workspace },
							access: definition.browser.access,
							profile: definition.browser.profile,
							runtime: definition.browser.runtime,
							workspacePreview: this.#workspacePreviewServer,
						})
					: [];
			const browserWorkflowTools =
				browserOwner && browserTools.length > 0
					? createBrowserWorkflowTools(browserWorkflowRegistry, browserWorkflowRunner, {
							owner: browserOwner,
							workspace: { id: definition.id, root: workspace },
							allowedWorkflows: definition.browserWorkflows,
							profile: definition.browser?.profile,
							runtime: definition.browser?.runtime,
							frontendTests: () =>
								browserWorkflowReferences
									.listFrontendTests(workspace)
									.map((reference) => ({ id: reference.workflowId, version: reference.workflowVersion })),
						})
					: [];
			const customTools = [...scopedTools, ...browserTools, ...browserWorkflowTools] as ToolDefinition[];
			const toolNames = isolated
				? customTools.map((tool) => tool.name)
				: definition.tools.flatMap((tool) =>
						tool === "browser"
							? [...browserTools, ...browserWorkflowTools].map((browserTool) => browserTool.name)
							: [tool === "list" ? "ls" : tool],
					);
			const resourceLoader = new DefaultResourceLoader({
				cwd: workspace,
				agentDir,
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
			});
			await resourceLoader.reload();
			const created = await createAgentSession({
				cwd: workspace,
				agentDir,
				modelRuntime,
				model: agentModel,
				thinkingLevel: definition.thinking,
				tools: toolNames,
				customTools: customTools.length > 0 ? customTools : undefined,
				resourceLoader,
				sessionManager: agentSessionManager,
			});
			return created.session;
		};
		const createExecutionSession = async (context: Parameters<AgentSessionExecutor["start"]>[0]) =>
			createConfiguredAgentSession(context.definition, context.workspace, undefined, {
				kind: "agent-run",
				id: context.runId,
			});
		const executor = new AgentSessionExecutor(createExecutionSession);
		this.#agentRunManager = new AgentRunManager(agentRegistry, executor, join(serveRoot, "runs"));
		await this.#agentRunManager.initialize();
		this.#agentTaskService = new AgentTaskService(agentRegistry, this.#agentRunManager, serveRoot);
		await this.#agentTaskService.initialize();
		this.#workflowService = new WorkflowService(join(serveRoot, "workflows"), agentRegistry, this.#agentTaskService, {
			runner: browserWorkflowRunner,
			owner: { kind: "pi-session", id: session.sessionId },
			workspace: { id: session.sessionId, root: session.sessionManager.getCwd() },
		});
		await this.#workflowService.initialize();
		const a2aAdapter = new A2aAdapter(agentRegistry, this.#agentTaskService);

		const availableModels = modelRuntime
			.getAvailableSnapshot()
			.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
		const openAiModels = availableModels.filter((model) => model.provider === "openai");
		const luna = { provider: "openai", id: "gpt-5.6-luna" };
		const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
		const claudeModels = availableModels.filter((model) => model.provider === "anthropic");
		if (!claudeModels.some((model) => model.id === sonnet.id)) {
			claudeModels.unshift({ ...sonnet, name: "Claude Sonnet 5" });
		}
		const hermesModels = [...availableModels];
		if (!hermesModels.some((model) => model.provider === "ollama" && model.id === "qwen3.6:latest")) {
			hermesModels.push({ provider: "ollama", id: "qwen3.6:latest", name: "Qwen 3.6 (Hermes local)" });
		}
		const externalConnections: ExternalConnectionDefinition[] = [
			{
				id: "claude-code",
				name: "Claude Code ACP",
				description: "Delegate a task to Claude Code through the loaded ACP extension.",
				inputLabel: "Task",
				available: session.getToolDefinition("claude_code") !== undefined,
				warning: "Claude Code actions are auto-approved. The selected Claude model is used by the ACP session.",
				defaultModel: sonnet,
				models: claudeModels,
			},
			{
				id: "openai",
				name: "OpenAI Agent",
				description: "Run a separate Pi SDK agent while the main Pi session remains available.",
				inputLabel: "Task",
				available: openAiModels.some((model) => model.id === luna.id),
				warning: "This agent can use file and shell tools in the selected working directory.",
				defaultModel: luna,
				models: openAiModels,
			},
			{
				id: "hermes",
				name: "Hermes Agent",
				description: "Delegate a goal to Hermes one-shot mode with its memory, skills, and tools.",
				inputLabel: "Goal",
				available:
					session.getToolDefinition("hermes_agent") !== undefined &&
					openAiModels.some((model) => model.id === luna.id),
				warning:
					"GPT-5.6 Luna dispatches the request. Hermes uses the selected target model and bypasses interactive approvals.",
				defaultModel: luna,
				models: hermesModels,
			},
		];
		this.#externalSessionExecutor = new AgentSessionExecutor(createExecutionSession);
		this.#externalConnectionManager = new ExternalConnectionManager(
			externalConnections,
			async (request) => {
				const isClaude = request.connection.id === "claude-code";
				const isHermes = request.connection.id === "hermes";
				return this.#externalSessionExecutor!.start({
					runId: request.runId,
					workspace: request.cwd,
					prompt: isClaude
						? `Call claude_code immediately with this exact task, working directory, and model. Return its result without replacing it with your own work.\n\nTask: ${request.prompt}\n\nWorking directory: ${request.cwd}\n\nModel: ${request.model.provider}/${request.model.id}`
						: isHermes
							? `Call hermes_agent immediately with this exact goal, working directory, and model. Return its result without replacing it with your own work.\n\nGoal: ${request.prompt}\n\nWorking directory: ${request.cwd}\n\nModel: ${request.model.provider}/${request.model.id}`
							: request.prompt,
					definition: {
						id: `external-${request.connection.id}`,
						revision: 1,
						source: "managed",
						name: request.connection.name,
						description: request.connection.description,
						model: isClaude ? undefined : isHermes ? luna : request.model,
						thinking: undefined,
						tools: isClaude
							? ["claude_code"]
							: isHermes
								? ["hermes_agent"]
								: ["read", "grep", "find", "ls", "bash", "write", "edit"],
						memory: "none",
						persona: isClaude
							? "Delegate through the claude_code tool immediately and report its returned data."
							: isHermes
								? "Delegate through the hermes_agent tool immediately and report its returned data."
								: "Complete the delegated task independently and return a concise result.",
						projectRoot: request.cwd,
						workspace: request.cwd,
						executor: "session",
						permissionPolicy: "workspace-write",
						schedules: [],
						browserWorkflows: [],
						delegateAgentIds: [],
						a2a: { enabled: false },
					},
				});
			},
			join(serveRoot, "external-runs"),
			session.sessionManager.getCwd(),
		);
		await this.#externalConnectionManager.initialize();

		const routineRegistry = new RoutineRegistry(join(serveRoot, "routines"), (id, version) =>
			browserWorkflowRunner.isActiveVersion(id, version),
		);
		await routineRegistry.initialize();
		this.#agentRoutineScheduler = new AgentRoutineScheduler(routineRegistry, {
			start: async (definition) => {
				if (definition.target.kind === "browser-workflow") {
					const execution = await browserWorkflowRunner.startExecute(
						definition.target.workflowId,
						{
							owner: { kind: "pi-session", id: session.sessionId },
							workspace: { id: session.sessionId, root: session.sessionManager.getCwd() },
							parameters: definition.target.parameters,
						},
						definition.target.workflowVersion,
					);
					return {
						runId: execution.runId,
						cancel: () => execution.cancel(),
						completion: execution.completion.then((completed) =>
							completed.status === "completed"
								? {}
								: { error: completed.error ?? `Browser workflow ${completed.status}` },
						),
					};
				}
				if (definition.target.kind === "agent") {
					const task = await this.#agentTaskService!.submit({
						agentId: definition.target.agentId,
						prompt: definition.prompt,
						source: "routine",
						model: definition.model,
					});
					return {
						runId: task.id,
						cancel: async () => {
							await this.#agentTaskService!.cancel(task.id);
						},
						completion: this.#agentTaskService!.waitForCompletion(task.id).then((completed) =>
							completed.status === "completed"
								? {}
								: { error: completed.error ?? `Agent task ${completed.status}` },
						),
					};
				}
				if (definition.target.kind === "workflow") {
					const run = await this.#workflowService!.start(definition.target.workflowId, definition.prompt);
					return {
						runId: run.id,
						cancel: async () => {
							await this.#workflowService!.cancel(run.id);
						},
						completion: this.#workflowService!.waitForCompletion(run.id).then((completed) =>
							completed.status === "completed"
								? {}
								: { error: completed.error ?? `Workflow ${completed.status}` },
						),
					};
				}
				const connectionId = definition.target.kind === "acp" ? definition.target.connectionId : "openai";
				const prompt =
					definition.target.kind === "skill"
						? `Use the $${definition.target.skillName} skill to complete this routine.\n\n${definition.prompt}`
						: definition.prompt;
				const run = await this.#externalConnectionManager!.start({
					connectionId,
					prompt,
					cwd: definition.cwd,
					model: definition.model,
				});
				return {
					runId: run.id,
					cancel: async () => {
						await this.#externalConnectionManager!.abort(run.id);
					},
					completion: this.#externalConnectionManager!.waitForCompletion(run.id).then((completed) =>
						completed.status === "succeeded"
							? {}
							: { error: completed.error ?? `Delegated run ${completed.status}` },
					),
				};
			},
		});
		await this.#agentRoutineScheduler.start();

		const currentSessionService = new CurrentSessionService(session, Date.now(), async (options) => {
			const agentId = options.name?.startsWith("agent:") ? options.name.slice("agent:".length) : undefined;
			if (agentId) {
				const definition = await agentRegistry.get(agentId);
				if (!definition) throw new Error(`Agent ${agentId} was not found`);
				const workspace = agentRegistry.workspacePath(definition);
				const agentSessionManager = SessionManager.inMemory(workspace, { id: options.id });
				agentSessionManager.appendSessionInfo(`agent:${definition.id}`);
				return createConfiguredAgentSession(definition, workspace, agentSessionManager, {
					kind: "pi-session",
					id: options.id,
				});
			}
			const requestedModel = options.model;
			const hostedModel = requestedModel
				? modelRuntime.getModel(requestedModel.provider, requestedModel.id)
				: session.model;
			if (!hostedModel) throw new Error("No model is available for the browser helper session");
			const hostedCwd = options.cwd ?? session.sessionManager.getCwd();
			const hostedSessionManager = SessionManager.inMemory(hostedCwd, { id: options.id });
			if (options.name) hostedSessionManager.appendSessionInfo(options.name);
			const browserTools = createBrowserTools(this.#browserSessionManager!, {
				owner: { kind: "pi-session", id: options.id },
				workspace: { id: options.id, root: hostedCwd },
				access: "loopback",
				workspacePreview: this.#workspacePreviewServer,
			});
			const browserWorkflowTools = createBrowserWorkflowTools(browserWorkflowRegistry, browserWorkflowRunner, {
				owner: { kind: "pi-session", id: options.id },
				workspace: { id: options.id, root: hostedCwd },
				frontendTests: () =>
					browserWorkflowReferences
						.listFrontendTests(hostedCwd)
						.map((reference) => ({ id: reference.workflowId, version: reference.workflowVersion })),
			});
			return (
				await createAgentSession({
					cwd: hostedCwd,
					agentDir,
					modelRuntime,
					model: hostedModel,
					thinkingLevel: options.thinkingLevel,
					customTools: [...browserTools, ...browserWorkflowTools],
					sessionManager: hostedSessionManager,
				})
			).session;
		});
		this.#attachmentStore = new ServeAttachmentStore();
		const pluginManagement = new PluginManagementService(session, session.sessionManager.getCwd(), agentDir);
		const capabilityCatalog = new CapabilityCatalog(
			session,
			this.#externalConnectionManager,
			browserConsole,
			pluginManagement,
		);
		const listener = new WebSocketListener({
			host,
			port: requestedPort,
			token,
			autoIncrementPort: this.#options.autoIncrementPort,
			onHttpRequest: createServePage(
				token,
				agentRegistry,
				this.#agentRunManager,
				this.#agentRoutineScheduler,
				this.#externalConnectionManager,
				routineRegistry,
				currentSessionService,
				this.#attachmentStore,
				capabilityCatalog,
				browserConsole,
				this.#agentTaskService,
				this.#workflowService,
				personaCatalog,
				a2aAdapter,
				pluginManagement,
			),
			auxiliary: {
				path: "/browser-stream",
				onConnection: (socket) => browserStream.accept(socket),
			},
		});
		this.#server = new PiServer(currentSessionService, {
			listeners: [listener],
			onError: this.#options.onError,
		});
		await this.#server.start();
		const boundPort = listener.port;
		const listenerAddress = listener.address;
		if (boundPort === undefined || listenerAddress === undefined) throw new Error("Serve listener did not bind");

		const diagnostics: ServeHostDiagnostic[] = [];
		if (requestedPort !== 0 && boundPort !== requestedPort) {
			diagnostics.push({ type: "info", message: `Port ${requestedPort} was in use; Pi selected ${boundPort}` });
		}
		const serveUrl = new URL(listenerAddress);
		serveUrl.protocol = serveUrl.protocol === "wss:" ? "https:" : "http:";
		serveUrl.pathname = "/";
		serveUrl.searchParams.set("token", token);
		diagnostics.push({ type: "info", message: `Pi web control: ${serveUrl.href}` });
		return { url: serveUrl.href, port: boundPort, diagnostics };
	}

	async #close(): Promise<void> {
		const disposals: Array<() => Promise<void>> = [
			() => this.#server?.close() ?? Promise.resolve(),
			() => this.#agentRoutineScheduler?.dispose() ?? Promise.resolve(),
			() => this.#agentTaskService?.dispose() ?? Promise.resolve(),
			() => this.#agentRunManager?.dispose() ?? Promise.resolve(),
			() => this.#externalConnectionManager?.dispose() ?? Promise.resolve(),
			() => this.#externalSessionExecutor?.dispose() ?? Promise.resolve(),
			() => this.#attachmentStore?.dispose() ?? Promise.resolve(),
			() => this.#browserSessionManager?.dispose() ?? Promise.resolve(),
			() => this.#workspacePreviewServer?.close() ?? Promise.resolve(),
		];
		const errors: unknown[] = [];
		for (const dispose of disposals) {
			try {
				await dispose();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Failed to close serve host");
	}
}
