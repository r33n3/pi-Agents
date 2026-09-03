import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore, type ModelControls, ModelControlsError } from "@earendil-works/pi-ai";
import { PiServer } from "@earendil-works/pi-server";
import type { AgentSession } from "../agent-session.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { ModelRuntime } from "../model-runtime.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { A2aAdapter } from "./a2a-adapter.ts";
import { AgentBuildLifecycleService } from "./agent-build-lifecycle-service.ts";
import { AgentCollaborationService } from "./agent-collaboration-service.ts";
import { createAgentCollaborationTools } from "./agent-collaboration-tools.ts";
import { type AgentExecutionContext, AgentSessionExecutor } from "./agent-executor.ts";
import { AgentPresentationStore } from "./agent-presentation-store.ts";
import { type AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import { createAgentRegistryTools } from "./agent-registry-tools.ts";
import { AgentRoomService } from "./agent-room-service.ts";
import { AgentRosterProjection } from "./agent-roster-projection.ts";
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
import { CapabilityApprovalService } from "./capability-approval-service.ts";
import { CapabilityBroker } from "./capability-broker.ts";
import { CapabilityCatalog } from "./capability-catalog.ts";
import { CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import { ChildProcessAgentExecutor } from "./child-process-agent-executor.ts";
import { ClaudeSubscriptionLogin } from "./claude-subscription-login.ts";
import { CodexCliExecution, isCodexSubscriptionAvailable } from "./codex-cli-execution.ts";
import { ConversationBuildCoordinator } from "./conversation-build-coordinator.ts";
import { createCredentialApiTools } from "./credential-api-tools.ts";
import { CurrentSessionService } from "./current-session-service.ts";
import { EverydayConfigurationRegistry } from "./everyday-configuration-registry.ts";
import { createEverydayDataTools } from "./everyday-data-tools.ts";
import { type ExternalConnectionDefinition, ExternalConnectionManager } from "./external-connection-manager.ts";
import { GoogleWorkspaceOAuth } from "./google-workspace-oauth.ts";
import { createGoogleWorkspaceTools } from "./google-workspace-tools.ts";
import { GovernedActionService } from "./governed-action-service.ts";
import { createHermesConnectionModels } from "./hermes-connection.ts";
import { InboundRoutingService } from "./inbound-routing-service.ts";
import { PersonaCatalog, resolvePersonaProject } from "./persona-catalog.ts";
import { PiAgentBundleInstaller } from "./pi-agent-bundle.ts";
import { PiAgentTeamLauncher } from "./pi-agent-team-launcher.ts";
import { PlaidConnectionService } from "./plaid-connection.ts";
import { createPlaidTools, PLAID_TOOL_NAMES } from "./plaid-tools.ts";
import { PlaywrightBrowserDriver } from "./playwright-browser-driver.ts";
import { PluginManagementService } from "./plugin-management-service.ts";
import { ProviderEnvironmentStore } from "./provider-environment-store.ts";
import { RoutineRegistry } from "./routine-registry.ts";
import { RunSkillPromotionService } from "./run-skill-promotion-service.ts";
import { createScopedAgentTools } from "./scoped-agent-tools.ts";
import { createSearxngTools } from "./searxng-tools.ts";
import { ServeAttachmentStore } from "./serve-attachment-store.ts";
import { ServeAuditStore } from "./serve-audit-store.ts";
import { acquireServeDirectoryOwnership, type ServeDirectoryOwnership } from "./serve-directory-ownership.ts";
import { createServePage } from "./serve-page.ts";
import { WebSocketListener } from "./websocket-listener.ts";
import { WorkflowService } from "./workflow-service.ts";
import { WorkspacePreviewServer } from "./workspace-preview-server.ts";
import { WtkAgentFactoryClient } from "./wtk-agent-factory-client.ts";

export interface ServeHostOptions {
	agentDir: string;
	session: AgentSession;
	host?: string;
	port?: number;
	/** Optional caller-supplied bearer token for persistent background serve processes. */
	token?: string;
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
	#agentCollaboration: AgentCollaborationService | undefined;
	#agentRoster: AgentRosterProjection | undefined;
	#agentRooms: AgentRoomService | undefined;
	#workflowService: WorkflowService | undefined;
	#agentRoutineScheduler: AgentRoutineScheduler | undefined;
	#externalConnectionManager: ExternalConnectionManager | undefined;
	#externalSessionExecutor: AgentSessionExecutor | undefined;
	#claudeSubscriptionLogin: ClaudeSubscriptionLogin | undefined;
	#providerEnvironment: ProviderEnvironmentStore | undefined;
	#attachmentStore: ServeAttachmentStore | undefined;
	#browserSessionManager: BrowserSessionManager | undefined;
	#workspacePreviewServer: WorkspacePreviewServer | undefined;
	#serveDirectoryOwnership: ServeDirectoryOwnership | undefined;
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
		const configuredToken = this.#options.token?.trim();
		if (configuredToken !== undefined && !/^[A-Za-z0-9_-]{32,128}$/.test(configuredToken)) {
			throw new Error("PI_SERVE_TOKEN must be 32-128 URL-safe characters");
		}
		const token = configuredToken ?? randomBytes(32).toString("base64url");
		const serveRoot = join(agentDir, "serve");
		this.#serveDirectoryOwnership = await acquireServeDirectoryOwnership(serveRoot, (error) => {
			this.#options.onError?.(
				new Error(`Serve directory ownership was compromised: ${error.message}`, { cause: error }),
			);
			void this.close().catch((closeError: unknown) => {
				this.#options.onError?.(closeError instanceof Error ? closeError : new Error(String(closeError)));
			});
		});
		const auditStore = new ServeAuditStore(join(serveRoot, "audit"));
		await auditStore.initialize();
		const governedActions = new GovernedActionService(auditStore);
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
			governedActions,
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
				workspace: {
					id: session.sessionId,
					root: session.sessionManager.getCwd(),
				},
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
				workspace: {
					id: session.sessionId,
					root: session.sessionManager.getCwd(),
				},
				access: ["loopback", "public-web"],
				workspacePreview: this.#workspacePreviewServer,
				workflowCompiler: browserWorkflowCompiler,
			}),
			...createBrowserWorkflowTools(browserWorkflowRegistry, browserWorkflowRunner, {
				owner: { kind: "pi-session", id: session.sessionId },
				workspace: {
					id: session.sessionId,
					root: session.sessionManager.getCwd(),
				},
				frontendTests: () =>
					browserWorkflowReferences.listFrontendTests(session.sessionManager.getCwd()).map((reference) => ({
						id: reference.workflowId,
						version: reference.workflowVersion,
					})),
			}),
		]);
		const everydayConfigurations = new EverydayConfigurationRegistry(
			join(serveRoot, "capabilities", "everyday-data"),
		);
		await everydayConfigurations.initialize();
		const everydayDataTools = createEverydayDataTools(
			join(serveRoot, "capabilities", "everyday-data"),
			everydayConfigurations,
		);
		const brokeredTools = [...everydayDataTools];
		const capabilityConnections = new CapabilityConnectionRegistry(join(serveRoot, "capabilities", "connections"));
		await capabilityConnections.initialize();
		const capabilityApprovals = new CapabilityApprovalService(join(serveRoot, "capabilities", "approvals"));
		await capabilityApprovals.initialize();
		let currentSessionService: CurrentSessionService | undefined;
		let agentCollaborationService: AgentCollaborationService | undefined;
		let providerEnvironment: ProviderEnvironmentStore | undefined;
		const capabilityBroker = new CapabilityBroker(join(serveRoot, "capabilities"), {
			activeToolNames: () => session.getAllTools().map((tool) => tool.name),
			activeProviderSources: () =>
				session.resourceLoader
					.getExtensions()
					.extensions.flatMap((extension) => [
						extension.path,
						extension.resolvedPath,
						extension.sourceInfo?.source ?? "",
					]),
			providerConnectionAvailable: (providerId) =>
				capabilityConnections
					.snapshot()
					.some((connection) => connection.providerId === providerId && connection.status === "active"),
			connectionResolver: (connectionId) => capabilityConnections.find(connectionId),
			environmentValue: (name) => providerEnvironment?.environmentValue(name) ?? process.env[name],
		});
		providerEnvironment = new ProviderEnvironmentStore(
			session.sessionManager.getCwd(),
			(providerId) => capabilityBroker.authenticationManifest(providerId),
			{
				vaultPath: join(agentDir, "credentials", "v1", "vault.json"),
				onProviderChanged: async (providerId, values) => {
					const binding =
						providerId === "openai-api"
							? { runtimeId: "openai", field: "OPENAI_API_KEY" }
							: providerId === "anthropic-api"
								? { runtimeId: "anthropic", field: "ANTHROPIC_API_KEY" }
								: providerId === "amazon-bedrock-api"
									? { runtimeId: "amazon-bedrock", field: "AWS_BEARER_TOKEN_BEDROCK" }
									: undefined;
					if (!binding) return;
					const value = values[binding.field]?.trim();
					if (value) await modelRuntime.setRuntimeApiKey(binding.runtimeId, value);
					else await modelRuntime.removeRuntimeApiKey(binding.runtimeId);
				},
			},
		);
		this.#providerEnvironment = providerEnvironment;
		await providerEnvironment.initialize();
		for (const binding of [
			{ providerId: "openai-api", runtimeId: "openai", field: "OPENAI_API_KEY" },
			{ providerId: "anthropic-api", runtimeId: "anthropic", field: "ANTHROPIC_API_KEY" },
			{ providerId: "amazon-bedrock-api", runtimeId: "amazon-bedrock", field: "AWS_BEARER_TOKEN_BEDROCK" },
		]) {
			const value = providerEnvironment.environmentValue(binding.field)?.trim();
			if (value) await modelRuntime.setRuntimeApiKey(binding.runtimeId, value);
		}
		brokeredTools.push(...createSearxngTools(() => providerEnvironment.environmentValue("SEARXNG_BASE_URL")));
		brokeredTools.push(...createCredentialApiTools((name) => providerEnvironment.environmentValue(name)));
		session.registerCustomTools(brokeredTools);
		await capabilityBroker.initialize();
		const googleWorkspaceOAuth = new GoogleWorkspaceOAuth(providerEnvironment, capabilityConnections, {
			environmentValue: (name) => providerEnvironment?.environmentValue(name),
		});
		const plaidConnections = new PlaidConnectionService(providerEnvironment, capabilityConnections, {
			clientUserId: `pi-session-${session.sessionId}`,
		});
		const plaidToolNames = new Set<string>(PLAID_TOOL_NAMES);
		const sessionPlaidTools = createPlaidTools(plaidConnections, () =>
			capabilityConnections
				.snapshot()
				.filter((connection) => connection.providerId === "plaid" && connection.status === "active")
				.map((connection) => connection.id),
		);
		brokeredTools.push(...sessionPlaidTools);
		session.registerCustomTools(sessionPlaidTools);
		const authorizeGoogleCapability = async (capabilityId: string) => {
			try {
				await capabilityConnections.assertGrant("google-workspace-primary", "google-workspace", capabilityId);
				return { decision: "allow" as const, reason: "Active provider account grant", grant: capabilityId };
			} catch (error) {
				return {
					decision: "deny" as const,
					reason: error instanceof Error ? error.message : "Provider account grant is unavailable",
				};
			}
		};
		const markGoogleConnectionUnhealthy = async () => {
			const connection = await capabilityConnections.get("google-workspace-primary");
			if (!connection || connection.status === "revoked") return;
			await capabilityConnections.save({ ...connection, status: "unhealthy" });
		};
		const createOwnedGoogleWorkspaceTools = (
			owner: { kind: "session" | "agent-run"; id: string },
			identities: { actorId: string; sessionId?: string; agentId?: string; attemptId?: string },
			assertLive: () => void,
		) =>
			createGoogleWorkspaceTools({
				approvals: capabilityApprovals,
				credentials: providerEnvironment,
				governedActions,
				identities,
				approvalOwner: owner,
				authority: { owner, assertLive },
				authorizeCapability: authorizeGoogleCapability,
				markConnectionUnhealthy: markGoogleConnectionUnhealthy,
			});
		const sessionApprovalOwner = { kind: "session" as const, id: session.sessionId };
		const googleWorkspaceTools = createOwnedGoogleWorkspaceTools(
			sessionApprovalOwner,
			{ actorId: "pi-session", sessionId: session.sessionId },
			() => {
				if (!currentSessionService) throw new Error("Session authority is not active");
				currentSessionService.assertActive(session.sessionId);
			},
		);
		brokeredTools.push(...googleWorkspaceTools);
		session.registerCustomTools(googleWorkspaceTools);
		const googleWorkspaceToolNames = new Set(googleWorkspaceTools.map((tool) => tool.name));
		const resolveAgentBrokeredTools = (
			definition: AgentDefinition,
			approvalOwner?: { kind: "session" | "agent-run"; id: string },
			identities?: { actorId: string; sessionId?: string; agentId?: string; attemptId?: string },
		): ToolDefinition[] => {
			const names = new Set(capabilityBroker.resolveToolNames(definition.capabilities, definition.executor));
			for (const name of definition.tools) names.add(name);
			const allowedPlaidConnectionIds = definition.capabilities
				.filter((grant) => grant.providerId === "plaid" && grant.connectionId)
				.map((grant) => grant.connectionId!);
			return [
				...brokeredTools.filter(
					(tool) => !plaidToolNames.has(tool.name) && !googleWorkspaceToolNames.has(tool.name),
				),
				...createPlaidTools(plaidConnections, () => allowedPlaidConnectionIds),
				...(approvalOwner && identities
					? createOwnedGoogleWorkspaceTools(approvalOwner, identities, () => {
							if (approvalOwner.kind === "agent-run") {
								if (!this.#agentRunManager) throw new Error("Agent run authority is not active");
								this.#agentRunManager.assertActive(approvalOwner.id);
								return;
							}
							if (!currentSessionService) throw new Error("Session authority is not active");
							currentSessionService.assertActive(approvalOwner.id);
						})
					: []),
			].filter((tool) => names.has(tool.name));
		};
		const agentRegistry = new AgentRegistry(serveRoot, {
			catalogDirectory: join(agentDir, "agents"),
			personaDirectory: join(agentDir, "personas"),
			defaultWorkspace: session.sessionManager.getCwd(),
			modelCatalog: () =>
				session.modelRuntime.getAvailableSnapshot().map((model) => ({
					provider: model.provider,
					id: model.id,
					name: model.name,
				})),
			modelControlsValidator: (reference, controls) => {
				const model = session.modelRuntime.getModel(reference.provider, reference.id);
				if (!model)
					throw new ModelControlsError(`Agent model ${reference.provider}/${reference.id} is unavailable`);
				session.modelRuntime.validateModelControls(model, controls);
			},
			browserWorkflowCatalog: (id, version) => browserWorkflowRunner.isActiveVersion(id, version),
			capabilityValidator: (grants, executor) => capabilityBroker.validateGrants(grants, executor),
		});
		await agentRegistry.initialize();
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
			executionModelRuntime = modelRuntime,
			modelControls?: ModelControls | null,
		) => {
			const selectedControls = modelControls === undefined ? definition.modelControls : modelControls;
			const requestedModel = definition.model;
			const resolvedAgentModel = requestedModel
				? executionModelRuntime.getModel(requestedModel.provider, requestedModel.id)
				: session.model;
			if (!resolvedAgentModel) {
				throw new Error(
					requestedModel
						? `Agent model ${requestedModel.provider}/${requestedModel.id} is unavailable`
						: "No model is available for the agent run",
				);
			}
			const agentModel = definition.budget?.maxTokens
				? { ...resolvedAgentModel, maxTokens: Math.min(resolvedAgentModel.maxTokens, definition.budget.maxTokens) }
				: resolvedAgentModel;
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
							workflowCompiler: browserWorkflowCompiler,
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
								browserWorkflowReferences.listFrontendTests(workspace).map((reference) => ({
									id: reference.workflowId,
									version: reference.workflowVersion,
								})),
						})
					: [];
			const capabilityTools = capabilityBroker.resolveToolNames(definition.capabilities, definition.executor);
			const approvalOwner =
				browserOwner?.kind === "agent-run"
					? { kind: "agent-run" as const, id: browserOwner.id }
					: browserOwner?.kind === "pi-session"
						? { kind: "session" as const, id: browserOwner.id }
						: undefined;
			const identities =
				approvalOwner?.kind === "agent-run"
					? { actorId: "agent-run", agentId: definition.id, attemptId: approvalOwner.id }
					: approvalOwner
						? { actorId: "pi-session", sessionId: approvalOwner.id }
						: undefined;
			const agentBrokeredTools = resolveAgentBrokeredTools(definition, approvalOwner, identities);
			const agentCollaborationTools =
				browserOwner?.kind === "agent-run" && definition.delegateAgentIds.length > 0
					? createAgentCollaborationTools(
							agentCollaborationService ?? missingAgentCollaborationService(),
							this.#agentTaskService ?? missingAgentTaskService(),
							{ agentId: definition.id, runId: browserOwner.id },
						)
					: [];
			const customTools = [
				...scopedTools,
				...browserTools,
				...browserWorkflowTools,
				...agentBrokeredTools,
				...agentCollaborationTools,
			] as ToolDefinition[];
			const toolNames = isolated
				? customTools.map((tool) => tool.name)
				: [
						...definition.tools.flatMap((tool) =>
							tool === "browser"
								? [...browserTools, ...browserWorkflowTools].map((browserTool) => browserTool.name)
								: [tool === "list" ? "ls" : tool],
						),
						...capabilityTools,
					];
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
				modelRuntime: executionModelRuntime,
				model: agentModel,
				thinkingLevel: selectedControls == null ? definition.thinking : undefined,
				modelControls: selectedControls,
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
		const createOpenAiApiExecutionSession = async (context: Parameters<AgentSessionExecutor["start"]>[0]) => {
			const apiKey = (
				await providerEnvironment.resolveTrusted("openai-api", ["OPENAI_API_KEY"])
			).OPENAI_API_KEY?.trim();
			if (!apiKey) throw new Error("OpenAI API requires OPENAI_API_KEY in project Settings");
			const apiRuntime = await ModelRuntime.create({
				credentials: new InMemoryCredentialStore(),
				modelsPath: join(agentDir, "models.json"),
				refreshOnCreate: false,
			});
			await apiRuntime.setRuntimeApiKey("openai", apiKey);
			return createConfiguredAgentSession(
				context.definition,
				context.workspace,
				undefined,
				{ kind: "agent-run", id: context.runId },
				apiRuntime,
			);
		};
		const executor = new ChildProcessAgentExecutor({
			agentDir,
			serveRoot,
			governedActions,
			defaultModel: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			resolveModelApiKey: async (modelRef) => {
				const workerModel = modelRuntime.getModel(modelRef.provider, modelRef.id);
				if (!workerModel) return undefined;
				return (await modelRuntime.getAuth(workerModel))?.auth.apiKey;
			},
			capabilityTools: (context: AgentExecutionContext) =>
				[
					...resolveAgentBrokeredTools(
						context.definition,
						{ kind: "agent-run", id: context.runId },
						{
							actorId: "agent-run",
							agentId: context.definition.id,
							attemptId: context.runId,
						},
					),
					...(context.definition.delegateAgentIds.length > 0
						? createAgentCollaborationTools(
								agentCollaborationService ?? missingAgentCollaborationService(),
								this.#agentTaskService ?? missingAgentTaskService(),
								{ agentId: context.definition.id, runId: context.runId },
							)
						: []),
				] as ToolDefinition[],
		});
		this.#agentRunManager = new AgentRunManager(agentRegistry, executor, join(serveRoot, "runs"), 4, {
			defaultModel: session.model ? { provider: session.model.provider, id: session.model.id } : undefined,
			resolveCapabilityBindings: (definition) =>
				capabilityBroker.resolveRunBindings(definition.capabilities, definition.executor).map((binding) => ({
					capabilityId: binding.capabilityId,
					capabilityVersion: binding.capabilityVersion,
					providerId: binding.providerId,
					providerDigest: binding.providerDigest,
					connectionId: binding.connectionId,
				})),
			revokeRunApprovals: async (runId, reason) => {
				await capabilityApprovals.revoke({ owner: { kind: "agent-run", id: runId } }, reason);
			},
		});
		await this.#agentRunManager.initialize();
		const agentBuildLifecycle = new AgentBuildLifecycleService(serveRoot, agentRegistry, this.#agentRunManager);
		await agentBuildLifecycle.initialize();
		const conversationBuilds = new ConversationBuildCoordinator(serveRoot, agentBuildLifecycle);
		await conversationBuilds.initialize();
		const runSkillPromotion = new RunSkillPromotionService(
			this.#agentRunManager,
			join(agentDir, "skills"),
			agentBuildLifecycle,
		);
		this.#agentTaskService = new AgentTaskService(agentRegistry, this.#agentRunManager, serveRoot);
		await this.#agentTaskService.initialize({ deferScheduling: true });
		agentCollaborationService = new AgentCollaborationService(
			serveRoot,
			agentRegistry,
			this.#agentRunManager,
			this.#agentTaskService,
			{
				assertLiveSession: (sessionId) => {
					if (!currentSessionService) throw new Error("Session authority is not active");
					currentSessionService.assertActive(sessionId);
				},
			},
		);
		this.#agentCollaboration = agentCollaborationService;
		await agentCollaborationService.initialize();
		const agentPresentation = new AgentPresentationStore(serveRoot);
		await agentPresentation.initialize();
		this.#workflowService = new WorkflowService(join(serveRoot, "workflows"), agentRegistry, this.#agentTaskService, {
			runner: browserWorkflowRunner,
			owner: { kind: "pi-session", id: session.sessionId },
			workspace: {
				id: session.sessionId,
				root: session.sessionManager.getCwd(),
			},
		});
		await this.#workflowService.initialize();
		this.#agentRooms = new AgentRoomService(
			join(serveRoot, "rooms"),
			agentRegistry,
			this.#agentTaskService,
			this.#workflowService,
		);
		await this.#agentRooms.initialize();
		const piAgentBundleInstaller = new PiAgentBundleInstaller(
			join(serveRoot, "agent-package-installs"),
			agentRegistry,
			this.#workflowService,
		);
		await piAgentBundleInstaller.initialize();
		const piAgentTeamLauncher = new PiAgentTeamLauncher(
			piAgentBundleInstaller,
			this.#agentTaskService,
			this.#workflowService,
			capabilityConnections,
		);
		const configuredWtkRoot = providerEnvironment.environmentValue("PI_WTK_ROOT")?.trim();
		const siblingWtkRoot = resolve(session.sessionManager.getCwd(), "..", "WTK-Dev");
		const wtkRoot = configuredWtkRoot || (existsSync(join(siblingWtkRoot, ".wtk")) ? siblingWtkRoot : undefined);
		const wtkAgentFactory = wtkRoot
			? new WtkAgentFactoryClient({
					origin: providerEnvironment.environmentValue("PI_WTK_CONTROL_URL")?.trim() || "http://127.0.0.1:7878",
					root: wtkRoot,
					accessToken: providerEnvironment.environmentValue("WTK_DASHBOARD_ACCESS_TOKEN"),
				})
			: undefined;
		const a2aAdapter = new A2aAdapter(agentRegistry, this.#agentTaskService);

		const availableModels = modelRuntime.getAvailableSnapshot().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
		}));
		const openAiModels = availableModels.filter((model) => model.provider === "openai");
		const luna = { provider: "openai", id: "gpt-5.6-luna" };
		if (!openAiModels.some((model) => model.id === luna.id)) {
			openAiModels.unshift({ ...luna, name: "GPT-5.6 Luna" });
		}
		const codexSubscriptionModelIds = new Set([
			"gpt-5.6-sol",
			"gpt-5.6-terra",
			"gpt-5.6-luna",
			"gpt-5.5",
			"gpt-5.4",
			"gpt-5.4-mini",
			"gpt-5.3-codex-spark",
		]);
		const codexSubscriptionModels = openAiModels.filter((model) => codexSubscriptionModelIds.has(model.id));
		const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
		const claudeModels = availableModels.filter((model) => model.provider === "anthropic");
		if (!claudeModels.some((model) => model.id === sonnet.id)) {
			claudeModels.unshift({ ...sonnet, name: "Claude Sonnet 5" });
		}
		const hermesModels = createHermesConnectionModels({
			HERMES_DEFAULT_MODEL: providerEnvironment.environmentValue("HERMES_DEFAULT_MODEL"),
			HERMES_MODELS: providerEnvironment.environmentValue("HERMES_MODELS"),
			OPENAI_API_KEY: providerEnvironment.environmentValue("OPENAI_API_KEY"),
			ANTHROPIC_API_KEY: providerEnvironment.environmentValue("ANTHROPIC_API_KEY"),
		});
		const claudeSubscriptionLogin = new ClaudeSubscriptionLogin();
		this.#claudeSubscriptionLogin = claudeSubscriptionLogin;
		const externalConnections: ExternalConnectionDefinition[] = [
			{
				id: "claude-code-subscription",
				name: "Claude Code — Subscription",
				description: "Delegate through Claude Code ACP using the Claude subscription login stored by Claude Code.",
				inputLabel: "Task",
				provider: "anthropic",
				authentication: "subscription",
				billing: "subscription",
				get available() {
					return (
						session.getToolDefinition("claude_code") !== undefined &&
						claudeSubscriptionLogin.getStatus().authenticated
					);
				},
				warning:
					"Requires `claude auth login`. ANTHROPIC_API_KEY is removed from this worker so API billing cannot be selected accidentally.",
				defaultModel: sonnet,
				models: claudeModels,
			},
			{
				id: "anthropic-api",
				aliases: ["claude-code"],
				name: "Anthropic — API",
				description: "Delegate through Claude Code ACP using the configured Anthropic API key.",
				inputLabel: "Task",
				provider: "anthropic",
				authentication: "api-key",
				billing: "usage-based",
				get available() {
					return (
						session.getToolDefinition("claude_code") !== undefined &&
						Boolean(providerEnvironment.environmentValue("ANTHROPIC_API_KEY")?.trim())
					);
				},
				warning: "Usage is billed to the Anthropic API account configured by ANTHROPIC_API_KEY.",
				defaultModel: sonnet,
				models: claudeModels,
			},
			{
				id: "codex-subscription",
				name: "Codex — ChatGPT Subscription",
				description: "Run an independent Codex CLI task using the local ChatGPT login.",
				inputLabel: "Task",
				provider: "openai",
				authentication: "subscription",
				billing: "subscription",
				available: isCodexSubscriptionAvailable(),
				warning:
					"Requires `codex login`. OPENAI_API_KEY is removed from this worker so API billing cannot be selected accidentally.",
				defaultModel: luna,
				models: codexSubscriptionModels,
			},
			{
				id: "openai-api",
				aliases: ["openai"],
				name: "OpenAI — API",
				description: "Run a separate Pi SDK agent using the configured OpenAI API account.",
				inputLabel: "Task",
				provider: "openai",
				authentication: "api-key",
				billing: "usage-based",
				get available() {
					return (
						Boolean(providerEnvironment.environmentValue("OPENAI_API_KEY")?.trim()) &&
						openAiModels.some((model) => model.id === luna.id)
					);
				},
				warning: "Usage is billed to the OpenAI API account configured by OPENAI_API_KEY.",
				defaultModel: luna,
				models: openAiModels,
			},
			{
				id: "hermes",
				name: "Hermes Agent",
				description: "Delegate a goal to Hermes one-shot mode with its memory, skills, tools, and selected model.",
				inputLabel: "Goal",
				provider: "hermes",
				authentication: "configured",
				billing: "configured",
				available: session.getToolDefinition("hermes_agent") !== undefined,
				warning:
					"The selected model runs inside Hermes. Local Ollama has no API charge; OpenAI and Anthropic choices use credentials loaded from .env.local. Hermes bypasses interactive approvals.",
				defaultModel: hermesModels.defaultModel,
				models: hermesModels.models,
			},
		];
		this.#externalSessionExecutor = new AgentSessionExecutor(createExecutionSession);
		const externalOpenAiApiExecutor = new AgentSessionExecutor(createOpenAiApiExecutionSession);
		this.#externalConnectionManager = new ExternalConnectionManager(
			externalConnections,
			async (request) => {
				const isClaude = request.connection.provider === "anthropic";
				const isClaudeSubscription = request.connection.id === "claude-code-subscription";
				const isCodexSubscription = request.connection.id === "codex-subscription";
				const isHermes = request.connection.id === "hermes";
				if (isCodexSubscription) {
					return new CodexCliExecution({ cwd: request.cwd, prompt: request.prompt, model: request.model.id });
				}
				const executionExecutor =
					request.connection.id === "openai-api" ? externalOpenAiApiExecutor : this.#externalSessionExecutor!;
				return executionExecutor.start({
					runId: request.runId,
					workspace: request.cwd,
					prompt: isClaude
						? `Call claude_code immediately with this exact task, working directory, model, and authentication profile. Return its result without replacing it with your own work.\n\nTask: ${request.prompt}\n\nWorking directory: ${request.cwd}\n\nModel: ${request.model.provider}/${request.model.id}\n\nAuthentication: ${isClaudeSubscription ? "subscription" : "api-key"}`
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
						capabilities: [],
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

		const routineRegistry = new RoutineRegistry(
			join(serveRoot, "routines"),
			(id, version) => browserWorkflowRunner.isActiveVersion(id, version),
			async (definition) => {
				if (definition.target.kind !== "agent") return;
				const target = await agentRegistry.get(definition.target.agentId);
				if (!target) throw new Error(`Routine agent ${definition.target.agentId} was not found`);
				await agentBuildLifecycle.assertAutomationAllowed(definition.target.agentId);
				capabilityBroker.validateUnattendedGrants(target.capabilities, target.executor);
			},
		);
		await routineRegistry.initialize();
		this.#agentRoutineScheduler = new AgentRoutineScheduler(routineRegistry, {
			start: async (definition) => {
				if (definition.target.kind === "browser-workflow") {
					const execution = await browserWorkflowRunner.startExecute(
						definition.target.workflowId,
						{
							owner: { kind: "pi-session", id: session.sessionId },
							workspace: {
								id: session.sessionId,
								root: session.sessionManager.getCwd(),
							},
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
								: {
										error: completed.error ?? `Browser workflow ${completed.status}`,
									},
						),
					};
				}
				if (definition.target.kind === "agent") {
					await agentBuildLifecycle.assertAutomationAllowed(definition.target.agentId);
					const target = await agentRegistry.get(definition.target.agentId);
					if (!target) throw new Error(`Routine agent ${definition.target.agentId} was not found`);
					capabilityBroker.validateUnattendedGrants(target.capabilities, target.executor);
					const task = await this.#agentTaskService!.submit({
						agentId: definition.target.agentId,
						prompt: definition.prompt,
						source: "routine",
						model: definition.model,
						routine: { id: definition.id, revision: definition.revision, scheduledFor: Date.now() },
						expectedDeliverable: { kind: "markdown", title: `${definition.name} result` },
					});
					return {
						runId: task.id,
						cancel: async () => {
							await this.#agentTaskService!.cancel(task.id);
						},
						completion: this.#agentTaskService!.waitForCompletion(task.id).then((completed) =>
							completed.status === "completed"
								? {}
								: {
										error: completed.error ?? `Agent task ${completed.status}`,
									},
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
								: {
										error: completed.error ?? `Workflow ${completed.status}`,
									},
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
							: {
									error: completed.error ?? `Delegated run ${completed.status}`,
								},
					),
				};
			},
		});
		await this.#agentRoutineScheduler.start();
		this.#agentRoster = new AgentRosterProjection(
			agentRegistry,
			this.#agentTaskService,
			this.#agentRoutineScheduler,
			agentPresentation,
		);
		await this.#agentRoster.initialize();
		await this.#agentTaskService.startScheduling();
		session.registerCustomTools(
			createAgentRegistryTools(agentRegistry, agentBuildLifecycle, {
				promotion: runSkillPromotion,
				routines: routineRegistry,
				refreshRoutines: () => this.#agentRoutineScheduler!.refresh(),
				conversationBuilds,
				sessionId: session.sessionId,
			}) as ToolDefinition[],
		);

		currentSessionService = new CurrentSessionService(
			session,
			Date.now(),
			async (options) => {
				const agentId = options.name?.startsWith("agent:") ? options.name.slice("agent:".length) : undefined;
				if (agentId) {
					const definition = await agentRegistry.get(agentId);
					if (!definition) throw new Error(`Agent ${agentId} was not found`);
					const workspace = agentRegistry.workspacePath(definition);
					const agentSessionManager = SessionManager.inMemory(workspace, {
						id: options.id,
					});
					agentSessionManager.appendSessionInfo(`agent:${definition.id}`);
					return createConfiguredAgentSession(
						{
							...definition,
							...(options.model ? { model: options.model } : {}),
							...(options.thinkingLevel !== undefined
								? { thinking: options.thinkingLevel, modelControls: undefined }
								: {}),
						},
						workspace,
						agentSessionManager,
						{ kind: "pi-session", id: options.id },
						modelRuntime,
						options.modelControls,
					);
				}
				const requestedModel = options.model;
				const hostedModel = requestedModel
					? modelRuntime.getModel(requestedModel.provider, requestedModel.id)
					: session.model;
				if (!hostedModel) throw new Error("No model is available for the browser helper session");
				const hostedCwd = options.cwd ?? session.sessionManager.getCwd();
				const hostedSessionManager = SessionManager.inMemory(hostedCwd, {
					id: options.id,
				});
				if (options.name) hostedSessionManager.appendSessionInfo(options.name);
				const browserTools = createBrowserTools(this.#browserSessionManager!, {
					owner: { kind: "pi-session", id: options.id },
					workspace: { id: options.id, root: hostedCwd },
					access: ["loopback", "public-web"],
					workspacePreview: this.#workspacePreviewServer,
					workflowCompiler: browserWorkflowCompiler,
				});
				const browserWorkflowTools = createBrowserWorkflowTools(browserWorkflowRegistry, browserWorkflowRunner, {
					owner: { kind: "pi-session", id: options.id },
					workspace: { id: options.id, root: hostedCwd },
					frontendTests: () =>
						browserWorkflowReferences.listFrontendTests(hostedCwd).map((reference) => ({
							id: reference.workflowId,
							version: reference.workflowVersion,
						})),
				});
				return (
					await createAgentSession({
						cwd: hostedCwd,
						agentDir,
						modelRuntime,
						model: hostedModel,
						thinkingLevel: options.thinkingLevel,
						modelControls: options.modelControls,
						customTools: [...browserTools, ...browserWorkflowTools],
						sessionManager: hostedSessionManager,
					})
				).session;
			},
			async (sessionId) => {
				try {
					await capabilityApprovals.revoke(
						{ owner: { kind: "session", id: sessionId } },
						`Session ${sessionId} closed`,
					);
				} catch (error) {
					const cause = error instanceof Error ? error : new Error(String(error));
					this.#options.onError?.(
						new Error(`Failed to revoke approvals for closed session ${sessionId}: ${cause.message}`, { cause }),
					);
				}
			},
		);
		const inboundRouting = new InboundRoutingService(
			join(serveRoot, "capabilities", "inbound"),
			capabilityConnections,
			(reference) => {
				if (!reference.startsWith("env:")) return undefined;
				const name = reference.slice("env:".length);
				return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? process.env[name] : undefined;
			},
		);
		await inboundRouting.initialize();
		this.#attachmentStore = new ServeAttachmentStore();
		const pluginManagement = new PluginManagementService(session, session.sessionManager.getCwd(), agentDir);
		const capabilityCatalog = new CapabilityCatalog(
			session,
			this.#externalConnectionManager,
			browserConsole,
			pluginManagement,
			capabilityBroker,
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
				capabilityBroker,
				capabilityConnections,
				capabilityApprovals,
				inboundRouting,
				everydayConfigurations,
				providerEnvironment,
				googleWorkspaceOAuth,
				plaidConnections,
				claudeSubscriptionLogin,
				piAgentBundleInstaller,
				piAgentTeamLauncher,
				wtkAgentFactory,
				runSkillPromotion,
				agentBuildLifecycle,
				this.#agentRoster,
				agentCollaborationService,
				this.#agentRooms,
				session.sessionId,
				conversationBuilds,
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
			diagnostics.push({
				type: "info",
				message: `Port ${requestedPort} was in use; Pi selected ${boundPort}`,
			});
		}
		const serveUrl = new URL(listenerAddress);
		serveUrl.protocol = serveUrl.protocol === "wss:" ? "https:" : "http:";
		serveUrl.pathname = "/";
		serveUrl.searchParams.set("token", token);
		diagnostics.push({
			type: "info",
			message: `Pi web control: ${serveUrl.href}`,
		});
		return { url: serveUrl.href, port: boundPort, diagnostics };
	}

	async #close(): Promise<void> {
		const disposals: Array<() => Promise<void>> = [
			() => this.#server?.close() ?? Promise.resolve(),
			() => this.#agentRooms?.dispose() ?? Promise.resolve(),
			() => this.#agentRoster?.dispose() ?? Promise.resolve(),
			() => this.#agentCollaboration?.dispose() ?? Promise.resolve(),
			() => this.#agentRoutineScheduler?.dispose() ?? Promise.resolve(),
			() => this.#agentTaskService?.dispose() ?? Promise.resolve(),
			() => this.#agentRunManager?.dispose() ?? Promise.resolve(),
			() => this.#externalConnectionManager?.dispose() ?? Promise.resolve(),
			() => this.#externalSessionExecutor?.dispose() ?? Promise.resolve(),
			() => this.#claudeSubscriptionLogin?.dispose() ?? Promise.resolve(),
			() => this.#providerEnvironment?.dispose() ?? Promise.resolve(),
			() => this.#attachmentStore?.dispose() ?? Promise.resolve(),
			() => this.#browserSessionManager?.dispose() ?? Promise.resolve(),
			() => this.#workspacePreviewServer?.close() ?? Promise.resolve(),
			() => this.#serveDirectoryOwnership?.release() ?? Promise.resolve(),
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

function missingAgentCollaborationService(): never {
	throw new Error("Agent collaboration is not initialized");
}

function missingAgentTaskService(): never {
	throw new Error("Agent task service is not initialized");
}
