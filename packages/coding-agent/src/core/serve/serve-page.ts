import type { IncomingMessage, ServerResponse } from "node:http";
import { A2A_MEDIA_TYPE, type A2aAdapter, A2aError, type A2aTask } from "./a2a-adapter.ts";
import type { AgentBuildLifecycleService } from "./agent-build-lifecycle-service.ts";
import type { AgentDefinitionInput, AgentRegistry } from "./agent-registry.ts";
import type { AgentRoutineScheduler } from "./agent-routine-scheduler.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";
import type { AgentTaskService } from "./agent-task-service.ts";
import { SERVE_BROWSER_BUNDLE } from "./browser-bundle.generated.ts";
import type { BrowserConsoleService } from "./browser-console-service.ts";
import type { CapabilityApprovalRequest, CapabilityApprovalService } from "./capability-approval-service.ts";
import type { CapabilityBroker } from "./capability-broker.ts";
import type { CapabilityCatalog } from "./capability-catalog.ts";
import type { CapabilityConnectionInput, CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import { matchesCapabilityToken } from "./capability-token.ts";
import type { ClaudeSubscriptionLogin } from "./claude-subscription-login.ts";
import { nextCronRun } from "./cron-schedule.ts";
import type { CurrentSessionService } from "./current-session-service.ts";
import type { EverydayConfigurationRegistry } from "./everyday-configuration-registry.ts";
import type { ExternalConnectionManager } from "./external-connection-manager.ts";
import type { GoogleWorkspaceOAuth } from "./google-workspace-oauth.ts";
import type { InboundRoute, InboundRoutingService } from "./inbound-routing-service.ts";
import type { PersonaCatalog } from "./persona-catalog.ts";
import { type PiAgentBundleInstaller, parsePiAgentBundleBindings } from "./pi-agent-bundle.ts";
import type { PiAgentTeamLauncher } from "./pi-agent-team-launcher.ts";
import type { PlaidConnectionService } from "./plaid-connection.ts";
import type { PluginManagementService } from "./plugin-management-service.ts";
import type { ProviderEnvironmentStore } from "./provider-environment-store.ts";
import type { RoutineDefinitionInput, RoutineRegistry } from "./routine-registry.ts";
import type { RunSkillPromotionService } from "./run-skill-promotion-service.ts";
import type { ServeAttachment, ServeAttachmentStore } from "./serve-attachment-store.ts";
import type { WorkflowDefinitionInput, WorkflowService } from "./workflow-service.ts";
import type { WtkAgentFactoryClient } from "./wtk-agent-factory-client.ts";

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
} as const;

/** Serves the local console only to callers holding this process's capability token. */
export function createServePage(
	token: string,
	agentRegistry?: AgentRegistry,
	agentRunManager?: AgentRunManager,
	agentRoutineScheduler?: AgentRoutineScheduler,
	externalConnectionManager?: ExternalConnectionManager,
	routineRegistry?: RoutineRegistry,
	currentSessionService?: CurrentSessionService,
	attachmentStore?: ServeAttachmentStore,
	capabilityCatalog?: CapabilityCatalog,
	browserConsole?: BrowserConsoleService,
	agentTaskService?: AgentTaskService,
	workflowService?: WorkflowService,
	personaCatalog?: PersonaCatalog,
	a2aAdapter?: A2aAdapter,
	pluginManagement?: PluginManagementService,
	capabilityBroker?: CapabilityBroker,
	capabilityConnections?: CapabilityConnectionRegistry,
	capabilityApprovals?: CapabilityApprovalService,
	inboundRouting?: InboundRoutingService,
	everydayConfigurations?: EverydayConfigurationRegistry,
	providerEnvironment?: ProviderEnvironmentStore,
	googleWorkspaceOAuth?: GoogleWorkspaceOAuth,
	plaidConnections?: PlaidConnectionService,
	claudeSubscriptionLogin?: ClaudeSubscriptionLogin,
	piAgentBundleInstaller?: PiAgentBundleInstaller,
	piAgentTeamLauncher?: PiAgentTeamLauncher,
	wtkAgentFactory?: WtkAgentFactoryClient,
	runSkillPromotion?: RunSkillPromotionService,
	agentBuildLifecycle?: AgentBuildLifecycleService,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		void serveRequest(
			request,
			response,
			token,
			agentRegistry,
			agentRunManager,
			agentRoutineScheduler,
			externalConnectionManager,
			routineRegistry,
			currentSessionService,
			attachmentStore,
			capabilityCatalog,
			browserConsole,
			agentTaskService,
			workflowService,
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
		).catch((error: unknown) => {
			if (response.headersSent) {
				response.end();
				return;
			}
			json(response, 500, {
				error: error instanceof Error ? error.message : "Internal server error",
			});
		});
	};
}

async function serveRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	agentRegistry: AgentRegistry | undefined,
	agentRunManager: AgentRunManager | undefined,
	agentRoutineScheduler: AgentRoutineScheduler | undefined,
	externalConnectionManager: ExternalConnectionManager | undefined,
	routineRegistry: RoutineRegistry | undefined,
	currentSessionService: CurrentSessionService | undefined,
	attachmentStore: ServeAttachmentStore | undefined,
	capabilityCatalog: CapabilityCatalog | undefined,
	browserConsole: BrowserConsoleService | undefined,
	agentTaskService: AgentTaskService | undefined,
	workflowService: WorkflowService | undefined,
	personaCatalog: PersonaCatalog | undefined,
	a2aAdapter: A2aAdapter | undefined,
	pluginManagement: PluginManagementService | undefined,
	capabilityBroker: CapabilityBroker | undefined,
	capabilityConnections: CapabilityConnectionRegistry | undefined,
	capabilityApprovals: CapabilityApprovalService | undefined,
	inboundRouting: InboundRoutingService | undefined,
	everydayConfigurations: EverydayConfigurationRegistry | undefined,
	providerEnvironment: ProviderEnvironmentStore | undefined,
	googleWorkspaceOAuth: GoogleWorkspaceOAuth | undefined,
	plaidConnections: PlaidConnectionService | undefined,
	claudeSubscriptionLogin: ClaudeSubscriptionLogin | undefined,
	piAgentBundleInstaller: PiAgentBundleInstaller | undefined,
	piAgentTeamLauncher: PiAgentTeamLauncher | undefined,
	wtkAgentFactory: WtkAgentFactoryClient | undefined,
	runSkillPromotion: RunSkillPromotionService | undefined,
	agentBuildLifecycle: AgentBuildLifecycleService | undefined,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (url.pathname === "/capability-oauth/google-workspace/callback") {
		await serveGoogleWorkspaceOAuthCallback(response, url, googleWorkspaceOAuth, token);
		return;
	}
	if (url.pathname.startsWith("/capability-webhooks/")) {
		await serveInboundWebhook(request, response, url, inboundRouting, currentSessionService, agentTaskService);
		return;
	}
	const bearer = bearerToken(request.headers.authorization);
	if (
		!matchesCapabilityToken(token, url.searchParams.get("token")) &&
		!matchesCapabilityToken(token, bearer ?? null)
	) {
		response.writeHead(403, SECURITY_HEADERS).end();
		return;
	}
	if (url.pathname === "/agent-teams" || url.pathname.startsWith("/agent-teams/")) {
		await servePiAgentTeam(request, response, url, piAgentTeamLauncher);
		return;
	}
	if (url.pathname === "/agent-team-factory" || url.pathname.startsWith("/agent-team-factory/")) {
		await serveWtkAgentFactory(request, response, url, wtkAgentFactory, piAgentTeamLauncher);
		return;
	}
	if (url.pathname === "/agent-events") {
		serveAgentEvents(request, response, agentRegistry, agentTaskService);
		return;
	}
	if (url.pathname.startsWith("/a2a/")) {
		await serveA2a(request, response, url, a2aAdapter);
		return;
	}
	if (url.pathname === "/auth/claude-subscription") {
		serveClaudeSubscriptionLogin(request, response, claudeSubscriptionLogin);
		return;
	}
	if (url.pathname === "/credential-vault") {
		await serveCredentialVault(request, response, capabilityBroker, providerEnvironment);
		return;
	}
	if (
		url.pathname === "/agent-packages/review-bindings" ||
		url.pathname === "/agent-packages/validate" ||
		url.pathname === "/agent-packages/install" ||
		url.pathname === "/agent-packages/smoke"
	) {
		await servePiAgentPackage(request, response, url, piAgentBundleInstaller);
		return;
	}
	if (url.pathname === "/plugins.json" || url.pathname.startsWith("/plugins/")) {
		await servePlugins(request, response, url, pluginManagement);
		return;
	}
	if (url.pathname.startsWith("/capability-providers/")) {
		await serveCapabilityProviders(
			request,
			response,
			url,
			capabilityBroker,
			pluginManagement,
			providerEnvironment,
			googleWorkspaceOAuth,
			plaidConnections,
			token,
		);
		return;
	}
	if (url.pathname === "/capability-plaid/link") {
		servePlaidLink(response, url);
		return;
	}
	if (url.pathname === "/plaid-link-client.js") {
		response
			.writeHead(200, {
				...SECURITY_HEADERS,
				"content-type": "text/javascript; charset=utf-8",
			})
			.end(PLAID_LINK_CLIENT);
		return;
	}
	if (url.pathname === "/capability-connections.json" || url.pathname.startsWith("/capability-connections/")) {
		await serveCapabilityConnections(request, response, url, capabilityConnections, agentRoutineScheduler);
		return;
	}
	if (url.pathname === "/capability-approvals.json") {
		await serveCapabilityApprovals(request, response, capabilityApprovals);
		return;
	}
	if (url.pathname === "/capability-inbound-routes.json" || url.pathname.startsWith("/capability-inbound-routes/")) {
		await serveInboundRoutes(request, response, url, inboundRouting);
		return;
	}
	if (url.pathname === "/everyday-configurations.json" || url.pathname.startsWith("/everyday-configurations/")) {
		await serveEverydayConfigurations(request, response, url, everydayConfigurations);
		return;
	}
	if (url.pathname === "/personas.json" || url.pathname.startsWith("/personas/")) {
		await servePersonas(request, response, url, personaCatalog);
		return;
	}
	if (url.pathname === "/attention.json" || url.pathname.startsWith("/attention/")) {
		await serveAttention(request, response, url, agentTaskService);
		return;
	}
	if (url.pathname === "/artifacts.json" || url.pathname === "/artifacts" || url.pathname.startsWith("/artifacts/")) {
		await serveArtifacts(request, response, url, agentTaskService);
		return;
	}
	if (
		url.pathname === "/agent-tasks.json" ||
		url.pathname === "/agent-tasks" ||
		url.pathname.startsWith("/agent-tasks/") ||
		url.pathname === "/agent-conversations.json" ||
		url.pathname.startsWith("/agent-conversations/")
	) {
		await serveAgentTasks(request, response, url, agentTaskService);
		return;
	}
	if (url.pathname === "/workflows.json" || url.pathname === "/workflows" || url.pathname.startsWith("/workflows/")) {
		await serveWorkflows(request, response, url, workflowService);
		return;
	}
	if (url.pathname === "/agents.json" || url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
		await serveAgents(request, response, url, agentRegistry);
		return;
	}
	if (
		url.pathname === "/agent-builds.json" ||
		url.pathname === "/agent-builds" ||
		url.pathname.startsWith("/agent-builds/")
	) {
		await serveAgentBuilds(request, response, url, agentBuildLifecycle);
		return;
	}
	if (url.pathname === "/runs.json" || url.pathname === "/runs" || url.pathname.startsWith("/runs/")) {
		await serveRuns(request, response, url, agentRunManager, runSkillPromotion);
		return;
	}
	if (url.pathname === "/routines.json" || url.pathname === "/routines" || url.pathname.startsWith("/routines/")) {
		await serveRoutines(request, response, url, routineRegistry, agentRoutineScheduler, agentBuildLifecycle);
		return;
	}
	if (url.pathname === "/external-connections.json") {
		if (!externalConnectionManager) json(response, 503, { error: "External connections are unavailable" });
		else if (request.method === "GET") {
			json(response, 200, {
				connections: externalConnectionManager.listConnections(),
			});
		} else response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (url.pathname === "/capabilities.json") {
		if (!capabilityCatalog) json(response, 503, { error: "Capability catalog is unavailable" });
		else if (request.method === "GET") json(response, 200, capabilityCatalog.list());
		else response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (
		url.pathname === "/browser/status" ||
		url.pathname === "/browser/workflows" ||
		url.pathname === "/browser/workflow-runs" ||
		url.pathname.startsWith("/browser/workflow-runs/") ||
		url.pathname === "/browser/frontend-tests" ||
		url.pathname === "/browser/profiles" ||
		url.pathname.startsWith("/browser/profiles/") ||
		url.pathname.startsWith("/browser/workflows/") ||
		url.pathname === "/browser/sessions" ||
		url.pathname.startsWith("/browser/sessions/")
	) {
		await serveBrowser(request, response, url, browserConsole);
		return;
	}
	if (url.pathname === "/attachments" || url.pathname.startsWith("/attachments/")) {
		await serveAttachments(request, response, url, attachmentStore);
		return;
	}
	if (url.pathname === "/session-prompts") {
		await serveSessionPrompt(request, response, currentSessionService, attachmentStore);
		return;
	}
	if (
		url.pathname === "/external-runs.json" ||
		url.pathname === "/external-runs" ||
		url.pathname.startsWith("/external-runs/")
	) {
		await serveExternalRuns(request, response, url, externalConnectionManager);
		return;
	}
	if (request.method !== "GET") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (url.pathname === "/browser-client.js") {
		response
			.writeHead(200, {
				...SECURITY_HEADERS,
				"content-type": "text/javascript; charset=utf-8",
			})
			.end(SERVE_BROWSER_BUNDLE);
		return;
	}
	if (url.pathname !== "/" && url.pathname !== "/index.html") {
		response.writeHead(404, SECURITY_HEADERS).end();
		return;
	}
	response
		.writeHead(200, {
			...SECURITY_HEADERS,
			"content-type": "text/html; charset=utf-8",
		})
		.end(renderPage(encodeURIComponent(token)));
}

async function serveCredentialVault(
	request: IncomingMessage,
	response: ServerResponse,
	broker: CapabilityBroker | undefined,
	credentials: ProviderEnvironmentStore | undefined,
): Promise<void> {
	if (!broker || !credentials) {
		json(response, 503, { error: "Credential vault is unavailable" });
		return;
	}
	const providerIds = broker
		.snapshot()
		.providers.filter((provider) => provider.authentication)
		.map((provider) => provider.id);
	try {
		if (request.method === "GET") {
			response.setHeader("cache-control", "no-store");
			json(response, 200, await credentials.managementStatus(providerIds));
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
			return;
		}
		const body = object(await readJsonBody(request), "credential vault operation");
		const action = requiredString(body.action, "action");
		if (action === "lock") {
			json(response, 200, await credentials.lockVault());
			return;
		}
		assertSecretMutationOrigin(request);
		const passphrase = optionalString(body.passphrase, "passphrase");
		if (action === "initialize") json(response, 200, await credentials.initializeVault(passphrase));
		else if (action === "unlock") json(response, 200, await credentials.unlockVault(passphrase));
		else if (action === "migrate") json(response, 200, await credentials.migrateLegacy(providerIds));
		else if (action === "remove-migrated-legacy") {
			json(response, 200, await credentials.removeMigratedLegacy(providerIds));
		} else throw new Error("Credential vault action is invalid");
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Credential vault operation failed",
			...(error instanceof Error && "code" in error && typeof error.code === "string" ? { code: error.code } : {}),
		});
	}
}

function assertSecretMutationOrigin(request: IncomingMessage): void {
	const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
	if (encrypted || isLoopbackAddress(request.socket.remoteAddress)) return;
	throw new Error("Credential changes require the Pi host or authenticated HTTPS");
}

function isLoopbackAddress(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.toLowerCase();
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function serveAgentEvents(
	request: IncomingMessage,
	response: ServerResponse,
	registry: AgentRegistry | undefined,
	tasks: AgentTaskService | undefined,
): void {
	if (request.method !== "GET" || !registry || !tasks) {
		response.writeHead(registry && tasks ? 405 : 503, SECURITY_HEADERS).end();
		return;
	}
	response.writeHead(200, {
		...SECURITY_HEADERS,
		"content-type": "text/event-stream",
		connection: "keep-alive",
	});
	response.write(": connected\n\n");
	const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
	const unsubscribeRegistry = registry.subscribe(send);
	const unsubscribeTasks = tasks.subscribe(send);
	const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
	heartbeat.unref();
	request.once("close", () => {
		clearInterval(heartbeat);
		unsubscribeRegistry();
		unsubscribeTasks();
	});
}

function serveClaudeSubscriptionLogin(
	request: IncomingMessage,
	response: ServerResponse,
	login: ClaudeSubscriptionLogin | undefined,
): void {
	if (!login) {
		json(response, 503, { error: "Claude subscription login is unavailable" });
		return;
	}
	if (request.method === "GET") {
		json(response, 200, login.getStatus());
		return;
	}
	if (request.method === "POST") {
		json(response, 202, login.start());
		return;
	}
	if (request.method === "DELETE") {
		json(response, 200, login.abort());
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, DELETE" }).end();
}

async function serveCapabilityProviders(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	broker: CapabilityBroker | undefined,
	plugins: PluginManagementService | undefined,
	environment: ProviderEnvironmentStore | undefined,
	googleOAuth: GoogleWorkspaceOAuth | undefined,
	plaid: PlaidConnectionService | undefined,
	capabilityToken: string,
): Promise<void> {
	if (!broker) {
		json(response, 503, { error: "Capability broker is unavailable" });
		return;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 3) {
		json(response, 404, { error: "Capability provider operation not found" });
		return;
	}
	try {
		const providerId = decodeURIComponent(segments[1]);
		const operation = segments[2];
		if (operation === "configuration") {
			if (!environment) throw new Error("Provider environment configuration is unavailable");
			if (request.method === "GET") {
				json(response, 200, await environment.status(providerId));
				return;
			}
			if (request.method === "PUT") {
				assertSecretMutationOrigin(request);
				const input = object(await readJsonBody(request), "provider configuration");
				const values = input.values === undefined ? undefined : stringRecord(input.values, "values");
				const clear = input.clear === undefined ? undefined : stringArray(input.clear, "clear");
				json(response, 200, await environment.configure(providerId, { values, clear }));
				return;
			}
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, PUT" }).end();
			return;
		}
		if (operation === "authorize") {
			if (request.method !== "POST") {
				response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
				return;
			}
			const body = object(await readJsonBody(request), "provider authorization request");
			const capabilities = body.capabilityIds === undefined ? [] : stringArray(body.capabilityIds, "capabilityIds");
			const host = request.headers.host;
			if (!host) throw new Error("Provider authorization requires an HTTP host");
			if (providerId === "google-workspace") {
				if (!googleOAuth) throw new Error("Google Workspace authorization is unavailable");
				json(response, 200, googleOAuth.start(`http://${host}`, capabilities, capabilityToken));
				return;
			}
			if (providerId === "plaid") {
				if (!plaid) throw new Error("Plaid authorization is unavailable");
				const started = await plaid.startLink();
				const authorizationUrl = new URL("/capability-plaid/link", `http://${host}`);
				authorizationUrl.searchParams.set("token", capabilityToken);
				authorizationUrl.searchParams.set("linkToken", started.linkToken);
				json(response, 200, { authorizationUrl: authorizationUrl.href, expiration: started.expiration });
				return;
			}
			throw new Error(`Provider ${providerId} does not support authorization`);
		}
		if (operation === "complete") {
			if (providerId !== "plaid" || !plaid)
				throw new Error(`Provider ${providerId} does not support Link completion`);
			if (request.method !== "POST") {
				response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
				return;
			}
			const body = object(await readJsonBody(request), "Plaid Link completion");
			const institution = body.institution === undefined ? {} : object(body.institution, "Plaid institution");
			json(
				response,
				200,
				await plaid.completeLink(requiredString(body.publicToken, "publicToken"), {
					id: optionalString(institution.id, "Plaid institution ID"),
					name: optionalString(institution.name, "Plaid institution name"),
				}),
			);
			return;
		}
		if (operation === "revoke") {
			if (request.method !== "POST") {
				response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
				return;
			}
			if (providerId === "google-workspace") {
				if (!googleOAuth) throw new Error("Google Workspace authorization is unavailable");
				await googleOAuth.revoke();
				json(response, 200, { revoked: true });
				return;
			}
			if (providerId === "plaid") {
				if (!plaid) throw new Error("Plaid authorization is unavailable");
				json(response, 200, { revoked: await plaid.revokeAll() });
				return;
			}
			throw new Error(`Provider ${providerId} does not support authorization revocation`);
		}
		if (request.method !== "POST") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
			return;
		}
		const body = object(await readJsonBody(request), "capability provider operation");
		const approved = body.approved === true;
		if (operation === "review") json(response, 200, await broker.reviewProvider(providerId, approved));
		else if (operation === "enable") {
			const configured = configuredProviderPlugin(broker, plugins, providerId);
			if (configured) await plugins?.setActive(configured.source, configured.scope, true, approved);
			try {
				json(response, 200, await broker.enableProvider(providerId, approved));
			} catch (error) {
				if (configured) await plugins?.setActive(configured.source, configured.scope, false, approved);
				throw error;
			}
		} else if (operation === "disable") {
			const configured = configuredProviderPlugin(broker, plugins, providerId);
			const result = await broker.disableProvider(providerId, approved);
			if (configured) await plugins?.setActive(configured.source, configured.scope, false, approved);
			json(response, 200, result);
		} else if (operation === "default") {
			await broker.setDefaultProvider(requiredString(body.capabilityId, "capabilityId"), providerId, approved);
			json(response, 200, broker.snapshot());
		} else json(response, 404, { error: "Capability provider operation not found" });
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Capability provider operation failed",
		});
	}
}

async function serveCapabilityConnections(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	registry: CapabilityConnectionRegistry | undefined,
	scheduler: AgentRoutineScheduler | undefined,
): Promise<void> {
	if (!registry) {
		json(response, 503, { error: "Capability connections are unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/capability-connections.json"
			? ""
			: decodeURIComponent(url.pathname.slice("/capability-connections/".length));
	try {
		if (request.method === "GET" && suffix === "") {
			json(response, 200, { connections: registry.snapshot() });
			return;
		}
		if (request.method === "POST" && suffix === "") {
			const saved = await registry.save((await readJsonBody(request)) as CapabilityConnectionInput);
			json(response, 201, saved);
			return;
		}
		if (request.method === "PUT" && suffix !== "") {
			const input = (await readJsonBody(request)) as CapabilityConnectionInput;
			if (input.id !== undefined && input.id !== suffix)
				throw new Error("Connection id does not match the request path");
			json(response, 200, await registry.save({ ...input, id: suffix }));
			return;
		}
		if (request.method === "DELETE" && suffix !== "") {
			if (url.searchParams.get("purge") === "true") {
				const deleted = await registry.deleteRevoked(suffix);
				await scheduler?.refresh();
				json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Connection not found" });
				return;
			}
			const revoked = await registry.revoke(suffix);
			await scheduler?.refresh();
			json(response, 200, revoked);
			return;
		}
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, PUT, DELETE" }).end();
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Capability connection operation failed",
		});
	}
}

async function serveGoogleWorkspaceOAuthCallback(
	response: ServerResponse,
	url: URL,
	oauth: GoogleWorkspaceOAuth | undefined,
	capabilityToken: string,
): Promise<void> {
	try {
		if (!oauth) throw new Error("Google Workspace authorization is unavailable");
		const providerError = url.searchParams.get("error");
		if (providerError) throw new Error(`Google authorization failed: ${providerError}`);
		await oauth.complete(
			requiredString(url.searchParams.get("state"), "OAuth state"),
			requiredString(url.searchParams.get("code"), "OAuth code"),
			capabilityToken,
		);
		response
			.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" })
			.end(
				"<!doctype html><title>Google connected</title><p>Google Workspace is connected. You may close this window.</p>",
			);
	} catch (error) {
		response
			.writeHead(400, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" })
			.end(
				`<!doctype html><title>Google connection failed</title><p>${escapeHtml(error instanceof Error ? error.message : "Google connection failed")}</p>`,
			);
	}
}

async function serveCapabilityApprovals(
	request: IncomingMessage,
	response: ServerResponse,
	approvals: CapabilityApprovalService | undefined,
): Promise<void> {
	if (!approvals) {
		json(response, 503, { error: "Capability approvals are unavailable" });
		return;
	}
	if (request.method === "GET") {
		json(response, 200, { approvals: approvals.list() });
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
		return;
	}
	try {
		const body = object(await readJsonBody(request), "capability approval request");
		const approval: CapabilityApprovalRequest = {
			capabilityId: requiredString(body.capabilityId, "capabilityId"),
			providerId: requiredString(body.providerId, "providerId"),
			connectionId: requiredString(body.connectionId, "connectionId"),
			action: requiredString(body.action, "action"),
			target: requiredString(body.target, "target"),
			expiresInSeconds:
				body.expiresInSeconds === undefined
					? undefined
					: positiveInteger(body.expiresInSeconds, "expiresInSeconds"),
		};
		json(response, 201, await approvals.issue(approval, body.approved === true));
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Capability approval failed",
		});
	}
}

async function serveInboundRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	routing: InboundRoutingService | undefined,
): Promise<void> {
	if (!routing) {
		json(response, 503, { error: "Inbound routing is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/capability-inbound-routes.json"
			? ""
			: decodeURIComponent(url.pathname.slice("/capability-inbound-routes/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { routes: routing.listRoutes() });
		return;
	}
	if (request.method === "DELETE" && suffix !== "") {
		const deleted = await routing.deleteRoute(suffix);
		json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Inbound route not found" });
		return;
	}
	if (request.method !== "POST" || suffix !== "") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, DELETE" }).end();
		return;
	}
	try {
		const body = object(await readJsonBody(request), "inbound route");
		const destination = object(body.destination, "destination");
		if (!Array.isArray(body.allowedSenders)) throw new Error("allowedSenders must be a list");
		const route: InboundRoute = {
			id: requiredString(body.id, "id"),
			connectionId: requiredString(body.connectionId, "connectionId"),
			destination: {
				kind: oneOf(destination.kind, ["agent", "session", "coordinator"], "destination.kind"),
				id: requiredString(destination.id, "destination.id"),
			},
			allowedSenders: body.allowedSenders.map((entry) => requiredString(entry, "allowed sender")),
			maxEventsPerMinute: positiveInteger(body.maxEventsPerMinute, "maxEventsPerMinute"),
			enabled: body.enabled === true,
		};
		json(response, 201, await routing.saveRoute(route));
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Inbound route is invalid" });
	}
}

async function serveEverydayConfigurations(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	registry: EverydayConfigurationRegistry | undefined,
): Promise<void> {
	if (!registry) {
		json(response, 503, { error: "Everyday configurations are unavailable" });
		return;
	}
	if (url.pathname === "/everyday-configurations.json" && request.method === "GET") {
		json(response, 200, registry.snapshot());
		return;
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const kind = segments[1];
	const id = segments[2] === undefined ? undefined : decodeURIComponent(segments[2]);
	if ((kind !== "monitors" && kind !== "watchlists") || segments.length > 3) {
		json(response, 404, { error: "Everyday configuration operation not found" });
		return;
	}
	try {
		if (
			(request.method === "POST" || request.method === "PUT") &&
			(request.method === "POST") === (id !== undefined)
		) {
			json(response, 400, { error: "Configuration path does not match the requested operation" });
			return;
		}
		if (request.method === "POST" || request.method === "PUT") {
			const body = object(await readJsonBody(request), "everyday configuration");
			const configurationId = id ?? requiredString(body.id, "id");
			if (kind === "monitors") {
				json(
					response,
					request.method === "POST" ? 201 : 200,
					await registry.saveMonitor({
						id: configurationId,
						name: requiredString(body.name, "name"),
						url: requiredString(body.url, "url"),
						enabled: body.enabled === true,
					}),
				);
			} else {
				if (!Array.isArray(body.symbols)) throw new Error("symbols must be a list");
				json(
					response,
					request.method === "POST" ? 201 : 200,
					await registry.saveWatchlist({
						id: configurationId,
						name: requiredString(body.name, "name"),
						symbols: body.symbols.map((symbol) => requiredString(symbol, "symbol")),
						providerId: optionalString(body.providerId, "providerId"),
						connectionId: optionalString(body.connectionId, "connectionId"),
						enabled: body.enabled === true,
					}),
				);
			}
			return;
		}
		if (request.method === "DELETE" && id) {
			const deleted = kind === "monitors" ? await registry.deleteMonitor(id) : await registry.deleteWatchlist(id);
			json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Configuration not found" });
			return;
		}
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, PUT, DELETE" }).end();
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Everyday configuration is invalid" });
	}
}

async function serveInboundWebhook(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	routing: InboundRoutingService | undefined,
	sessions: CurrentSessionService | undefined,
	tasks: AgentTaskService | undefined,
): Promise<void> {
	if (request.method !== "POST" || !routing) {
		response.writeHead(routing ? 405 : 503, SECURITY_HEADERS).end();
		return;
	}
	try {
		const routeId = decodeURIComponent(url.pathname.slice("/capability-webhooks/".length));
		const timestamp = requiredString(request.headers["x-pi-timestamp"], "x-pi-timestamp");
		const signature = requiredString(request.headers["x-pi-signature"], "x-pi-signature");
		const event = await routing.accept(routeId, timestamp, signature, await readBody(request, 256 * 1024));
		if (!event) {
			json(response, 200, { duplicate: true });
			return;
		}
		const prompt = `Inbound message from ${event.sender}:\n\n${event.text}`;
		if (event.route.destination.kind === "session") {
			if (!sessions) throw new Error("Pi session routing is unavailable");
			void sessions.promptWithAttachments(event.route.destination.id, prompt, []).catch(() => {});
		} else {
			if (!tasks) throw new Error("Agent routing is unavailable");
			await tasks.submit({ agentId: event.route.destination.id, prompt, source: "a2a" });
		}
		json(response, 202, { accepted: true, eventId: event.id });
	} catch (error) {
		json(response, 401, { error: error instanceof Error ? error.message : "Inbound message was rejected" });
	}
}

function configuredProviderPlugin(
	broker: CapabilityBroker,
	plugins: PluginManagementService | undefined,
	providerId: string,
): { source: string; scope: "user" | "project" } | undefined {
	const provider = broker.snapshot().providers.find((entry) => entry.id === providerId);
	if (!provider || !plugins) return undefined;
	const configured = plugins
		.list()
		.find((entry) => entry.source === provider.source || entry.source.startsWith(`${provider.source}@`));
	return configured && (configured.scope === "user" || configured.scope === "project")
		? { source: configured.source, scope: configured.scope }
		: undefined;
}

async function servePlugins(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: PluginManagementService | undefined,
): Promise<void> {
	if (!service) {
		json(response, 503, { error: "Plugin management is unavailable" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/plugins.json") {
		json(response, 200, { plugins: service.list() });
		return;
	}
	try {
		const body = object(await readJsonBody(request), "plugin operation");
		const source = requiredString(body.source, "source");
		const approved = body.approved === true;
		const scope = oneOf(body.scope ?? "user", ["user", "project"], "scope");
		if (request.method === "POST" && url.pathname === "/plugins/install") {
			await service.install(source, scope, approved);
			json(response, 200, { installed: true });
			return;
		}
		if (request.method === "POST" && url.pathname === "/plugins/remove") {
			json(response, 200, {
				removed: await service.remove(source, scope, approved),
			});
			return;
		}
		if (request.method === "POST" && url.pathname === "/plugins/update") {
			await service.update(source, approved);
			json(response, 200, { updated: true });
			return;
		}
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Plugin operation failed",
		});
	}
}

async function servePersonas(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	catalog: PersonaCatalog | undefined,
): Promise<void> {
	if (!catalog) {
		json(response, 503, { error: "Persona catalog is unavailable" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/personas.json") {
		json(response, 200, { personas: catalog.list() });
		return;
	}
	if (request.method === "GET" && url.pathname.endsWith("/image")) {
		const id = decodeURIComponent(url.pathname.slice("/personas/".length, -"/image".length));
		const image = await catalog.readImage(id);
		if (!image) response.writeHead(404, SECURITY_HEADERS).end();
		else
			response
				.writeHead(200, {
					...SECURITY_HEADERS,
					"content-type": image.contentType,
				})
				.end(image.data);
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
}

async function serveAgentTasks(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: AgentTaskService | undefined,
): Promise<void> {
	if (!service) {
		json(response, 503, { error: "Agent task service is unavailable" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/agent-conversations.json") {
		json(response, 200, {
			conversations: service.listConversations(url.searchParams.get("agentId") ?? undefined),
		});
		return;
	}
	if (
		request.method === "GET" &&
		url.pathname.startsWith("/agent-conversations/") &&
		url.pathname.endsWith("/messages")
	) {
		const id = decodeURIComponent(url.pathname.slice("/agent-conversations/".length, -"/messages".length));
		try {
			json(response, 200, { messages: await service.listMessages(id) });
		} catch (error) {
			json(response, 404, {
				error: error instanceof Error ? error.message : "Conversation not found",
			});
		}
		return;
	}
	const suffix =
		url.pathname === "/agent-tasks.json" || url.pathname === "/agent-tasks"
			? ""
			: decodeURIComponent(url.pathname.slice("/agent-tasks/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, {
			tasks: service.listTasks({
				agentId: url.searchParams.get("agentId") ?? undefined,
				conversationId: url.searchParams.get("conversationId") ?? undefined,
				workflowRunId: url.searchParams.get("workflowRunId") ?? undefined,
			}),
		});
		return;
	}
	if (request.method === "GET" && suffix) {
		const task = service.getTask(suffix);
		json(response, task ? 200 : 404, task ?? { error: "Task not found" });
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const body = object(await readJsonBody(request), "agent task request");
			json(
				response,
				202,
				await service.submit({
					agentId: requiredString(body.agentId, "agentId"),
					prompt: requiredString(body.prompt, "prompt"),
					conversationId: optionalString(body.conversationId, "conversationId"),
					source: oneOf(body.source ?? "chat", ["chat", "pi", "routine", "workflow", "a2a"], "source"),
				}),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid agent task request",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/cancel")) {
		try {
			json(response, 200, await service.cancel(suffix.slice(0, -"/cancel".length)));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not cancel task",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/retry")) {
		try {
			json(response, 202, await service.retry(suffix.slice(0, -"/retry".length)));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not retry task",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/continue")) {
		try {
			const body = object(await readJsonBody(request), "continue task request");
			json(
				response,
				202,
				await service.continue(suffix.slice(0, -"/continue".length), requiredString(body.message, "message")),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Could not continue task",
			});
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveAttention(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: AgentTaskService | undefined,
): Promise<void> {
	if (!service) {
		json(response, 503, { error: "Agent task service is unavailable" });
		return;
	}
	if (request.method === "GET" && url.pathname === "/attention.json") {
		const requestedStatus = url.searchParams.get("status");
		const status =
			requestedStatus === "open" || requestedStatus === "resolved" || requestedStatus === "dismissed"
				? requestedStatus
				: undefined;
		json(response, 200, { items: service.listAttention(status) });
		return;
	}
	if (request.method === "POST" && url.pathname.startsWith("/attention/") && url.pathname.endsWith("/dismiss")) {
		const id = decodeURIComponent(url.pathname.slice("/attention/".length, -"/dismiss".length));
		try {
			json(response, 200, await service.dismissAttention(id));
		} catch (error) {
			json(response, 409, { error: error instanceof Error ? error.message : "Could not dismiss attention item" });
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveArtifacts(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: AgentTaskService | undefined,
): Promise<void> {
	if (!service) {
		json(response, 503, { error: "Artifact service is unavailable" });
		return;
	}
	if (request.method === "GET" && (url.pathname === "/artifacts.json" || url.pathname === "/artifacts")) {
		json(response, 200, {
			artifacts: service.listArtifacts({
				taskId: url.searchParams.get("taskId") ?? undefined,
				agentId: url.searchParams.get("agentId") ?? undefined,
				includeArchived: url.searchParams.get("archived") === "true",
			}),
		});
		return;
	}
	const suffix = decodeURIComponent(url.pathname.slice("/artifacts/".length));
	const [artifactId = "", action] = suffix.split("/", 2);
	if (request.method === "GET" && action === undefined) {
		const artifact = service.getArtifact(artifactId);
		json(response, artifact ? 200 : 404, artifact ?? { error: "Artifact not found" });
		return;
	}
	if (request.method === "GET" && (action === "content" || action === "preview")) {
		const content = await service.readArtifactContent(artifactId, url.searchParams.get("version") ?? undefined);
		if (!content) {
			json(response, 404, { error: "Artifact content not found" });
			return;
		}
		const preview = action === "preview";
		response
			.writeHead(200, {
				...SECURITY_HEADERS,
				"content-type": content.mediaType,
				"content-length": String(content.data.byteLength),
				"content-disposition": `${preview ? "inline" : "attachment"}; filename="${content.fileName.replaceAll('"', "-")}"`,
				"content-security-policy": preview
					? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:"
					: SECURITY_HEADERS["content-security-policy"],
				etag: `"${content.sha256}"`,
			})
			.end(content.data);
		return;
	}
	if (request.method === "POST" && action === "archive") {
		try {
			json(response, 200, await service.archiveArtifact(artifactId));
		} catch (error) {
			json(response, 404, { error: error instanceof Error ? error.message : "Artifact not found" });
		}
		return;
	}
	if (request.method === "POST" && action === "restore") {
		try {
			const body = object(await readJsonBody(request), "artifact restore request");
			json(response, 200, await service.restoreArtifact(artifactId, requiredString(body.versionId, "versionId")));
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : "Could not restore artifact" });
		}
		return;
	}
	if (request.method === "POST" && action === "refresh") {
		try {
			json(response, 202, await service.refreshArtifact(artifactId));
		} catch (error) {
			json(response, 409, { error: error instanceof Error ? error.message : "Could not refresh artifact" });
		}
		return;
	}
	if (request.method === "DELETE" && action === undefined) {
		try {
			await service.deleteArtifact(artifactId);
			response.writeHead(204, SECURITY_HEADERS).end();
		} catch (error) {
			json(response, 404, { error: error instanceof Error ? error.message : "Artifact not found" });
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, DELETE" }).end();
}

async function serveWorkflows(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	service: WorkflowService | undefined,
): Promise<void> {
	if (!service) {
		json(response, 503, { error: "Workflow service is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/workflows.json" || url.pathname === "/workflows"
			? ""
			: decodeURIComponent(url.pathname.slice("/workflows/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, {
			workflows: service.listDefinitions(),
			runs: service.listRuns(),
		});
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			json(response, 201, await service.save((await readJsonBody(request)) as WorkflowDefinitionInput));
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid workflow",
			});
		}
		return;
	}
	if (request.method === "PUT" && suffix && !suffix.endsWith("/run")) {
		try {
			const input = (await readJsonBody(request)) as WorkflowDefinitionInput;
			json(response, 200, await service.save({ ...input, id: suffix }));
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid workflow",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/run")) {
		try {
			const body = object(await readJsonBody(request), "workflow run request");
			json(
				response,
				202,
				await service.start(suffix.slice(0, -"/run".length), requiredString(body.prompt, "prompt")),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Could not start workflow",
			});
		}
		return;
	}
	if (request.method === "DELETE" && suffix) {
		try {
			const deleted = await service.delete(suffix);
			json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Workflow not found" });
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not delete workflow",
			});
		}
		return;
	}
	const definition = service.getDefinition(suffix);
	json(response, definition ? 200 : 404, definition ?? { error: "Workflow not found" });
}

async function serveA2a(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	adapter: A2aAdapter | undefined,
): Promise<void> {
	if (!adapter) {
		a2aError(response, new A2aError("UNAVAILABLE", 503, "A2A adapter is unavailable"));
		return;
	}
	const match = url.pathname.match(/^\/a2a\/agents\/([^/]+)(\/.*)?$/);
	if (!match) {
		a2aError(response, new A2aError("AGENT_NOT_FOUND", 404, "Agent was not found"));
		return;
	}
	const agentId = decodeURIComponent(match[1]!);
	const suffix = match[2] ?? "";
	try {
		if (request.method === "GET" && suffix === "/.well-known/agent-card.json") {
			jsonA2a(
				response,
				200,
				await adapter.agentCard(agentId, `${url.protocol}//${request.headers.host ?? "localhost"}`),
			);
			return;
		}
		adapter.validateVersion(singleHeader(request.headers["a2a-version"]));
		if (request.method === "POST" && (suffix === "/message:send" || suffix === "/message:stream")) {
			if (!singleHeader(request.headers["content-type"])?.toLowerCase().startsWith(A2A_MEDIA_TYPE)) {
				throw new A2aError("INVALID_PARAMS", 415, `Content-Type must be ${A2A_MEDIA_TYPE}`);
			}
			const result = await adapter.sendMessage(agentId, await readJsonBody(request));
			if (suffix === "/message:send") jsonA2a(response, 200, result);
			else await streamA2aTask(request, response, adapter, agentId, result.task);
			return;
		}
		if (request.method === "GET" && suffix === "/tasks") {
			jsonA2a(response, 200, await adapter.listTasks(agentId, url.searchParams.get("status") ?? undefined));
			return;
		}
		const taskMatch = suffix.match(/^\/tasks\/([^/:]+)(?::(cancel|subscribe))?$/);
		if (!taskMatch) throw new A2aError("UNSUPPORTED_OPERATION", 404, "A2A operation was not found");
		const taskId = decodeURIComponent(taskMatch[1]!);
		const action = taskMatch[2];
		if (request.method === "GET" && action === undefined)
			jsonA2a(response, 200, await adapter.getTask(agentId, taskId));
		else if (request.method === "POST" && action === "cancel")
			jsonA2a(response, 200, await adapter.cancelTask(agentId, taskId));
		else if (request.method === "POST" && action === "subscribe")
			await streamA2aTask(request, response, adapter, agentId, await adapter.getTask(agentId, taskId));
		else throw new A2aError("UNSUPPORTED_OPERATION", 405, "HTTP method is not supported for this operation");
	} catch (error) {
		a2aError(
			response,
			error instanceof A2aError
				? error
				: new A2aError("INTERNAL", 500, error instanceof Error ? error.message : "Internal error"),
		);
	}
}

async function streamA2aTask(
	request: IncomingMessage,
	response: ServerResponse,
	adapter: A2aAdapter,
	agentId: string,
	task: A2aTask,
): Promise<void> {
	response.writeHead(200, {
		...SECURITY_HEADERS,
		"content-type": "text/event-stream",
		connection: "keep-alive",
	});
	response.write(`data: ${JSON.stringify({ task })}\n\n`);
	if (["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"].includes(task.status.state)) {
		response.end();
		return;
	}
	const unsubscribe = await adapter.subscribe(agentId, task.id, (next) => {
		response.write(`data: ${JSON.stringify({ task: next })}\n\n`);
		if (["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"].includes(next.status.state)) {
			unsubscribe();
			response.end();
		}
	});
	request.once("close", unsubscribe);
}

function jsonA2a(response: ServerResponse, status: number, value: unknown): void {
	response
		.writeHead(status, { ...SECURITY_HEADERS, "content-type": A2A_MEDIA_TYPE })
		.end(`${JSON.stringify(value)}\n`);
}

function a2aError(response: ServerResponse, error: A2aError): void {
	jsonA2a(response, error.status, {
		error: {
			code: error.status,
			status:
				error.status === 404
					? "NOT_FOUND"
					: error.status === 400 || error.status === 415
						? "INVALID_ARGUMENT"
						: error.status === 503
							? "UNAVAILABLE"
							: "INTERNAL",
			message: error.message,
			details: [
				{
					"@type": "type.googleapis.com/google.rpc.ErrorInfo",
					reason: error.reason,
					domain: "a2a-protocol.org",
				},
			],
		},
	});
}

function bearerToken(value: string | undefined): string | undefined {
	const match = value?.match(/^Bearer\s+(.+)$/i);
	return match?.[1];
}

function singleHeader(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

async function serveBrowser(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	browserConsole: BrowserConsoleService | undefined,
): Promise<void> {
	if (!browserConsole) {
		json(response, 503, { error: "Managed browser is unavailable" });
		return;
	}
	if (url.pathname === "/browser/status") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		json(response, 200, browserConsole.status());
		return;
	}
	if (url.pathname === "/browser/sessions") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		const ownerKind = url.searchParams.get("ownerKind");
		const ownerId = url.searchParams.get("ownerId");
		if ((ownerKind === null) !== (ownerId === null)) {
			json(response, 400, {
				error: "ownerKind and ownerId must be supplied together",
			});
			return;
		}
		if (
			ownerKind !== null &&
			ownerKind !== "pi-session" &&
			ownerKind !== "agent-run" &&
			ownerKind !== "external-run"
		) {
			json(response, 400, { error: "Unsupported browser owner kind" });
			return;
		}
		json(response, 200, {
			sessions: browserConsole.list(ownerKind && ownerId ? { kind: ownerKind, id: ownerId } : undefined),
		});
		return;
	}
	if (url.pathname === "/browser/profiles") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		json(response, 200, { profiles: await browserConsole.listProfiles() });
		return;
	}
	if (url.pathname.startsWith("/browser/profiles/")) {
		if (request.method !== "DELETE") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "DELETE" }).end();
			return;
		}
		try {
			const id = decodeURIComponent(url.pathname.slice("/browser/profiles/".length));
			json(response, (await browserConsole.clearProfile(id)) ? 200 : 404, {
				cleared: true,
			});
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not clear browser profile",
			});
		}
		return;
	}
	if (url.pathname === "/browser/workflows") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		json(response, 200, { workflows: browserConsole.listWorkflows() });
		return;
	}
	if (url.pathname === "/browser/workflow-runs") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		json(response, 200, {
			runs: browserConsole.listWorkflowRuns(url.searchParams.get("workflowId") ?? undefined),
		});
		return;
	}
	if (url.pathname.startsWith("/browser/workflow-runs/")) {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		const segments = url.pathname.slice("/browser/workflow-runs/".length).split("/");
		if (segments.length !== 3 || segments[1] !== "artifacts") {
			response.writeHead(404, SECURITY_HEADERS).end();
			return;
		}
		const png = await browserConsole.readWorkflowArtifact(
			decodeURIComponent(segments[0]!),
			decodeURIComponent(segments[2]!),
		);
		if (!png) response.writeHead(404, SECURITY_HEADERS).end();
		else response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/png" }).end(png);
		return;
	}
	if (url.pathname === "/browser/frontend-tests") {
		if (request.method !== "GET") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
			return;
		}
		json(response, 200, { frontendTests: browserConsole.listFrontendTests() });
		return;
	}
	if (url.pathname.startsWith("/browser/workflows/")) {
		const suffix = decodeURIComponent(url.pathname.slice("/browser/workflows/".length));
		const action = suffix.endsWith("/validate")
			? "validate"
			: suffix.endsWith("/activate")
				? "activate"
				: suffix.endsWith("/run")
					? "run"
					: suffix.endsWith("/create-skill")
						? "create-skill"
						: suffix.endsWith("/frontend-test")
							? "frontend-test"
							: suffix.endsWith("/review")
								? "review"
								: suffix.endsWith("/resolve-target")
									? "resolve-target"
									: undefined;
		const id = action ? suffix.slice(0, -(action.length + 1)) : suffix;
		try {
			if (request.method === "DELETE" && !action) {
				const deleted = await browserConsole.deleteWorkflow(id);
				json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Browser workflow not found" });
				return;
			}
			if (request.method === "GET" && (!action || action === "review")) {
				const versionText = url.searchParams.get("version");
				const version = versionText === null ? undefined : Number(versionText);
				const workflow =
					action === "review"
						? browserConsole.workflowReview(id, version)
						: browserConsole.getWorkflow(id, version);
				json(response, workflow ? 200 : 404, workflow ?? { error: "Browser workflow not found" });
				return;
			}
			if (request.method === "POST" && action) {
				const body = object(await readJsonBody(request), "browser workflow request");
				const parameters = browserWorkflowParameters(body.parameters);
				if (action === "resolve-target") {
					json(
						response,
						200,
						await browserConsole.resolveWorkflowTarget(
							id,
							positiveInteger(body.version, "version"),
							requiredString(body.stepId, "stepId"),
							nonnegativeInteger(body.elementIndex, "elementIndex"),
						),
					);
					return;
				}
				if (action === "run") {
					json(
						response,
						200,
						await browserConsole.executeWorkflow(
							id,
							positiveInteger(body.version, "version"),
							parameters,
							body.approved === true,
						),
					);
					return;
				}
				const version = positiveInteger(body.version, "version");
				if (action === "create-skill") {
					json(response, 201, await browserConsole.createWorkflowSkill(id, version));
					return;
				}
				if (action === "frontend-test") {
					json(response, 201, await browserConsole.attachFrontendTest(id, version));
					return;
				}
				json(
					response,
					200,
					action === "validate"
						? await browserConsole.validateWorkflow(id, version, parameters)
						: await browserConsole.activateWorkflow(id, version),
				);
				return;
			}
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, DELETE" }).end();
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Browser workflow request failed",
			});
		}
		return;
	}
	const suffix = decodeURIComponent(url.pathname.slice("/browser/sessions/".length));
	if (request.method === "POST" && suffix.endsWith("/navigate")) {
		const id = suffix.slice(0, -"/navigate".length);
		try {
			const body = object(await readJsonBody(request), "browser navigation request");
			json(response, 200, await browserConsole.navigate(id, requiredString(body.url, "url")));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not navigate browser session",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/control")) {
		const id = suffix.slice(0, -"/control".length);
		try {
			const body = object(await readJsonBody(request), "browser control request");
			const controlOwner = oneOf(body.controlOwner, ["agent", "user"], "controlOwner");
			json(response, 200, await browserConsole.setControl(id, controlOwner));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not change browser control",
			});
		}
		return;
	}
	if (
		request.method === "POST" &&
		(suffix.endsWith("/back") || suffix.endsWith("/forward") || suffix.endsWith("/reload"))
	) {
		const action = suffix.endsWith("/back") ? "back" : suffix.endsWith("/forward") ? "forward" : "reload";
		const id = suffix.slice(0, -(action.length + 1));
		try {
			const snapshot =
				action === "back"
					? await browserConsole.goBack(id)
					: action === "forward"
						? await browserConsole.goForward(id)
						: await browserConsole.reload(id);
			json(response, 200, snapshot);
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : `Could not ${action} browser session`,
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/input")) {
		const id = suffix.slice(0, -"/input".length);
		try {
			const body = object(await readJsonBody(request, 128 * 1024), "browser input request");
			const kind = oneOf(body.kind, ["click", "type", "scroll"], "kind");
			if (kind === "click") {
				await browserConsole.pointerClick(id, finiteNumber(body.x, "x"), finiteNumber(body.y, "y"));
			} else if (kind === "type") {
				await browserConsole.typeText(id, requiredString(body.text, "text"));
			} else {
				await browserConsole.scroll(id, finiteNumber(body.deltaX, "deltaX"), finiteNumber(body.deltaY, "deltaY"));
			}
			json(response, 202, { accepted: true });
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not send browser input",
			});
		}
		return;
	}
	if (suffix.endsWith("/capture")) {
		const id = suffix.slice(0, -"/capture".length);
		try {
			if (request.method === "POST") {
				json(response, 201, await browserConsole.startCapture(id));
				return;
			}
			if (request.method === "DELETE") {
				json(response, 200, await browserConsole.stopCapture(id));
				return;
			}
			if (request.method === "GET") {
				const capture = browserConsole.getCapture(id);
				json(response, capture ? 200 : 404, capture ?? { error: "Browser session is not recording" });
				return;
			}
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, DELETE" }).end();
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not update browser capture",
			});
		}
		return;
	}
	if (request.method === "GET" && suffix.endsWith("/diagnostics")) {
		const id = suffix.slice(0, -"/diagnostics".length);
		const session = browserConsole.get(id);
		json(
			response,
			session ? 200 : 404,
			session ? browserConsole.diagnostics(id) : { error: "Browser session not found" },
		);
		return;
	}
	if (request.method !== "GET") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
		return;
	}
	if (!suffix.endsWith("/screenshot")) {
		const snapshot = browserConsole.get(suffix);
		json(response, snapshot ? 200 : 404, snapshot ?? { error: "Browser session not found" });
		return;
	}
	const id = suffix.slice(0, -"/screenshot".length);
	if (!browserConsole.get(id)) {
		json(response, 404, { error: "Browser session not found" });
		return;
	}
	try {
		response
			.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/png" })
			.end(await browserConsole.screenshot(id));
	} catch (error) {
		json(response, 409, {
			error: error instanceof Error ? error.message : "Could not capture browser screenshot",
		});
	}
}

async function serveAttachments(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	store: ServeAttachmentStore | undefined,
): Promise<void> {
	if (!store) {
		json(response, 503, { error: "Attachment service is unavailable" });
		return;
	}
	const id =
		url.pathname === "/attachments" ? undefined : decodeURIComponent(url.pathname.slice("/attachments/".length));
	if (request.method === "POST" && !id) {
		try {
			const body = object(await readJsonBody(request, 14 * 1024 * 1024), "attachment request");
			const attachment = await store.save({
				sessionId: requiredString(body.sessionId, "sessionId"),
				name: requiredString(body.name, "name"),
				mimeType: optionalString(body.mimeType, "mimeType"),
				data: requiredString(body.data, "data"),
			});
			json(response, 201, publicAttachment(attachment));
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid attachment",
			});
		}
		return;
	}
	if (request.method === "GET" && id) {
		const attachment = store.get(id);
		if (!attachment) response.writeHead(404, SECURITY_HEADERS).end();
		else {
			const disposition = canPreviewInline(attachment.mimeType) ? "inline" : "attachment";
			response
				.writeHead(200, {
					...SECURITY_HEADERS,
					"content-type": attachment.mimeType,
					"content-disposition": `${disposition}; filename="${attachment.name.replace(/["\\]/g, "_")}"`,
				})
				.end(await store.read(id));
		}
		return;
	}
	if (request.method === "PUT" && id) {
		try {
			const body = object(await readJsonBody(request), "attachment request");
			json(response, 200, publicAttachment(await store.rename(id, requiredString(body.name, "name"))));
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Could not rename attachment",
			});
		}
		return;
	}
	if (request.method === "DELETE" && id) {
		const deleted = await store.delete(id);
		json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Attachment not found" });
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, PUT, DELETE" }).end();
}

function canPreviewInline(mimeType: string): boolean {
	return ["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/pdf"].includes(mimeType);
}

async function serveSessionPrompt(
	request: IncomingMessage,
	response: ServerResponse,
	service: CurrentSessionService | undefined,
	store: ServeAttachmentStore | undefined,
): Promise<void> {
	if (!service || !store) {
		json(response, 503, { error: "Attachment prompts are unavailable" });
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
		return;
	}
	try {
		const body = object(await readJsonBody(request), "session prompt request");
		const sessionId = requiredString(body.sessionId, "sessionId");
		const text = optionalString(body.text, "text") ?? "Please inspect the attached material.";
		if (!Array.isArray(body.attachmentIds) || !body.attachmentIds.every((id) => typeof id === "string")) {
			throw new Error("attachmentIds must be an array of strings");
		}
		const attachments = store.getForSession(sessionId, body.attachmentIds);
		if (attachments.length === 0) throw new Error("At least one attachment is required");
		void service
			.promptWithAttachments(sessionId, text, attachments)
			.catch(() => {})
			.finally(() => Promise.all(attachments.map((attachment) => store.delete(attachment.id))));
		json(response, 202, { accepted: true });
	} catch (error) {
		json(response, 400, {
			error: error instanceof Error ? error.message : "Invalid session prompt",
		});
	}
}

function publicAttachment(attachment: ServeAttachment): Omit<ServeAttachment, "path" | "sessionId"> {
	return {
		id: attachment.id,
		name: attachment.name,
		mimeType: attachment.mimeType,
		size: attachment.size,
	};
}

async function serveRoutines(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	registry: RoutineRegistry | undefined,
	scheduler: AgentRoutineScheduler | undefined,
	agentBuildLifecycle: AgentBuildLifecycleService | undefined,
): Promise<void> {
	if (!registry || !scheduler) {
		json(response, 503, { error: "Routine service is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/routines.json" || url.pathname === "/routines"
			? ""
			: decodeURIComponent(url.pathname.slice("/routines/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { routines: scheduler.list() });
		return;
	}
	if (request.method === "GET" && suffix !== "" && !suffix.endsWith("/run")) {
		const routine = scheduler.list().find((entry) => entry.id === suffix);
		json(response, routine ? 200 : 404, routine ?? { error: "Routine not found" });
		return;
	}
	if (request.method === "POST" && suffix === "preview") {
		try {
			const body = object(await readJsonBody(request), "cron preview request");
			const cron = requiredString(body.cron, "cron");
			const timezone = requiredString(body.timezone, "timezone");
			const next: number[] = [];
			let after = Date.now();
			for (let index = 0; index < 3; index += 1) {
				after = nextCronRun(cron, timezone, after);
				next.push(after);
			}
			json(response, 200, { next });
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid cron schedule",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const { input, automationConfirmed } = routineSaveInput(await readJsonBody(request));
			requireAutomationConfirmation(input, automationConfirmed);
			const saved = await registry.save(input);
			if (saved.enabled && saved.target.kind === "agent") {
				await agentBuildLifecycle?.markAutomated(saved.target.agentId, saved.id);
			}
			await scheduler.refresh();
			json(response, 201, saved);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid routine definition",
			});
		}
		return;
	}
	if (request.method === "PUT" && suffix !== "") {
		try {
			const { input, automationConfirmed } = routineSaveInput(await readJsonBody(request));
			if (input.id !== undefined && input.id !== suffix)
				throw new Error("Routine id does not match the request path");
			requireAutomationConfirmation(input, automationConfirmed);
			const saved = await registry.save({ ...input, id: suffix });
			if (saved.enabled && saved.target.kind === "agent") {
				await agentBuildLifecycle?.markAutomated(saved.target.agentId, saved.id);
			}
			await scheduler.refresh();
			json(response, 200, saved);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid routine definition",
			});
		}
		return;
	}
	if (request.method === "DELETE" && suffix !== "") {
		const deleted = await registry.delete(suffix);
		await scheduler.refresh();
		json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Routine not found" });
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/run")) {
		try {
			json(response, 202, await scheduler.runNow(suffix.slice(0, -"/run".length)));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not start routine",
			});
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, PUT, DELETE" }).end();
}

function routineSaveInput(value: unknown): { input: RoutineDefinitionInput; automationConfirmed: boolean } {
	const body = object(value, "routine definition");
	const automationConfirmed = body.automationConfirmed === true;
	const input = { ...body };
	delete input.automationConfirmed;
	return { input: input as RoutineDefinitionInput, automationConfirmed };
}

function requireAutomationConfirmation(input: RoutineDefinitionInput, automationConfirmed: boolean): void {
	if (input.enabled && input.target.kind === "agent" && !automationConfirmed) {
		throw new Error("Confirm this schedule explicitly before enabling agent automation");
	}
}

async function serveExternalRuns(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	manager: ExternalConnectionManager | undefined,
): Promise<void> {
	if (!manager) {
		json(response, 503, { error: "External connections are unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/external-runs.json" || url.pathname === "/external-runs"
			? ""
			: decodeURIComponent(url.pathname.slice("/external-runs/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { runs: manager.listRuns() });
		return;
	}
	if (request.method === "GET" && suffix.endsWith("/result")) {
		const result = await manager.readResult(suffix.slice(0, -"/result".length));
		if (result === undefined) response.writeHead(404, SECURITY_HEADERS).end();
		else
			response
				.writeHead(200, {
					...SECURITY_HEADERS,
					"content-type": "text/markdown; charset=utf-8",
				})
				.end(result);
		return;
	}
	if (request.method === "GET" && suffix !== "") {
		const run = manager.getRun(suffix);
		json(response, run ? 200 : 404, run ?? { error: "External run not found" });
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const body = object(await readJsonBody(request), "external run request");
			const model = body.model === undefined ? undefined : object(body.model, "model");
			json(
				response,
				202,
				await manager.start({
					connectionId: requiredString(body.connectionId, "connectionId"),
					prompt: requiredString(body.prompt, "prompt"),
					cwd: optionalString(body.cwd, "cwd"),
					model: model
						? {
								provider: requiredString(model.provider, "model.provider"),
								id: requiredString(model.id, "model.id"),
							}
						: undefined,
				}),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid external run request",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/abort")) {
		try {
			json(response, 200, await manager.abort(suffix.slice(0, -"/abort".length)));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not abort external run",
			});
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveRuns(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	runManager: AgentRunManager | undefined,
	runSkillPromotion: RunSkillPromotionService | undefined,
): Promise<void> {
	if (!runManager) {
		json(response, 503, { error: "Agent run manager is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/runs.json" || url.pathname === "/runs"
			? ""
			: decodeURIComponent(url.pathname.slice("/runs/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { runs: runManager.list() });
		return;
	}
	if (request.method === "GET" && suffix.endsWith("/result")) {
		const result = await runManager.readResult(suffix.slice(0, -"/result".length));
		if (result === undefined) response.writeHead(404, SECURITY_HEADERS).end();
		else
			response
				.writeHead(200, {
					...SECURITY_HEADERS,
					"content-type": "text/markdown; charset=utf-8",
				})
				.end(result);
		return;
	}
	if (request.method === "GET" && suffix !== "") {
		const run = runManager.get(suffix);
		json(response, run ? 200 : 404, run ?? { error: "Run not found" });
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const body = object(await readJsonBody(request), "run request");
			json(
				response,
				202,
				await runManager.start(requiredString(body.agentId, "agentId"), requiredString(body.prompt, "prompt")),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid run request",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix === "temporary") {
		try {
			const body = object(await readJsonBody(request), "temporary specialist request");
			json(
				response,
				202,
				await runManager.startTemporarySpecialist(
					requiredString(body.agentId, "agentId"),
					requiredString(body.prompt, "prompt"),
				),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid temporary specialist request",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/promote-skill")) {
		if (!runSkillPromotion) {
			json(response, 503, { error: "Skill promotion is unavailable" });
			return;
		}
		try {
			const body = object(await readJsonBody(request), "skill promotion request");
			json(
				response,
				201,
				await runSkillPromotion.promote({
					runId: suffix.slice(0, -"/promote-skill".length),
					name: requiredString(body.name, "name"),
					description: requiredString(body.description, "description"),
					instructions: requiredString(body.instructions, "instructions"),
				}),
			);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid skill promotion request",
			});
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/abort")) {
		try {
			json(response, 200, await runManager.abort(suffix.slice(0, -"/abort".length)));
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not abort run",
			});
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveAgentBuilds(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	lifecycle: AgentBuildLifecycleService | undefined,
): Promise<void> {
	if (!lifecycle) {
		json(response, 503, { error: "Agent build lifecycle is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/agent-builds.json" || url.pathname === "/agent-builds"
			? ""
			: decodeURIComponent(url.pathname.slice("/agent-builds/".length));
	try {
		if (request.method === "GET" && suffix === "") {
			json(response, 200, { builds: await lifecycle.list() });
			return;
		}
		if (request.method === "POST" && suffix === "draft") {
			const body = object(await readJsonBody(request), "agent build draft");
			json(
				response,
				201,
				await lifecycle.createDraft({
					name: requiredString(body.name, "name"),
					objective: requiredString(body.objective, "objective"),
					projectRoot: requiredString(body.projectRoot, "projectRoot"),
					configuration: body.configuration,
					automationIntent: body.automationIntent,
					criteria: body.criteria,
				}),
			);
			return;
		}
		if (request.method === "POST" && suffix === "for-agent") {
			const body = object(await readJsonBody(request), "agent build lookup");
			json(response, 200, await lifecycle.ensureForAgent(requiredString(body.agentId, "agentId")));
			return;
		}
		if (request.method === "GET" && suffix !== "") {
			json(response, 200, await lifecycle.get(suffix));
			return;
		}
		if (request.method === "PUT" && suffix !== "" && !suffix.includes("/")) {
			const body = object(await readJsonBody(request), "agent build draft");
			json(
				response,
				200,
				await lifecycle.updateDraft(suffix, {
					name: requiredString(body.name, "name"),
					objective: requiredString(body.objective, "objective"),
					projectRoot: requiredString(body.projectRoot, "projectRoot"),
					configuration: body.configuration,
					automationIntent: body.automationIntent,
					criteria: body.criteria,
				}),
			);
			return;
		}
		if (request.method === "POST" && suffix.endsWith("/link-agent")) {
			const body = object(await readJsonBody(request), "agent build link");
			json(
				response,
				200,
				await lifecycle.linkAgent(suffix.slice(0, -"/link-agent".length), requiredString(body.agentId, "agentId")),
			);
			return;
		}
		if (request.method === "POST" && suffix.endsWith("/proof")) {
			const body = object(await readJsonBody(request), "agent build proof");
			json(
				response,
				202,
				await lifecycle.startProof(suffix.slice(0, -"/proof".length), requiredString(body.prompt, "prompt")),
			);
			return;
		}
		if (request.method === "POST" && suffix.endsWith("/proof-review")) {
			const body = object(await readJsonBody(request), "agent build proof review");
			if (typeof body.accepted !== "boolean") throw new Error("accepted must be a boolean");
			json(response, 200, await lifecycle.reviewProof(suffix.slice(0, -"/proof-review".length), body.accepted));
			return;
		}
		if (request.method === "POST" && suffix.endsWith("/feedback")) {
			const body = object(await readJsonBody(request), "agent build feedback");
			json(
				response,
				200,
				await lifecycle.recordFeedback(suffix.slice(0, -"/feedback".length), {
					rating: finiteNumber(body.rating, "rating"),
					summary: requiredString(body.summary, "summary"),
					answers: body.answers,
					criteria: body.criteria,
				}),
			);
			return;
		}
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST, PUT" }).end();
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Invalid agent build request" });
	}
}

async function serveAgents(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	agentRegistry: AgentRegistry | undefined,
): Promise<void> {
	if (!agentRegistry) {
		json(response, 503, { error: "Agent registry is unavailable" });
		return;
	}
	const id =
		url.pathname === "/agents.json" || url.pathname === "/agents"
			? undefined
			: decodeURIComponent(url.pathname.slice("/agents/".length));
	if (request.method === "GET" && id?.endsWith("/icon")) {
		const icon = await agentRegistry.readIcon(id.slice(0, -"/icon".length));
		if (!icon) response.writeHead(404, SECURITY_HEADERS).end();
		else response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/webp" }).end(icon);
		return;
	}
	if (request.method === "GET") {
		if (!id) {
			json(response, 200, { agents: await agentRegistry.list() });
			return;
		}
		const definition = await agentRegistry.get(id);
		json(response, definition ? 200 : 404, definition ?? { error: "Agent not found" });
		return;
	}
	if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
		try {
			const input = (await readJsonBody(request)) as AgentDefinitionInput;
			if (id && input.id !== undefined && input.id !== id)
				throw new Error("Agent id does not match the request path");
			const saved = await agentRegistry.save({ ...input, id: id ?? input.id });
			json(response, request.method === "POST" ? 201 : 200, saved);
		} catch (error) {
			json(response, 400, {
				error: error instanceof Error ? error.message : "Invalid agent definition",
			});
		}
		return;
	}
	if (request.method === "DELETE" && id) {
		try {
			const deleted = await agentRegistry.delete(id);
			json(response, deleted ? 200 : 404, deleted ? { deleted: true } : { error: "Agent not found" });
		} catch (error) {
			json(response, 409, {
				error: error instanceof Error ? error.message : "Could not delete agent",
			});
		}
		return;
	}
	response
		.writeHead(405, {
			...SECURITY_HEADERS,
			allow: id ? "GET, PUT" : "GET, POST",
		})
		.end();
}

async function servePiAgentPackage(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	installer: PiAgentBundleInstaller | undefined,
): Promise<void> {
	if (!installer) {
		json(response, 503, { error: "Pi agent package installer is unavailable" });
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "POST" }).end();
		return;
	}
	try {
		const input = object(await readJsonBody(request, 1024 * 1024), "Pi agent package request");
		if (url.pathname.endsWith("/review-bindings")) {
			json(
				response,
				200,
				installer.reviewBindings(input.bundle, input.bindings, requiredString(input.reviewedBy, "reviewedBy")),
			);
			return;
		}
		if (url.pathname.endsWith("/smoke")) {
			json(
				response,
				200,
				await installer.smoke(requiredString(input.bundleId, "bundleId"), requiredString(input.prompt, "prompt")),
			);
			return;
		}
		const bundle = input.bundle;
		const bindings = input.bindings === undefined ? undefined : parsePiAgentBundleBindings(input.bindings);
		if (url.pathname.endsWith("/validate")) {
			json(response, 200, installer.validate(bundle, bindings));
			return;
		}
		if (!bindings) throw new Error("bindings are required for installation");
		json(response, 201, await installer.install(bundle, bindings));
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Invalid Pi agent package request" });
	}
}

async function servePiAgentTeam(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	launcher: PiAgentTeamLauncher | undefined,
): Promise<void> {
	if (!launcher) {
		json(response, 503, { error: "Pi agent team launcher is unavailable" });
		return;
	}
	try {
		if (request.method === "GET" && url.pathname === "/agent-teams") {
			json(
				response,
				200,
				launcher.state(requiredString(url.searchParams.get("coordinatorAgentId"), "coordinatorAgentId")),
			);
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
			return;
		}
		const input = object(await readJsonBody(request, 1024 * 1024), "Pi agent team request");
		if (url.pathname.endsWith("/prepare")) {
			json(response, 200, launcher.prepare(input.bundle, input.bindings));
			return;
		}
		if (url.pathname.endsWith("/run")) {
			json(
				response,
				202,
				await launcher.run(
					requiredString(input.coordinatorAgentId, "coordinatorAgentId"),
					requiredString(input.prompt, "prompt"),
				),
			);
			return;
		}
		if (url.pathname.endsWith("/cancel")) {
			json(
				response,
				200,
				await launcher.cancel(
					requiredString(input.coordinatorAgentId, "coordinatorAgentId"),
					requiredString(input.runId, "runId"),
				),
			);
			return;
		}
		if (!url.pathname.endsWith("/launch")) throw new Error("Unknown Pi agent team operation");
		json(
			response,
			201,
			await launcher.launch(
				input.bundle,
				input.bindings,
				requiredString(input.approvalDigest, "approvalDigest"),
				requiredString(input.reviewedBy, "reviewedBy"),
			),
		);
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Invalid Pi agent team request" });
	}
}

async function serveWtkAgentFactory(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	factory: WtkAgentFactoryClient | undefined,
	launcher: PiAgentTeamLauncher | undefined,
): Promise<void> {
	if (!factory || !launcher) {
		json(response, url.pathname === "/agent-team-factory" ? 200 : 503, {
			configured: false,
			available: false,
			message: "Canonical WTK builder is not configured",
		});
		return;
	}
	try {
		if (request.method === "GET" && url.pathname === "/agent-team-factory") {
			json(response, 200, await factory.status());
			return;
		}
		if (request.method === "GET" && url.pathname.endsWith("/operation")) {
			json(response, 200, await factory.operation(requiredString(url.searchParams.get("id"), "id")));
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
			return;
		}
		const input = object(await readJsonBody(request, 64 * 1024), "WTK agent factory request");
		if (url.pathname.endsWith("/operation/control")) {
			const action = requiredString(input.action, "action");
			if (action !== "cancel" && action !== "pause" && action !== "resume" && action !== "steer") {
				throw new Error("action must be cancel, pause, resume, or steer");
			}
			json(
				response,
				200,
				await factory.controlOperation(
					requiredString(input.operationId, "operationId"),
					action,
					optionalString(input.message, "message"),
				),
			);
			return;
		}
		if (url.pathname.endsWith("/intake/start")) {
			json(response, 202, await factory.startIntake(requiredString(input.input, "input")));
			return;
		}
		if (url.pathname.endsWith("/intake/message")) {
			json(
				response,
				202,
				await factory.continueIntake(
					requiredString(input.sessionId, "sessionId"),
					requiredString(input.input, "input"),
				),
			);
			return;
		}
		if (url.pathname.endsWith("/research")) {
			json(response, 202, await factory.research(requiredString(input.goalRecordPath, "goalRecordPath")));
			return;
		}
		if (url.pathname.endsWith("/build")) {
			json(
				response,
				202,
				await factory.build(requiredString(input.pkgId, "pkgId"), requiredString(input.handoffPath, "handoffPath")),
			);
			return;
		}
		if (url.pathname.endsWith("/deliver")) {
			json(response, 202, await factory.deliver(requiredString(input.pkgId, "pkgId")));
			return;
		}
		if (url.pathname.endsWith("/prepare")) {
			const model = object(input.model, "model");
			json(
				response,
				200,
				launcher.prepareWithLocalDefaults(
					await factory.loadBundle(requiredString(input.pkgId, "pkgId")),
					requiredString(input.projectRoot, "projectRoot"),
					{ provider: requiredString(model.provider, "model.provider"), id: requiredString(model.id, "model.id") },
				),
			);
			return;
		}
		throw new Error("Unknown WTK agent factory operation");
	} catch (error) {
		json(response, 400, { error: error instanceof Error ? error.message : "Invalid WTK agent factory request" });
	}
}

async function readJsonBody(request: IncomingMessage, maximumBytes = 64 * 1024): Promise<unknown> {
	return JSON.parse((await readBody(request, maximumBytes)).toString("utf8"));
}

function servePlaidLink(response: ServerResponse, url: URL): void {
	const linkToken = requiredString(url.searchParams.get("linkToken"), "Plaid Link token");
	const capabilityToken = requiredString(url.searchParams.get("token"), "Pi capability token");
	response
		.writeHead(200, {
			...SECURITY_HEADERS,
			"content-security-policy":
				"default-src 'self'; connect-src 'self' https://*.plaid.com; img-src 'self' data: https://*.plaid.com; script-src 'self' https://cdn.plaid.com; style-src 'unsafe-inline'; frame-src https://*.plaid.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
			"content-type": "text/html; charset=utf-8",
		})
		.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect financial account</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#0b0b0d;color:#f2f2f4;font:16px system-ui}.card{max-width:28rem;padding:2rem;border:1px solid #303038;border-radius:1rem;background:#18181c;text-align:center}.muted{color:#a5a5ae}</style></head>
<body data-link-token="${escapeHtml(linkToken)}" data-capability-token="${escapeHtml(capabilityToken)}"><main class="card"><h1>Connect financial account</h1><p id="plaid-status" class="muted">Opening Plaid Link…</p></main><script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script><script src="/plaid-link-client.js?token=${escapeHtml(capabilityToken)}"></script></body></html>`);
}

const PLAID_LINK_CLIENT = `"use strict";
(() => {
  const status = document.getElementById("plaid-status");
  const linkToken = document.body.dataset.linkToken;
  const capabilityToken = document.body.dataset.capabilityToken;
  const fail = (message) => { if (status) status.textContent = message; };
  if (!linkToken || !capabilityToken || !window.Plaid) { fail("Plaid Link could not start."); return; }
  const handler = window.Plaid.create({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      fail("Securing account connection…");
      try {
        const response = await fetch("/capability-providers/plaid/complete?token=" + encodeURIComponent(capabilityToken), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ publicToken, institution: metadata.institution ?? {} })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload && payload.error ? payload.error : "Connection failed");
        fail("Financial account connected. This window will close.");
        if (window.opener) window.opener.postMessage({ type: "pi-provider-connected", providerId: "plaid" }, location.origin);
        window.setTimeout(() => window.close(), 600);
      } catch (error) { fail(error instanceof Error ? error.message : "Connection failed"); }
    },
    onExit: (error) => { if (error) fail(error.display_message || error.error_message || "Plaid Link closed with an error"); }
  });
  handler.open();
})();`;

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
	let length = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > maximumBytes) throw new Error(`Request body exceeds ${Math.floor(maximumBytes / 1024)} KiB`);
		chunks.push(buffer);
	}
	if (length === 0) throw new Error("Request body is required");
	return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response
		.writeHead(status, {
			...SECURITY_HEADERS,
			"content-type": "application/json; charset=utf-8",
		})
		.end(`${JSON.stringify(value)}\n`);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function stringRecord(value: unknown, name: string): Record<string, string> {
	const input = object(value, name);
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(input)) {
		if (typeof entry !== "string") throw new Error(`${name}.${key} must be a string`);
		result[key] = entry;
	}
	return result;
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new Error(`${name} must be a list of strings`);
	}
	return value;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		if (character === "&") return "&amp;";
		if (character === "<") return "&lt;";
		if (character === ">") return "&gt;";
		if (character === '"') return "&quot;";
		return "&#39;";
	});
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, name);
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	return value;
}

function positiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
	return Number(value);
}

function nonnegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a nonnegative integer`);
	return Number(value);
}

function browserWorkflowParameters(value: unknown): Record<string, string | number | boolean> {
	if (value === undefined) return {};
	const input = object(value, "browser workflow parameters");
	const parameters: Record<string, string | number | boolean> = {};
	for (const [name, entry] of Object.entries(input)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new Error("Browser workflow parameter name is invalid");
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`Browser workflow parameter ${name} must be a string, number, or boolean`);
		}
		parameters[name] = entry;
	}
	return parameters;
}

function oneOf<const T extends string>(value: unknown, choices: readonly T[], name: string): T {
	if (typeof value !== "string" || !choices.includes(value as T)) {
		throw new Error(`${name} must be one of: ${choices.join(", ")}`);
	}
	return value as T;
}

function renderPage(token: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23101012'/%3E%3Ctext x='7' y='25' fill='%237eb5f5' font-size='25'%3Eπ%3C/text%3E%3C/svg%3E"><title>π Agents</title>
<style>
.thinking-activity{margin:0 0 12px;color:var(--muted)}.thinking-activity summary{display:flex;width:fit-content;align-items:center;gap:5px;cursor:pointer;font-size:12px;font-style:italic;list-style:none}.thinking-activity summary::-webkit-details-marker{display:none}.thinking-activity summary:before{content:"›";font-style:normal;transition:transform .15s}.thinking-activity[open] summary:before{transform:rotate(90deg)}.thinking-body{margin:8px 0 0 8px;padding-left:11px;border-left:2px solid var(--line);white-space:pre-wrap;font-style:italic}.thinking-dots{display:none;align-items:center;gap:3px}.thinking-activity.is-streaming .thinking-dots{display:inline-flex}.thinking-dots i{width:3px;height:3px;border-radius:50%;background:currentColor;animation:thinking-pulse 1.1s infinite ease-in-out}.thinking-dots i:nth-child(2){animation-delay:.16s}.thinking-dots i:nth-child(3){animation-delay:.32s}@keyframes thinking-pulse{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}
:root{color-scheme:dark;--bg:#09090a;--panel:#101012;--surface:#1a1a1e;--surface2:#24242a;--line:#2d2d33;--text:#f2f2f3;--muted:#92929b;--pi:#7eb5f5;--danger:#ef4444;--rail-width:256px;--details-width:360px}*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:var(--rail-width) 5px minmax(420px,1fr) 5px var(--details-width)}button,textarea,select,input{font:inherit}button{cursor:pointer}.hidden{display:none!important}.muted{color:var(--muted)}.rail,.details{position:relative;min-width:0;min-height:0;background:var(--panel);overflow:hidden}.rail{display:flex;flex-direction:column;padding:14px}.details{display:flex;flex-direction:column;padding:14px}.pi-watermark{position:absolute;z-index:0;left:-24px;bottom:-58px;color:var(--pi);font:italic 900 260px/1 "Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif;letter-spacing:-.18em;opacity:.045;transform:rotate(-11deg) scaleX(.86);user-select:none;pointer-events:none;filter:blur(.2px)}.rail-tabs,.tabs,.builder-tabs{position:relative;z-index:1;display:flex;gap:4px;border-bottom:1px solid var(--line)}.rail-tabs{margin-bottom:12px}.rail-tabs button,.tabs button,.builder-tabs button{flex:1;background:transparent;border:0;color:var(--muted);padding:10px 7px}.rail-tabs button.active,.tabs button.active,.builder-tabs button.active{color:var(--text);border-bottom:2px solid var(--pi)}.rail-panel,.details [data-panel],.builder-panel{position:relative;z-index:1;min-height:0;overflow:auto;scrollbar-gutter:stable}.rail-panel{flex:1}.section-title{margin:18px 8px 8px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.12em}.nav-item,.card{background:color-mix(in srgb,var(--surface) 92%,transparent);border:1px solid transparent;border-radius:11px;padding:12px;margin-top:8px}.nav-item{display:block;width:100%;color:var(--text);text-align:left}.nav-item:hover{background:var(--surface2)}.nav-item.active{background:var(--surface2);border-color:#3b3b44}.nav-item:disabled{opacity:.45;cursor:not-allowed}.session-entry strong,.session-entry span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-entry span{margin-top:4px;font-size:11px}.connection-group{margin:14px 0}.connection-heading{display:flex;align-items:center;gap:7px;padding:0 7px;color:var(--muted);font-size:11px}.connection-heading i{width:7px;height:7px;border-radius:50%;background:#43c58a}.connection-heading button{margin-left:auto;background:transparent;border:0;color:var(--muted);font-size:17px}.new-agent{color:var(--pi)}#connection-form{display:grid;gap:8px;margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:11px;background:rgba(15,15,17,.75)}#connection-form label{font-size:11px;color:var(--muted)}#connection-url{width:100%;margin-top:5px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}#connection-form button,.secondary-action{border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--text);padding:9px}.resizer{position:relative;z-index:20;background:var(--line);cursor:col-resize;touch-action:none}.resizer:hover,.resizer.dragging{background:var(--pi)}main{display:flex;flex-direction:column;min-width:0;min-height:0;background:radial-gradient(circle at 50% 18%,rgba(126,181,245,.035),transparent 38%)}.header{min-height:59px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line)}.session-tabs{display:flex;gap:5px;min-width:0;overflow-x:auto;scrollbar-width:none}.session-tabs::-webkit-scrollbar{display:none}.session-tab{max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;color:var(--muted);border:1px solid transparent;border-radius:8px;padding:8px 11px}.session-tab.active{background:var(--surface);border-color:var(--line);color:var(--text)}#session-path{margin-left:auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Consolas,monospace}#transcript{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:30px max(28px,calc((100% - 860px)/2));scrollbar-gutter:stable}.message{white-space:pre-wrap;line-height:1.65;margin:0 0 20px;padding:0;max-width:820px}.message.assistant{margin-right:auto}.message.user{width:fit-content;max-width:min(76%,720px);margin-left:auto;background:#202d3d;border:1px solid #2e4057;border-radius:18px 18px 5px 18px;padding:12px 16px}.message.tool{border:1px solid var(--line);border-radius:10px;background:rgba(20,20,23,.7);color:var(--muted);font-size:12px;padding:11px 13px}.message-label{text-transform:uppercase;letter-spacing:.1em;color:var(--pi);font-size:9px;font-weight:700;margin-bottom:7px}.message.user .message-label{display:none}.thinking{color:var(--muted);font-style:italic;border-left:2px solid var(--line);padding-left:11px}.tool-call{color:#c4a7e7}.chat-dock{padding:8px max(18px,calc((100% - 900px)/2)) 18px;background:linear-gradient(transparent,var(--bg) 18%)}.controls{display:flex;align-items:center;gap:9px;padding:4px 8px 8px;color:var(--muted);font-size:11px}.controls label{display:flex;align-items:center;gap:5px}.controls select{max-width:210px;background:transparent;color:var(--muted);border:0;padding:4px}.controls #phase{margin-left:auto;text-transform:capitalize}#composer{display:flex;align-items:flex-end;gap:8px;padding:8px;background:var(--surface);border:1px solid #3a3a42;border-radius:19px;box-shadow:0 14px 40px rgba(0,0,0,.32)}#prompt{flex:1;resize:none;min-height:44px;max-height:180px;background:transparent;color:var(--text);border:0;outline:0;padding:11px 9px;line-height:1.5;overflow-y:auto}#composer-action{flex:0 0 42px;width:42px;height:42px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--text);color:var(--bg);transition:background .16s,transform .16s}#composer-action:hover{transform:scale(1.04)}#composer-action svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}#composer-action .stop-icon{display:none;width:13px;height:13px;border-radius:2px;background:white}#composer-action.is-stopping{background:var(--danger);color:white}#composer-action.is-stopping .send-icon{display:none}#composer-action.is-stopping .stop-icon{display:block}#composer-action:disabled{opacity:.35;cursor:default;transform:none}.composer-meta{display:flex;align-items:center;gap:12px;min-height:20px;padding:6px 8px 0;color:var(--muted);font:10px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}.composer-meta #status{min-width:0;overflow:hidden;text-overflow:ellipsis}.composer-meta #status.error{color:var(--danger)}#session-stats{margin-left:auto;overflow:hidden;text-overflow:ellipsis}.tabs{flex:0 0 auto;margin-bottom:14px}.details [data-panel]{flex:1}.card strong{display:block;margin-bottom:6px}.builder-tabs{margin:4px 0 12px}.builder-panel{max-height:calc(100vh - 120px)}#agent-form,#run-form,#external-run-form{display:grid;gap:10px}#agent-form label,#run-form label,#external-run-form label{display:grid;gap:5px;color:var(--muted);font-size:11px}#agent-form input,#agent-form textarea,#agent-form select,#run-form textarea,#run-form select,#builder-prompt,#external-run-form input,#external-run-form textarea,#external-run-form select{width:100%;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}#agent-form button,#run-form button,#builder-chat-form button,#external-run-form button{background:var(--pi);color:#07101b;border:0;border-radius:8px;padding:10px;font-weight:700}.external-warning{color:#e4ba68;font-size:11px;line-height:1.45}.external-result{white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#131316}.result-actions{display:flex;gap:7px}.result-actions button{flex:1;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text);padding:7px}.result-actions button.abort{color:var(--danger);border-color:var(--danger)}#builder-chat{height:calc(100vh - 310px);min-height:220px;overflow:auto;overscroll-behavior:contain;padding:4px;scrollbar-gutter:stable}#builder-chat .message{max-width:100%;margin-bottom:13px;font-size:12px}#builder-chat .message.user{padding:9px 11px}#builder-chat-form{display:grid;gap:8px;margin-top:10px}.run-card button{margin-top:8px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:6px;padding:5px}.run-error{color:var(--danger)}@media(max-width:1050px){:root{--rail-width:210px;--details-width:310px}}@media(max-width:820px){body{grid-template-columns:190px 4px minmax(0,1fr)}.details,.right-resizer{display:none}.left-resizer{display:block}}@media(max-width:620px){body{display:block}.rail,.resizer{display:none}main{height:100dvh}#transcript{padding:20px 16px}.header{padding:0 9px}.chat-dock{padding:6px 10px 12px}.controls,.composer-meta{overflow-x:auto}}
@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse){#prompt{max-height:112px}}
#agent-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.agent-entry{display:flex;min-width:0;flex-direction:column;align-items:center;gap:7px;margin-top:0;padding:7px;text-align:center}.agent-icon{display:grid;width:100%;aspect-ratio:1;place-items:center;object-fit:cover;border-radius:8px;background:var(--surface2);color:var(--pi);font:700 34px/1 Georgia,serif}.agent-name{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.session-row{display:flex;align-items:center;gap:6px;padding:4px}.session-row:hover{background:var(--surface2)}.session-select{min-width:0;flex:1;background:transparent;border:0;color:var(--text);text-align:left;padding:8px}.session-select.active{color:var(--pi)}.session-rename{background:transparent;border:0;color:var(--muted);font-size:10px;padding:7px 4px}.session-rename:hover{color:var(--text)}
.external-connection-entry{display:flex;width:100%;min-width:0;align-items:center;gap:8px;padding:7px;overflow:hidden}.external-connection-icon{width:32px;height:32px;flex:0 0 32px;padding:6px;border-radius:8px;color:#fff}.external-connection-icon[data-provider="anthropic"]{background:#d97757}.external-connection-icon[data-provider="openai"]{background:#171c1b}.external-connection-icon[data-provider="hermes"]{background:#49347a;color:#f2d58b}.external-connection-copy{min-width:0;max-width:100%;overflow:hidden}.external-connection-entry strong,.external-connection-entry span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.external-connection-entry strong{font-size:12px}.external-connection-entry span{margin-top:2px;font-size:10px}.external-auth-flow{margin-top:10px}.external-auth-flow p{margin:7px 0}.external-auth-actions{display:flex;gap:8px;align-items:center}.external-auth-actions a{display:inline-flex;align-items:center;min-height:34px;padding:0 12px;border:1px solid var(--accent);border-radius:8px;color:var(--accent);text-decoration:none}.external-chat-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 16px}.external-chat-turn{margin:0 0 18px}.external-chat-user{width:fit-content;max-width:min(760px,86%);margin-left:auto;padding:12px 16px;border-radius:16px 16px 4px 16px;background:#203044}.external-chat-agent{padding:14px 0}.external-chat-state{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.agent-chat-composer{display:flex!important;align-items:flex-end;gap:7px;padding:7px;border:1px solid #3a3a42;border-radius:15px;background:var(--surface)}.agent-chat-composer #builder-prompt{min-height:42px;max-height:120px;resize:none;border:0;background:transparent;outline:0}.agent-chat-composer button{width:38px;height:38px;flex:0 0 38px;padding:0!important;border-radius:50%!important;font-size:22px}.agent-chat-composer button.is-stopping{background:var(--danger)!important;color:#fff!important;font-size:12px}
.themed-select{display:inline-block;min-width:0;width:100%}.themed-select-trigger{position:relative;width:100%;min-width:0;padding:8px 28px 8px 10px;border:1px solid var(--line);border-radius:8px;background:#131316;color:var(--text);overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap}.themed-select-trigger:after{position:absolute;right:10px;top:50%;width:6px;height:6px;border-right:1px solid var(--muted);border-bottom:1px solid var(--muted);content:"";transform:translateY(-70%) rotate(45deg)}.themed-select-trigger:focus-visible{outline:2px solid var(--pi);outline-offset:1px}.themed-select-list{position:fixed;z-index:1000;overflow:hidden;padding:6px;border:1px solid #3a3a42;border-radius:10px;background:#111114;box-shadow:0 18px 50px rgba(0,0,0,.65);scrollbar-color:#44444d #111114}.themed-select-search-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.themed-select-dismiss{display:none;width:40px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--text);font-size:22px}.themed-select-option{display:block;width:100%;padding:9px 10px;border:0;border-radius:6px;background:transparent;color:var(--text);overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap}.themed-select-option:hover,.themed-select-option:focus-visible{background:var(--surface2);outline:0}.themed-select-option[aria-selected="true"]{background:#20344b;color:#cfe5ff}.themed-select-option:disabled{opacity:.4}.controls .themed-select{width:210px}.controls label{min-width:0}.themed-select-list.mobile-sheet{border-radius:14px;padding:8px;box-shadow:0 -16px 54px rgba(0,0,0,.78)}.themed-select-list.mobile-sheet .themed-select-dismiss{display:grid;place-items:center}.themed-select-list.mobile-sheet .themed-select-option{min-height:44px;padding:11px 10px}.themed-select-list.mobile-sheet .themed-select-cost-filters{overflow-x:auto;min-height:34px}.themed-select-list.mobile-sheet input[type="search"]{min-height:42px;margin-bottom:0!important}
.pi-watermark{font-size:650px}
#routine-editor{display:grid;gap:10px}#routine-editor label{display:grid;gap:5px;color:var(--muted);font-size:11px}#routine-editor input,#routine-editor textarea,#routine-editor select{width:100%;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}#routine-editor button{border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text);padding:8px}.routine-actions{display:flex;gap:7px}.routine-actions button{flex:1}.routine-actions .primary{border:0!important;background:var(--pi)!important;color:#07101b!important;font-weight:700}.routine-actions .danger{color:var(--danger)!important;border-color:var(--danger)!important}.routine-card{cursor:pointer}.routine-card.active{border-color:var(--pi)}.routine-state{display:flex;align-items:center;gap:8px}.routine-state>.routine-target{margin-left:auto}.routine-target{color:var(--pi);font-size:11px}.routine-preview{font-size:10px;line-height:1.4}.routine-menu{position:relative}.routine-menu>summary{display:grid;width:24px;height:24px;place-items:center;border-radius:50%;cursor:pointer;list-style:none}.routine-menu>summary::-webkit-details-marker{display:none}.routine-menu>div{position:absolute;z-index:5;top:26px;right:0;display:grid;width:110px;padding:5px;border:1px solid var(--line);border-radius:8px;background:#151519;box-shadow:0 12px 30px #000}.routine-menu button{border:0!important;background:transparent!important;color:var(--text)!important;text-align:left}.routine-menu button:hover{background:var(--surface2)!important}
#attachment-list{display:flex;flex-wrap:wrap;gap:7px;margin:0 8px 7px}#attachment-list:empty{display:none}.attachment-chip{display:flex;align-items:center;gap:6px;max-width:250px;padding:6px 8px;border:1px solid var(--line);border-radius:9px;background:var(--surface2);font-size:11px}.attachment-chip a{min-width:0;overflow:hidden;color:var(--text);text-overflow:ellipsis;white-space:nowrap}.attachment-chip span{color:var(--muted);white-space:nowrap}.attachment-chip button,#attachment-button{border:0;background:transparent;color:var(--muted)}.attachment-chip button:hover,#attachment-button:hover{color:var(--text)}#attachment-button{flex:0 0 42px;width:42px;height:42px;border-radius:50%;font-size:25px}.composer-drop{border-color:var(--pi)!important;background:#1b2735!important}.capability-section{margin-bottom:9px;border:1px solid var(--line);border-radius:10px;background:rgba(20,20,23,.55);overflow:hidden}.capability-section>summary,.capability-card>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none}.capability-section>summary::-webkit-details-marker,.capability-card>summary::-webkit-details-marker{display:none}.capability-section>summary{padding:10px 11px}.capability-section>summary::before,.capability-card>summary::before{content:"›";flex:0 0 auto;color:var(--muted);font-size:17px;line-height:1;transition:transform .15s}.capability-section[open]>summary::before,.capability-card[open]>summary::before{transform:rotate(90deg)}.capability-section>summary strong{font-size:11px;text-transform:uppercase;letter-spacing:.09em}.capability-location{margin-left:auto;border:1px solid var(--line);border-radius:999px;padding:2px 6px;color:var(--muted);font-size:8px;text-transform:uppercase;letter-spacing:.08em}.capability-location.remote{border-color:#4b3d63;color:#c4a7e7}.capability-count{min-width:18px;color:var(--muted);font-size:10px;text-align:right}.capability-section>.muted{display:block;padding:0 12px 11px;font-size:11px}.capability-card{margin:0 8px 8px;padding:0;border-color:var(--line);background:#131316}.capability-card>summary{padding:8px 9px}.capability-card>summary span:first-of-type{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.capability-status{margin-left:auto;color:var(--pi);font-size:9px;text-transform:uppercase}.capability-body{padding:0 10px 9px 28px;border-top:1px solid var(--line);font-size:11px;line-height:1.45}.capability-body>.muted{padding-top:8px}.capability-meta{margin-top:5px;color:var(--muted);font-size:10px;overflow-wrap:anywhere}
.preview-card{display:grid;gap:10px;padding:10px}#preview-form,.preview-tabs{display:flex;gap:6px}#preview-address{min-width:0;flex:1;border:1px solid var(--line);border-radius:7px;background:#131316;color:var(--text);padding:8px;font-size:11px}#preview-back,#preview-forward,#preview-reload,#preview-control,.preview-tabs button{flex:0 0 auto;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text);padding:7px 9px}.preview-tabs button.active{border-color:var(--pi);color:var(--pi)}#preview-control{justify-self:start}.preview-frame{display:grid;min-height:220px;place-items:center;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#0c0c0e;outline:none}.preview-frame:focus-visible{border-color:var(--pi);box-shadow:0 0 0 2px color-mix(in srgb,var(--pi) 25%,transparent)}.preview-frame img{display:block;max-width:100%;height:auto;cursor:default}.preview-frame img:hover{cursor:pointer}.preview-diagnostics{display:grid;gap:7px;max-height:360px;overflow:auto}.preview-diagnostic{white-space:pre-wrap;overflow-wrap:anywhere;padding:8px;border:1px solid var(--line);border-radius:7px;background:#131316;font-size:11px;line-height:1.4}.preview-session{overflow:hidden;color:var(--muted);font-size:11px;line-height:1.4;text-overflow:ellipsis}.preview-status:empty,.preview-session:empty,.preview-recording-status:empty{display:none}.preview-status{font-size:11px;color:var(--muted)}.preview-status.error{color:var(--danger)}
.message.tool{padding:0;overflow:hidden}.message.tool-error{border-color:color-mix(in srgb,var(--danger) 55%,var(--line))}.tool-activity>summary{display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:pointer;list-style:none;white-space:normal}.tool-activity>summary::-webkit-details-marker{display:none}.tool-activity>summary::before{content:"›";flex:0 0 auto;color:var(--muted);font-size:18px;line-height:1;transition:transform .15s}.tool-activity[open]>summary::before{transform:rotate(90deg)}.tool-activity-summary strong{color:var(--text);font-size:12px}.tool-activity-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}.tool-activity-state{margin-left:auto;flex:0 0 auto;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.tool-running .tool-activity-state{color:var(--pi)}.tool-error .tool-activity-state{color:var(--danger)}.tool-activity-body{display:grid;gap:10px;padding:0 12px 12px;border-top:1px solid var(--line)}.tool-activity-body section{min-width:0;padding-top:10px}.tool-activity-heading{margin-bottom:4px;color:var(--pi);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.1em}.tool-activity-body pre{max-height:320px;margin:0;overflow:auto;color:var(--muted);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.subagent-card{display:grid;gap:9px;padding:12px 13px}.subagent-card-header{display:flex;align-items:center;gap:9px}.subagent-status-dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--muted)}.subagent-card[data-status="running"] .subagent-status-dot{background:var(--pi);animation:pulse 1s infinite alternate}.subagent-card[data-status="error"] .subagent-status-dot{background:var(--danger)}.subagent-identity{display:flex;min-width:0;flex-direction:column}.subagent-identity strong{overflow:hidden;color:var(--text);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.subagent-identity span{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.subagent-card-actions{display:flex;gap:4px;margin-left:auto}.subagent-card-actions button{display:grid;width:30px;height:30px;place-items:center;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted)}.subagent-card-actions button:hover{background:var(--surface2);color:var(--text)}.subagent-card-actions svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.subagent-card-actions .subagent-stop{color:var(--danger);font-size:11px}.subagent-task{overflow:hidden;color:var(--text);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.subagent-latest{overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.subagent-session-tab{color:#c4a7e7}.subagent-inspector-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 14px;margin-bottom:18px;padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.subagent-inspector-heading strong{font-size:16px}.subagent-inspector-heading span{color:var(--pi);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.subagent-inspector-heading p{grid-column:1/-1;margin:0;color:var(--muted);line-height:1.5}.subagent-timeline{display:grid;gap:12px}.subagent-result{display:grid;gap:10px;padding:14px;border:1px solid var(--line);border-radius:11px;background:rgba(20,20,23,.7)}.subagent-result>strong{color:var(--pi)}.subagent-event{border-top:1px solid var(--line);padding-top:8px}.subagent-event summary{cursor:pointer;color:var(--muted);font-size:11px}.subagent-event pre{max-height:280px;overflow:auto;color:var(--muted);font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.browser-utility-actions{display:flex;align-items:center;gap:6px}.browser-utility-actions button{width:34px;height:34px;flex:0 0 34px;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text);padding:0}.browser-utility-actions button:disabled{opacity:.4;cursor:default}.browser-utility-actions #preview-record.recording{border-color:var(--danger);color:var(--danger)}.preview-recording-status{color:var(--muted);font-size:10px;line-height:1.4}
.browser-workflow-section{display:grid;gap:8px;margin-top:10px}.browser-workflow-heading{display:flex;align-items:center;justify-content:space-between;padding:0 3px}.browser-workflow-heading button,.browser-workflow-actions button,.browser-workflow-issue button{display:grid;width:30px;height:30px;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text)}.browser-workflow-actions button[aria-busy="true"]{color:var(--accent);cursor:progress}.browser-workflow-list{display:grid;gap:7px}.browser-workflow-card{border:1px solid var(--line);border-radius:9px;background:var(--surface);overflow:hidden}.browser-workflow-card>summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;cursor:pointer;list-style:none}.browser-workflow-card>summary::-webkit-details-marker{display:none}.browser-workflow-state{color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.browser-workflow-state.state-active,.browser-workflow-state.state-validated{color:#43c58a}.browser-workflow-state.state-needs-input,.browser-workflow-state.state-invalid{color:var(--danger)}.browser-workflow-body{display:grid;gap:9px;padding:0 10px 10px}.browser-workflow-evidence{border:1px solid var(--line);border-radius:7px;padding:7px}.browser-workflow-evidence>summary{cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:.06em}.browser-workflow-evidence>div{display:grid;gap:5px;padding-top:7px;overflow-wrap:anywhere}.browser-workflow-evidence a{color:var(--accent);font-size:10px}.browser-workflow-values{display:grid;gap:6px}.browser-workflow-values:empty{display:none}.browser-workflow-values label{display:grid;gap:4px;color:var(--muted);font-size:10px}.browser-workflow-values input,.browser-workflow-issue select{min-width:0;width:100%;padding:7px;border:1px solid var(--line);border-radius:7px;background:#131316;color:var(--text)}.browser-workflow-actions{display:flex;justify-content:flex-end;gap:6px}.browser-workflow-action-state:empty{display:none}.browser-workflow-action-state{min-width:0;overflow-wrap:anywhere;color:var(--muted);font-size:10px;line-height:1.35}.browser-workflow-action-state[data-status="running"]{color:var(--accent)}.browser-workflow-action-state[data-status="completed"]{color:#43c58a}.browser-workflow-action-state[data-status="failed"]{color:var(--danger)}.browser-workflow-issue{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:center;padding:8px;border:1px solid color-mix(in srgb,var(--danger) 45%,var(--line));border-radius:8px}.browser-workflow-issue>span{grid-column:1/-1;color:var(--muted);font-size:10px;line-height:1.4}
.agent-browser-workflow-grants{display:grid;gap:6px;padding:9px}.agent-browser-workflow-grants:empty:after{content:"No active browser workflows";color:var(--muted);font-size:10px}.agent-browser-workflow-grants label{display:flex;align-items:center;gap:7px;color:var(--text);font-size:11px}
.browser-session-tabs{display:flex;min-width:0;gap:3px;padding:0 3px;overflow-x:auto;border-bottom:1px solid var(--line)}.browser-session-tabs:empty{display:none}.browser-session-tabs button{display:flex;min-width:96px;max-width:180px;align-items:center;gap:6px;padding:8px 10px;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;background:#121216;color:var(--muted);font-size:10px}.browser-session-tabs button span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.browser-session-tabs button.active{border-color:var(--line);background:var(--surface2);color:var(--text)}.browser-tab-icon{flex:0 0 auto;color:var(--pi);font:700 13px/1 Georgia,serif}.browser-window-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.browser-window-heading strong{margin:0}.browser-window-heading #preview-popout{display:grid;width:30px;height:30px;place-items:center;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text)}.browser-toolbar{display:grid!important;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:6px!important}.browser-nav-actions{display:flex;gap:3px}.browser-nav-actions button,.browser-utility-actions button,.browser-omnibox button{display:grid;place-items:center}.browser-nav-actions button{width:30px;height:30px;flex:0 0 30px;padding:0!important;border:0!important;border-radius:50%!important;background:transparent!important}.browser-nav-actions button:hover:not(:disabled){background:var(--surface2)!important}.browser-action-icon{width:16px;height:16px;flex:0 0 16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.browser-action-icon-fill{fill:currentColor;stroke:none}.browser-action-pi{fill:currentColor;stroke:none;font:700 16px Georgia,serif}.browser-omnibox{display:flex;min-width:0;align-items:center;gap:5px;padding:3px 3px 3px 9px;border:1px solid var(--line);border-radius:999px;background:#131316}.browser-address-icon{color:var(--muted);font-size:12px}.browser-omnibox #preview-address{min-width:0;padding:5px 2px;border:0;background:transparent;outline:0}.browser-omnibox button{width:28px;height:28px;border:0!important;border-radius:50%!important;padding:0!important}.browser-utility-actions button[data-browser-icon="record"]{color:var(--danger)}.preview-session{padding:0 3px}.preview-frame{border-radius:9px;box-shadow:0 10px 28px rgba(0,0,0,.24)}
.mobile-panel-state{position:fixed;opacity:0;pointer-events:none}.mobile-panel-toggle,.mobile-panel-close,.mobile-panel-scrim,.mobile-session-add{display:none}@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse){body{display:block}main{height:100dvh}.resizer{display:none!important}.rail,.details{display:flex!important;position:fixed;z-index:50;top:0;bottom:0;width:min(88vw,360px);height:100dvh;box-shadow:0 0 48px rgba(0,0,0,.62);transition:transform .2s ease,visibility .2s;visibility:hidden}.rail{left:0;transform:translateX(-105%)}.details{right:0;transform:translateX(105%)}#mobile-panel-left:checked~.rail,#mobile-panel-right:checked~.details{transform:translateX(0);visibility:visible}.mobile-panel-scrim{position:fixed;z-index:40;inset:0;background:rgba(0,0,0,.58);backdrop-filter:blur(2px)}#mobile-panel-left:checked~.mobile-panel-scrim,#mobile-panel-right:checked~.mobile-panel-scrim{display:block}.mobile-panel-toggle,.mobile-panel-close{align-items:center;justify-content:center;width:44px;height:44px;border:1px solid var(--line);border-radius:10px;color:var(--text);background:var(--surface);cursor:pointer}.mobile-panel-toggle{display:flex;flex:0 0 44px}.mobile-session-add{display:grid;width:34px;height:34px;flex:0 0 34px;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:22px}.mobile-session-add:hover,.mobile-session-add:focus-visible{background:var(--surface2);color:var(--text)}.mobile-panel-toggle svg,.mobile-panel-close svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.mobile-panel-close{position:fixed;z-index:60;top:8px}.mobile-panel-close-left{left:min(calc(88vw - 52px),308px)}.mobile-panel-close-right{right:8px}#mobile-panel-left:checked~.mobile-panel-close-left,#mobile-panel-right:checked~.mobile-panel-close-right{display:flex}.rail>.section-title{padding-right:48px;margin-top:12px}.rail .rail-heading{position:static;z-index:3}.rail-panel{padding-bottom:68px}.rail #open-settings{position:absolute;z-index:2;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));width:44px;height:44px;border:1px solid var(--line);background:var(--surface2);color:var(--text);box-shadow:0 10px 26px rgba(0,0,0,.4)}.details>.tabs{padding-right:48px}.header{padding:7px 10px;min-height:59px}.session-tabs{flex:1}#session-path{margin-left:0;max-width:28%}}@media(max-width:620px){#session-path{display:none}.session-tab{max-width:140px}.rail,.details{width:min(92vw,360px)}.mobile-panel-close-left{left:min(calc(92vw - 52px),308px)}}
.composer-meta #session-path{display:block;min-width:0;max-width:42%;margin:0;padding:0;overflow:hidden;border:0;background:transparent;color:var(--muted);font:inherit;text-align:left;text-overflow:ellipsis;white-space:nowrap}.composer-meta #session-path:not(:disabled){color:var(--pi);text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px}.composer-meta #session-path:not(:disabled):hover{max-width:55%;text-decoration-color:currentColor}.composer-meta #session-path:disabled{cursor:default}.composer-meta #session-path-form{display:flex;min-width:220px;max-width:58%;align-items:center;gap:4px}.composer-meta #session-path-input{min-width:0;flex:1;border:1px solid var(--line);border-radius:6px;background:#131316;color:var(--text);padding:5px 7px;font:inherit}.composer-meta #session-path-form button{width:25px;height:25px;flex:0 0 25px;border:1px solid var(--line);border-radius:6px;background:var(--surface2);color:var(--text);padding:0}.composer-meta #status{flex:1}.composer-meta #session-stats{flex:0 1 auto}@media(max-width:620px){.composer-meta #session-path{display:block;max-width:46%}.composer-meta #session-path-form{min-width:0;max-width:68%;flex:1}.composer-meta #status:not(.error){display:none}}
body.browser-popout{display:block}body.browser-popout>.mobile-panel-state,body.browser-popout>.mobile-panel-scrim,body.browser-popout>.mobile-panel-close,body.browser-popout .mobile-panel-toggle{display:none!important}body.browser-popout>.rail,body.browser-popout>.resizer,body.browser-popout>main{display:none}body.browser-popout>.details{position:fixed;inset:0;display:flex!important;width:auto;height:100dvh;padding:0;background:var(--bg);transform:none;visibility:visible}body.browser-popout>.details>.tabs{display:none}body.browser-popout>.details>[data-panel]{display:none}body.browser-popout>.details>#browser{display:block!important;flex:1;overflow:auto}body.browser-popout .preview-card{min-height:100%;margin:0;padding:12px;border:0;border-radius:0}body.browser-popout .preview-frame{min-height:calc(100vh - 275px)}body.browser-popout .preview-frame img{max-height:calc(100vh - 275px)}
.agent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.agent-entry-card{position:relative;min-width:0}.agent-grid .agent-entry{display:grid;width:100%;min-height:112px;place-items:center;margin:0;text-align:center}.agent-grid .agent-icon{width:52px;height:52px}.agent-draft-card .agent-entry{border-style:dashed}.agent-draft-card .agent-entry>span:last-child{display:grid;gap:3px}.agent-draft-card small{color:var(--muted);font-size:10px}.agent-menu{position:absolute;z-index:3;top:5px;right:5px}.agent-menu>summary{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;color:var(--muted);cursor:pointer;list-style:none}.agent-menu>summary::-webkit-details-marker{display:none}.agent-menu[open]>summary{background:var(--surface2);color:var(--text)}.agent-menu>div{position:absolute;top:30px;right:0;display:grid;width:108px;padding:5px;border:1px solid var(--line);border-radius:8px;background:#151519;box-shadow:0 12px 30px #000}.agent-menu button{border:0;border-radius:5px;background:transparent;color:var(--text);padding:7px;text-align:left}.agent-menu button:hover{background:var(--surface2)}.agent-menu button.danger{color:var(--danger)}.agent-menu button:disabled{opacity:.4}.agent-workspace-actions{display:flex;justify-content:flex-end}.agent-workspace-actions button{width:32px;height:32px;border:1px solid var(--line);border-radius:50%;background:var(--surface2);color:var(--text)}.agent-chat-card{display:grid;gap:8px}.agent-chat{display:grid;gap:8px;max-height:360px;overflow:auto}.agent-chat-message{padding:9px 11px;border-radius:10px;background:#151519;white-space:pre-wrap}.agent-chat-message.user{margin-left:16%;background:#202d3d}.agent-chat-message.agent{margin-right:10%}#selected-agent-chat-form{display:flex;gap:6px}#selected-agent-prompt{min-width:0;flex:1;resize:vertical;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:9px}#selected-agent-send{width:36px;height:36px;align-self:end;border:0;border-radius:50%;background:var(--text);color:var(--bg)}.builder-panel>label,.workflow-editor label,#routine-editor label{display:grid;gap:5px;margin:9px 0;color:var(--muted);font-size:11px}.builder-panel>label input,.builder-panel>label textarea,.builder-panel>label select,#plugin-form input,#plugin-form select,.workflow-editor input,.workflow-editor textarea,.workflow-editor select,#routine-editor input,#routine-editor textarea,#routine-editor select{width:100%;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}.workflow-editor textarea{min-height:88px;font-family:ui-monospace,monospace}.persona-preview{display:block;width:84px;height:84px;margin:8px auto;border-radius:12px;object-fit:cover}#agent-form{display:flex;justify-content:flex-end;margin-top:10px}#agent-form button,#plugin-form button{border:0;border-radius:8px;background:var(--pi);color:#07101b;padding:9px 13px;font-weight:700}#plugin-form{display:grid;gap:8px;padding:10px}#plugin-form label{display:grid;gap:5px;color:var(--muted);font-size:11px}
.agent-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.agent-entry-card{position:relative;min-width:0}.agent-grid .agent-entry{display:grid;width:100%;min-height:112px;place-items:center;margin:0;text-align:center}.agent-grid .agent-icon{width:52px;height:52px}.agent-menu{position:absolute;z-index:3;top:5px;right:5px}.agent-menu>summary{display:grid;width:28px;height:28px;place-items:center;border-radius:50%;color:var(--muted);cursor:pointer;list-style:none}.agent-menu>summary::-webkit-details-marker{display:none}.agent-menu[open]>summary{background:var(--surface2);color:var(--text)}.agent-menu>div{position:absolute;top:30px;right:0;display:grid;width:108px;padding:5px;border:1px solid var(--line);border-radius:8px;background:#151519;box-shadow:0 12px 30px #000}.agent-menu button{border:0;border-radius:5px;background:transparent;color:var(--text);padding:7px;text-align:left}.agent-menu button:hover{background:var(--surface2)}.agent-menu button.danger{color:var(--danger)}.agent-menu button:disabled{opacity:.4}.agent-workspace-actions{display:flex;justify-content:flex-end}.agent-workspace-actions button{width:32px;height:32px;border:1px solid var(--line);border-radius:50%;background:var(--surface2);color:var(--text)}.agent-chat-card{display:grid;gap:8px}.agent-chat{display:grid;gap:8px;max-height:360px;overflow:auto}.agent-chat-message{padding:9px 11px;border-radius:10px;background:#151519;white-space:pre-wrap}.agent-chat-message.user{margin-left:16%;background:#202d3d}.agent-chat-message.agent{margin-right:10%}#selected-agent-chat-form{display:flex;gap:6px}#selected-agent-prompt{min-width:0;flex:1;resize:vertical;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:9px}#selected-agent-send{width:36px;height:36px;align-self:end;border:0;border-radius:50%;background:var(--text);color:var(--bg)}.builder-panel>label,.workflow-editor label,#routine-editor label{display:grid;gap:5px;margin:9px 0;color:var(--muted);font-size:11px}.builder-panel>label input,.builder-panel>label textarea,.builder-panel>label select,#plugin-form input,#plugin-form select,.configuration-form input,.configuration-form select,.workflow-editor input,.workflow-editor textarea,.workflow-editor select,#routine-editor input,#routine-editor textarea,#routine-editor select{width:100%;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}.workflow-editor textarea{min-height:88px;font-family:ui-monospace,monospace}.persona-preview{display:block;width:84px;height:84px;margin:8px auto;border-radius:12px;object-fit:cover}#agent-form{display:flex;justify-content:flex-end;margin-top:10px}#agent-form button,#plugin-form button,.configuration-form button{border:0;border-radius:8px;background:var(--pi);color:#07101b;padding:9px 13px;font-weight:700}#plugin-form,.configuration-form{display:grid;gap:8px;padding:10px}#plugin-form label,.configuration-form label{display:grid;gap:5px;color:var(--muted);font-size:11px}.capability-connection-summary{display:flex;align-items:center;justify-content:space-between;gap:8px}.capability-connection-card .danger{border:1px solid var(--danger);background:transparent;color:var(--danger)}
.provider-account{padding:8px 10px;border:1px solid #28523f;border-radius:8px;background:#10251d;color:#8fd2ae;font-size:11px;overflow-wrap:anywhere}.provider-field-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px}.configuration-form .provider-field-row input,.configuration-form .provider-field-row select{min-width:0}.configuration-form .provider-field-action{display:grid;width:36px;height:36px;min-height:36px;place-items:center;padding:0;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--pi)}.configuration-form .provider-field-action.danger{border-color:var(--line);color:var(--danger)}.provider-field-action svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.provider-field-action:disabled{opacity:.35}.provider-permissions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.provider-permissions-title{grid-column:1/-1;color:var(--text);font-size:11px;font-weight:700}.provider-service{min-width:0;margin:0;padding:8px;border:1px solid var(--line);border-radius:8px}.provider-service legend{display:flex;max-width:100%;align-items:center;gap:6px;padding:0 4px;color:var(--text);font-size:11px;font-weight:700}.provider-service-state{color:var(--muted);font-size:8px;font-weight:400;text-transform:uppercase}.provider-service-state.available{color:#72c49a}.configuration-form .provider-capability{display:flex;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:6px;margin:5px 0;color:var(--text);overflow-wrap:anywhere}.configuration-form .provider-capability input{width:auto}.configuration-form .provider-capability:has(input:disabled){color:var(--muted);opacity:.55}@media(max-width:520px){.provider-permissions{grid-template-columns:1fr}}
.browser-profiles>summary{cursor:pointer}.browser-profile-description{margin:8px 0;font-size:10px;line-height:1.4}.browser-profile-row{display:flex;align-items:center;justify-content:space-between;padding:7px 2px;border-top:1px solid var(--line)}.browser-profile-row button{width:28px;height:28px;border:1px solid var(--line);border-radius:50%;background:transparent;color:var(--muted)}
.builder-tabs{overflow-x:auto;scrollbar-width:none}.builder-tabs::-webkit-scrollbar{display:none}.builder-tabs button{flex:0 0 auto;min-width:max-content;padding-inline:9px;font-size:10px;white-space:nowrap}.builder-panel{max-width:100%;overflow-x:hidden}#agent-builder>.card{max-width:100%;overflow:hidden}#routine-editor{min-width:0}.routine-actions{min-width:0;flex-wrap:wrap}.routine-actions button{min-width:calc(50% - 4px)}
[data-tab="agent-builder"]{display:none}.builder-guide{max-width:820px;margin:0 0 24px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--surface) 92%,transparent)}.builder-guide-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.builder-guide-heading strong{margin-right:auto;font-size:15px}.builder-guide-heading .secondary-action{flex:0 0 auto;padding:7px 10px}.builder-guide p{margin:8px 0 0;line-height:1.45}.builder-stage{padding:4px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:10px;white-space:nowrap}.builder-stage[data-stage="testing"]{border-color:var(--pi);color:var(--pi);animation:pulse 1s infinite alternate}.builder-stage[data-stage="proof-ready"],.builder-stage[data-stage="proven"],.builder-stage[data-stage="promoted"],.builder-stage[data-stage="automated"]{border-color:#55b685;color:#55b685}.builder-stage[data-stage="needs-refinement"]{border-color:var(--danger);color:var(--danger)}.lifecycle-action{flex:0 0 auto;border:1px solid color-mix(in srgb,var(--pi) 65%,var(--line));border-radius:8px;background:color-mix(in srgb,var(--pi) 14%,var(--surface2));color:var(--text);padding:7px 10px;font-weight:700}.lifecycle-action:disabled{opacity:.55}.proof-review-dialog{display:grid;gap:12px;padding:18px}.proof-review-dialog pre{max-height:min(54vh,520px);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border:1px solid var(--line);border-radius:9px;background:#101013}.team-review{display:grid;gap:12px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.team-review>p{margin:0}.team-review-members{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.team-review-members>div{min-width:0;padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--bg)}.team-review-members strong,.team-review-members span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.team-review-members span{margin-top:4px;color:var(--muted);font-size:11px}.team-review .primary-action{justify-self:start}@media(max-width:620px){.builder-guide-heading{align-items:stretch;flex-direction:column}.builder-guide-heading .secondary-action,.builder-guide-heading .primary-action,.builder-guide-heading .lifecycle-action,.team-review .primary-action{width:100%}.builder-stage{align-self:flex-start}.team-review-members{grid-template-columns:1fr}}
.agent-workspace-actions{justify-content:flex-start}.agent-workspace-actions button{display:grid;width:28px;height:28px;place-items:center;border:0;border-radius:0;background:transparent;color:var(--muted);font-size:20px;line-height:1}.agent-workspace-actions button:hover{background:var(--surface2);color:var(--text)}
.session-tab-wrap{display:flex;align-items:center;min-width:0;border:1px solid transparent;border-radius:8px}.session-tab-wrap.active{background:var(--surface);border-color:var(--line)}.session-tab-wrap .session-tab{border:0;background:transparent}.agent-session-tab,.builder-session-tab{color:var(--pi)}.session-tab-close{display:grid;width:26px;height:26px;flex:0 0 26px;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--muted)}.session-tab-close:hover{background:var(--surface2);color:var(--text)}.agent-summary-card{display:grid;gap:4px}.agent-summary-card strong{margin:0}.agent-summary-card span{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-run-history>summary{cursor:pointer}.agent-history-entry{margin-top:8px;border:1px solid var(--line);border-radius:8px;background:#151519}.agent-history-entry>summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:7px;align-items:center;padding:9px;cursor:pointer;list-style:none}.agent-history-entry>summary::-webkit-details-marker{display:none}.agent-history-status{width:7px;height:7px;border-radius:50%;background:var(--muted)}.agent-history-entry[data-status="running"] .agent-history-status,.agent-history-entry[data-status="queued"] .agent-history-status{background:var(--pi)}.agent-history-entry[data-status="failed"] .agent-history-status{background:var(--danger)}.agent-history-prompt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-history-time{font-size:9px;color:var(--muted)}.agent-history-body{display:grid;gap:8px;padding:0 9px 9px;white-space:pre-wrap;overflow-wrap:anywhere}.agent-history-body button{justify-self:start;border:1px solid var(--danger);border-radius:6px;background:transparent;color:var(--danger);padding:5px 8px}.agent-message-content{display:grid;gap:9px;overflow-wrap:anywhere}.agent-message-content p,.agent-message-content pre,.agent-message-content ul,.agent-message-content ol{margin:0}.agent-message-content pre{overflow:auto;padding:10px;border:1px solid var(--line);border-radius:8px;background:#121216;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre}.agent-message-content code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.agent-message-content :not(pre)>code{padding:1px 4px;border-radius:4px;background:var(--surface2)}.agent-message-content h2,.agent-message-content h3{margin:6px 0 0;font-size:1em}.agent-running{display:flex;align-items:center;gap:8px;color:var(--muted);font-style:italic}.agent-running i{width:6px;height:6px;border-radius:50%;background:var(--pi);animation:pulse 1s infinite alternate}
.context-meter{--context-color:var(--pi);--context-used:0%;display:inline-block;width:15px;height:15px;flex:0 0 15px;border-radius:50%;background:conic-gradient(var(--context-color) var(--context-used),var(--line) 0);box-shadow:inset 0 0 0 3px var(--bg);outline:none}.context-meter[data-level="warning"]{--context-color:#e4ba68}.context-meter[data-level="critical"]{--context-color:var(--danger)}.context-meter:focus-visible{box-shadow:inset 0 0 0 3px var(--bg),0 0 0 2px var(--pi)}#session-stats,.session-stat-totals{display:flex;align-items:center;gap:7px}.session-stat{display:inline-flex;align-items:baseline;gap:1px}.session-stat-input .session-stat-symbol{color:#ef6b6b}.session-stat-output .session-stat-symbol,.session-stat-cost{color:#43c58a}.file-picker-input{position:fixed;left:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}.rail-heading{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;padding:4px 8px 10px;color:var(--muted);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.rail-heading button{display:grid;width:28px;height:28px;place-items:center;border:0;border-radius:50%;background:transparent;color:var(--muted);font-size:20px;line-height:1}.rail-heading button:hover{background:var(--surface2);color:var(--text)}
.sessions-panel{flex:0 0 42%;min-height:96px}.agent-activity-panel{flex:1 1 auto;min-height:96px}.rail-section-resizer{position:relative;z-index:3;height:6px;flex:0 0 6px;margin:2px 0;background:var(--line);cursor:row-resize;touch-action:none}.rail-section-resizer:hover,.rail-section-resizer.dragging{background:var(--pi)}.agent-activity-heading{flex:0 0 auto;padding-top:8px}.agent-activity-heading #open-artifacts{margin-left:auto;width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--muted)}.agent-activity-heading #open-artifacts:hover{background:var(--surface2);color:var(--text)}.agent-activity-heading #open-artifacts:disabled{opacity:.3;cursor:default}.agent-activity-heading #open-artifacts svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.agent-activity-entry{display:grid;width:100%;min-width:0;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:8px;margin-top:6px;padding:9px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--text);text-align:left}.agent-activity-entry:hover{border-color:var(--line);background:var(--surface)}.agent-activity-entry:disabled{opacity:.5;cursor:not-allowed}.agent-activity-entry>span{display:grid;min-width:0;gap:3px}.agent-activity-entry strong,.agent-activity-entry small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-activity-entry strong{font-size:11px}.agent-activity-entry small,.agent-activity-entry time{color:var(--muted);font-size:9px}.agent-activity-status{width:7px;height:7px;border-radius:50%;background:var(--muted)}.agent-activity-entry[data-status="queued"] .agent-activity-status,.agent-activity-entry[data-status="running"] .agent-activity-status,.agent-activity-entry[data-status="waiting_for_approval"] .agent-activity-status,.agent-activity-entry[data-status="waiting_for_input"] .agent-activity-status,.agent-activity-entry[data-status="stopping"] .agent-activity-status{background:var(--pi);animation:pulse 1s infinite alternate}.agent-activity-entry[data-status="failed"] .agent-activity-status,.agent-activity-entry[data-status="interrupted"] .agent-activity-status{background:var(--danger)}.agent-activity-entry[data-status="completed"] .agent-activity-status{background:#55b685}.agent-activity-empty{padding:8px;color:var(--muted);font-size:10px}.attention-entry-wrap{display:grid;grid-template-columns:minmax(0,1fr) repeat(3,auto);align-items:center;gap:3px}.attention-inline-action{width:27px;height:27px;border:0;border-radius:7px;background:transparent;color:var(--muted)}.attention-inline-action:hover{background:var(--surface2);color:var(--text)}.attention-inline-action:disabled{opacity:.35;cursor:not-allowed}.promotion-dialog{width:min(560px,calc(100vw - 24px));max-height:min(760px,calc(100dvh - 24px));border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--text);padding:0;box-shadow:0 24px 80px #000b}.promotion-dialog::backdrop{background:#000a}.promotion-dialog form{display:grid;gap:12px;padding:18px;overflow:auto}.promotion-dialog label{display:grid;gap:6px;color:var(--muted);font-size:11px}.promotion-dialog input,.promotion-dialog textarea{width:100%;min-width:0;border:1px solid var(--line);border-radius:9px;background:#131316;color:var(--text);padding:10px}.promotion-dialog textarea{min-height:76px;resize:vertical}.promotion-dialog label:nth-of-type(3) textarea{min-height:170px}.promotion-dialog details{min-width:0}.promotion-dialog details pre{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.promotion-actions{display:flex;justify-content:flex-end;gap:8px}.message-artifacts{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}.message-artifacts button{border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--pi);padding:7px 9px}.artifact-session-tab{color:#7db4f3}.artifact-header{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.artifact-header>div{display:grid;min-width:0;gap:3px}.artifact-header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.artifact-header span{color:var(--muted);font-size:10px}.artifact-actions{display:flex;align-items:center;gap:5px}.artifact-actions select{height:32px;border:1px solid var(--line);border-radius:8px;background:#131316;color:var(--text);padding:0 6px}.artifact-actions button,.artifact-actions a{display:grid;width:32px;height:32px;place-items:center;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);text-decoration:none}.artifact-content{min-width:0;min-height:0;margin-top:12px;overflow:auto}.artifact-content img{display:block;max-width:100%;height:auto;margin:auto}.artifact-content iframe{width:100%;height:max(60vh,480px);border:1px solid var(--line);border-radius:10px;background:#fff}.artifact-text{max-width:900px;margin:auto;padding:18px;border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow-wrap:anywhere}.artifact-library{display:grid;gap:12px;margin-top:12px}.artifact-library-controls{display:grid;grid-template-columns:minmax(0,1fr) 160px;gap:8px}.artifact-library-controls input,.artifact-library-controls select{min-width:0;border:1px solid var(--line);border-radius:9px;background:#131316;color:var(--text);padding:10px}.artifact-library-results{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}.artifact-library-card{display:grid;min-width:0;gap:6px;border:1px solid var(--line);border-radius:11px;background:var(--surface);color:var(--text);padding:13px;text-align:left}.artifact-library-card:hover{background:var(--surface2)}.artifact-library-card strong,.artifact-library-card span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.artifact-library-card span{color:var(--muted);font-size:10px}.delegation-panel-host{position:relative;z-index:3;flex:0 0 auto;min-width:0;min-height:0;overflow:hidden}.delegation-panel-host>.card{width:100%;max-height:min(38vh,340px);overflow-x:hidden;overflow-y:auto;margin:8px 0 0;padding:10px}.delegation-panel-host>.card>summary{position:sticky;top:0;z-index:1;padding:3px 0 7px;background:var(--surface)}
.builder-settings-stack{display:grid;gap:8px}.builder-settings-group{border:1px solid var(--line);border-radius:11px;background:rgba(17,17,20,.72);overflow:hidden}.builder-settings-group>summary{display:flex;align-items:center;gap:10px;min-height:54px;padding:10px 12px;cursor:pointer;list-style:none}.builder-settings-group>summary::-webkit-details-marker{display:none}.builder-settings-group>summary:before{content:"›";flex:0 0 auto;color:var(--muted);font-size:18px;line-height:1;transition:transform .15s}.builder-settings-group[open]>summary:before{transform:rotate(90deg)}.builder-settings-summary-copy{display:grid;min-width:0;gap:2px}.builder-settings-title{color:var(--text);font-size:12px;font-weight:650}.builder-settings-description{color:var(--muted);font-size:9px;line-height:1.35}.builder-settings-status{margin-left:auto;flex:0 0 auto;border:1px solid var(--line);border-radius:999px;padding:3px 7px;color:var(--muted);font-size:9px}.builder-settings-body{padding:0 10px 10px;border-top:1px solid var(--line)}.builder-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;padding-top:10px}.builder-settings-grid>label{display:grid;min-width:0;gap:5px;color:var(--muted);font-size:10px}.builder-settings-grid>label input,.builder-settings-grid>label select{width:100%;min-width:0;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}.builder-settings-grid>#capability-list,.builder-settings-grid>.capability-section{grid-column:1/-1}.builder-settings-grid>#capability-list:empty:after{content:"No capabilities loaded";display:block;padding:10px;color:var(--muted);font-size:10px}.builder-settings-grid .capability-section{margin:0}.builder-settings-grid #capability-search{min-width:0}.builder-settings-grid #capability-list{display:grid;gap:7px}.builder-settings-grid #capability-list>.capability-section{margin:0}.builder-settings-grid #plugin-form{padding:9px}.builder-settings-grid .themed-select{min-width:0}@media(max-width:420px){.builder-settings-grid{grid-template-columns:1fr}}
@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse){.rail{padding-bottom:72px}.rail #open-settings{z-index:10}.delegation-panel-host>.card{max-height:min(32dvh,280px)}.artifact-header{padding:10px}.artifact-content iframe{height:calc(100dvh - 250px);min-height:360px}.artifact-library-results{grid-template-columns:1fr}}@media(max-width:620px){.artifact-library-controls{grid-template-columns:1fr}.artifact-text{padding:13px}.artifact-actions button,.artifact-actions a{width:36px;height:36px}}
.capability-grant{display:flex;align-items:center;min-width:0;gap:7px;color:var(--text)}.capability-grant span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.capability-body>label{display:grid;gap:5px;margin-top:9px;color:var(--muted);font-size:10px}.capability-body select{width:100%;min-width:0;padding:8px;border:1px solid var(--line);border-radius:7px;background:#131316;color:var(--text)}
.message{min-width:0;overflow-wrap:anywhere}
.rail-heading-actions{display:flex;align-items:center;gap:2px}.rail-heading-actions svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.settings-workspace{position:fixed;z-index:60;inset:0 0 0 calc(var(--rail-width) + 5px);display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--bg);overflow:hidden}.settings-header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--panel)}.settings-heading{display:grid;min-width:0;gap:3px}.settings-heading strong{font-size:16px}.settings-heading span{max-width:min(70vw,900px);overflow:hidden;color:var(--muted);font:10px ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.settings-close{display:grid;width:40px;height:40px;margin-left:auto;place-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);font-size:22px}.settings-layout{display:grid;grid-template-columns:190px minmax(0,1fr);min-height:0}.settings-nav{display:grid;align-content:start;gap:5px;padding:16px;border-right:1px solid var(--line);background:var(--panel)}.settings-nav button{min-height:44px;border:0;border-radius:8px;background:transparent;color:var(--muted);padding:10px 12px;text-align:left}.settings-nav button.active{background:var(--surface2);color:var(--text)}.settings-content{min-width:0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:18px clamp(14px,4vw,48px) 48px;scrollbar-gutter:stable}.settings-panel{width:min(900px,100%);margin:0 auto}.settings-panel>h2{margin:0 0 4px}.settings-panel>.muted{margin-bottom:16px}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.settings-card{min-width:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:13px;overflow-wrap:anywhere}.settings-card-header{display:flex;align-items:center;gap:9px}.settings-card-header strong{min-width:0;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.settings-badge{margin-left:auto;flex:0 0 auto;border:1px solid var(--line);border-radius:999px;padding:3px 7px;color:var(--muted);font-size:9px}.settings-state{margin-top:7px;color:var(--pi);font-size:10px}.settings-state.error{color:var(--danger)}.settings-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.settings-actions button,.settings-card button{min-height:36px;border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--text);padding:7px 10px}.settings-card button.danger{border-color:var(--danger);background:transparent;color:var(--danger)}.settings-advanced{margin-top:14px;border:1px solid var(--line);border-radius:11px;padding:10px}.settings-advanced>summary{cursor:pointer;color:var(--muted)}.settings-search{width:100%;min-height:44px;margin-bottom:12px;border:1px solid var(--line);border-radius:9px;background:#131316;color:var(--text);padding:10px}.settings-workspace .configuration-form{padding:10px 0}.settings-workspace .provider-permissions{grid-template-columns:repeat(3,minmax(0,1fr))}.settings-workspace .capability-section{margin-top:10px}.settings-workspace .capability-card{margin:8px 0 0}.settings-empty{padding:18px;border:1px dashed var(--line);border-radius:10px;color:var(--muted)}@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse){.settings-workspace{inset:0}.settings-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.settings-nav{display:flex;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line);padding:8px}.settings-nav button{flex:0 0 auto}.settings-content{padding:14px 12px 36px}.settings-grid{grid-template-columns:1fr}.settings-workspace .provider-permissions{grid-template-columns:1fr}.settings-header{padding:10px 12px}}
.settings-provider-icon{display:grid;width:30px;height:30px;flex:0 0 30px;place-items:center;border-radius:8px;background:linear-gradient(135deg,#4285f4,#34a853 46%,#fbbc05 72%,#ea4335);color:#fff;font-weight:800}
.settings-group-heading{grid-column:1/-1;display:grid;gap:3px;margin-top:8px;padding:4px 2px}.settings-group-heading:first-child{margin-top:0}.settings-group-heading strong{font-size:12px}.settings-group-heading .muted{font-size:10px}
.agent-running{flex-wrap:wrap}.agent-running small{flex-basis:100%;padding-left:14px;color:var(--muted);font-style:normal}
@media(max-width:1024px),(max-width:1366px) and (hover:none) and (pointer:coarse){.header .mobile-session-add{display:none!important}.rail .rail-heading{justify-content:flex-start}.rail .rail-heading-actions{margin-right:auto}}
.themed-select-option:disabled{opacity:1!important;background:#0c0c0e!important;color:#50515a!important;cursor:not-allowed}.themed-select-list.mobile-sheet .themed-select-option:disabled{background:#09090b!important;color:#494a52!important}
.controls .themed-select[data-select-id="thinking"]{width:120px}
.themed-select-list.mobile-anchored .themed-select-dismiss{display:grid;place-items:center}.themed-select-list.mobile-anchored .themed-select-option{min-height:44px;padding:11px 10px}.themed-select-list.mobile-anchored .themed-select-cost-filters{overflow-x:auto;min-height:34px}
</style></head><body>
<input id="mobile-panel-none" class="mobile-panel-state" type="radio" name="mobile-panel" checked><input id="mobile-panel-left" class="mobile-panel-state" type="radio" name="mobile-panel"><input id="mobile-panel-right" class="mobile-panel-state" type="radio" name="mobile-panel"><label class="mobile-panel-scrim" for="mobile-panel-none" aria-label="Close side panel"></label><label class="mobile-panel-close mobile-panel-close-left" for="mobile-panel-none" title="Close sessions" aria-label="Close sessions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></label><label class="mobile-panel-close mobile-panel-close-right" for="mobile-panel-none" title="Close workspace" aria-label="Close workspace"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></label>
<svg class="hidden" aria-hidden="true"><defs><symbol id="external-icon-anthropic" viewBox="0 0 24 24"><path fill="currentColor" d="M13.3 3h3.5L22 21h-3.4l-1.2-4.2h-5.9L10.2 21H6.8l6.5-18Zm-.9 10.8h4.1l-2-7-2.1 7ZM2 3h3.3l3.8 12.4L7.4 21 2 3Z"/></symbol><symbol id="external-icon-openai" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.65"><ellipse cx="12" cy="8" rx="3.4" ry="5.2"/><ellipse cx="12" cy="8" rx="3.4" ry="5.2" transform="rotate(60 12 12)"/><ellipse cx="12" cy="8" rx="3.4" ry="5.2" transform="rotate(120 12 12)"/><ellipse cx="12" cy="8" rx="3.4" ry="5.2" transform="rotate(180 12 12)"/><ellipse cx="12" cy="8" rx="3.4" ry="5.2" transform="rotate(240 12 12)"/><ellipse cx="12" cy="8" rx="3.4" ry="5.2" transform="rotate(300 12 12)"/></g></symbol><symbol id="external-icon-hermes" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M6.2 18.7h11.6M8 18.7v-5.3a4 4 0 0 1 8 0v5.3M8.4 12.1c-2.5-.2-4.2-1.4-5.4-3.6 2.3-.3 4.2.3 5.7 1.8M15.6 12.1c2.5-.2 4.2-1.4 5.4-3.6-2.3-.3-4.2.3-5.7 1.8M9.3 7.1c.7-.7 1.6-1.1 2.7-1.1s2 .4 2.7 1.1M12 6V3.5"/></symbol><symbol id="external-icon-pi" viewBox="0 0 24 24"><text x="12" y="18" text-anchor="middle" fill="currentColor" font-size="20" font-family="serif">π</text></symbol></defs></svg>
<aside class="rail"><div class="pi-watermark" aria-hidden="true">π</div><div class="rail-heading"><span>Sessions</span><div class="rail-heading-actions"><button id="show-connection-form" type="button" title="Connect another Pi session" aria-label="Connect another Pi session">+</button><button id="open-settings" type="button" title="Settings" aria-label="Open Settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg></button></div></div><section id="sessions" class="rail-panel sessions-panel"><form id="connection-form" class="hidden"><label>Pi control URL<input id="connection-url" type="url" placeholder="http://127.0.0.1:4173/?token=…" required></label><button type="submit">Connect</button></form><div id="connection-list"></div></section><div id="rail-section-resizer" class="rail-section-resizer" role="separator" aria-label="Resize Sessions and Attention" aria-orientation="horizontal" tabindex="0"></div><div class="rail-heading agent-activity-heading"><span id="attention-heading">Attention</span><button id="open-artifacts" type="button" title="View artifacts" aria-label="View artifacts" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3Z"/><path d="M3 7V5h7l2 2"/></svg></button></div><section id="agent-activity" class="rail-panel agent-activity-panel"><div id="agent-activity-list"></div></section><div id="delegation-panel-host" class="delegation-panel-host"></div></aside>
<div id="left-resizer" class="resizer left-resizer" role="separator" aria-label="Resize navigation" aria-orientation="vertical" tabindex="0"></div>
<main><header class="header"><label class="mobile-panel-toggle" for="mobile-panel-left" title="Sessions" aria-label="Open sessions"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg></label><div id="session-tabs" class="session-tabs" role="tablist" aria-label="Open Pi sessions"></div><button id="show-connection-form-mobile" class="mobile-session-add" type="button" title="Connect another Pi session" aria-label="Connect another Pi session">+</button><label class="mobile-panel-toggle" for="mobile-panel-right" title="Workspace" aria-label="Open Browser, Agents, and Agent Builder"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg></label></header><section id="transcript" aria-live="polite"></section><div class="chat-dock"><div class="controls"><label>Model <select id="model"></select></label><label>Thinking <select id="thinking"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label><span id="phase">idle</span></div><div id="attachment-list" aria-live="polite"></div><form id="composer"><input id="attachment-input" class="hidden" type="file" multiple><button id="attachment-button" type="button" aria-label="Attach files" title="Attach files">+</button><textarea id="prompt" aria-label="Message Pi" placeholder="Message Pi…" rows="1"></textarea><button id="composer-action" type="submit" aria-label="Send message"><svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg><span class="stop-icon" aria-hidden="true"></span></button></form><div class="composer-meta"><button id="session-path" type="button" disabled>Starting Pi…</button><form id="session-path-form" class="hidden"><input id="session-path-input" aria-label="Target directory" autocomplete="off" spellcheck="false"><button type="submit" title="Use target directory" aria-label="Use target directory">✓</button><button id="session-path-cancel" type="button" title="Cancel" aria-label="Cancel target directory edit">×</button></form><span id="status" aria-live="polite">Connecting…</span><span id="session-stats"></span></div></div></main>
<div id="right-resizer" class="resizer right-resizer" role="separator" aria-label="Resize details" aria-orientation="vertical" tabindex="0"></div>
<aside class="details"><nav class="tabs" aria-label="Agent workspace"><button class="active" data-tab="browser">Browser</button><button data-tab="agents-workspace">Agents</button><button data-tab="agent-builder">Agent Builder</button></nav><section id="browser" data-panel><div class="card preview-card"><strong>Browser</strong><form id="preview-form"><button id="preview-back" type="button" title="Back" aria-label="Back" disabled>←</button><button id="preview-forward" type="button" title="Forward" aria-label="Forward" disabled>→</button><input id="preview-address" type="url" placeholder="Open a permitted URL" aria-label="Managed browser address" disabled><button id="preview-reload" type="button" title="Reload" aria-label="Reload managed browser" disabled>↻</button></form><span id="preview-session" class="preview-session"></span><button id="preview-control" type="button" disabled>Take control</button><nav class="preview-tabs" aria-label="Active browsers"></nav><section data-preview-panel="page"><div class="preview-frame"><img id="preview-image" alt="Latest managed browser viewport"></div></section><span id="preview-status" class="preview-status"></span></div></section><section id="agents-workspace" data-panel class="hidden"><div class="agent-workspace-actions"><button id="new-agent" type="button" title="Build a new agent" aria-label="Build a new agent">+</button></div><div id="agent-list" class="agent-grid"></div><section id="selected-agent" class="hidden"><div class="card agent-summary-card"><strong id="selected-agent-title"></strong><span id="selected-agent-meta" class="muted"></span></div><details class="card agent-run-history"><summary>Run history</summary><div id="agent-task-list"></div></details></section><details class="card"><summary>Delegation connections</summary><div id="external-connection-list"></div><div id="external-delegate" class="hidden"><strong id="external-title">External connection</strong><p id="external-description" class="muted"></p><p id="external-warning" class="external-warning"></p><form id="external-run-form"><input id="external-id" type="hidden"><label id="external-prompt-label">Task<textarea id="external-prompt" required></textarea></label><label>Working directory<input id="external-cwd" required></label><label>Model<select id="external-model"></select></label><button type="submit">Delegate</button></form><div id="external-run-list"></div></div></details></section><section id="agent-builder" data-panel class="hidden"><div class="card"><strong id="builder-title">Build a new agent</strong><nav class="builder-tabs"><button class="active" type="button" data-builder-tab="builder-profile-panel">Profile</button><button type="button" data-builder-tab="builder-tools-panel">Model &amp; Tools</button><button type="button" data-builder-tab="builder-connections-panel">Connections</button><button type="button" data-builder-tab="builder-automation-panel">Automation</button></nav><section id="builder-profile-panel" class="builder-panel" data-builder-panel><input id="agent-id" form="agent-form" type="hidden"><label>Name<input id="agent-name" form="agent-form" required></label><label>Description<textarea id="agent-description" form="agent-form" required></textarea></label><label>Project folder<input id="agent-project-root" form="agent-form" required></label><label>Persona<select id="agent-persona-select" form="agent-form"><option value="">Custom</option></select></label><img id="agent-persona-image" class="persona-preview hidden" alt=""><label>Persona instructions<textarea id="agent-persona" form="agent-form" required></textarea></label></section><section id="builder-tools-panel" class="builder-panel hidden" data-builder-panel><label>Model<select id="agent-model" form="agent-form"></select></label><label>Thinking<select id="agent-thinking" form="agent-form"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option selected>high</option><option>xhigh</option><option>max</option></select></label><label>Executor<select id="agent-executor" form="agent-form"><option value="harness">Isolated harness</option><option value="session">Pi session</option></select></label><label>Permissions<select id="agent-permissions" form="agent-form"><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option></select></label><label>Browser access<select id="agent-browser-access" form="agent-form"><option value="disabled">Disabled</option><option value="loopback">Local development only</option><option value="public-web">Public web</option><option value="private-network">Private network</option></select></label><label>Browser engine<select id="agent-browser-runtime" form="agent-form"><option value="managed-chromium">Managed Chromium (recommended)</option><option value="installed-chrome">Installed Chrome compatibility</option></select></label><label>Browser profile<select id="agent-browser-profile-kind" form="agent-form"><option value="ephemeral">Fresh for every run</option><option value="named">Named sign-in profile</option></select></label><label id="agent-browser-profile-id-label" class="hidden">Profile name<input id="agent-browser-profile-id" form="agent-form" pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="signed-in"></label><label class="hidden">Memory<select id="agent-memory" form="agent-form"><option value="none">None</option><option value="notes">Notes</option></select></label><input id="agent-tools" form="agent-form" type="hidden"><input id="agent-capabilities" form="agent-form" type="hidden"><div id="capability-list"></div><details class="capability-section"><summary><strong>Plugin management</strong></summary><form id="plugin-form"><label>Source<input id="plugin-source" placeholder="package@version" required></label><label>Scope<select id="plugin-scope"><option value="user">User</option><option value="project">Project</option></select></label><button type="submit">Install</button></form></details></section><section id="builder-connections-panel" class="builder-panel hidden" data-builder-panel><label>May delegate to agents<input id="agent-delegates" form="agent-form" placeholder="researcher, reviewer"></label><label><input id="agent-a2a" form="agent-form" type="checkbox"> Expose through authenticated A2A</label><details class="capability-section" open><summary><strong>Provider accounts</strong></summary><div id="capability-connection-list"></div><form id="capability-connection-form" class="configuration-form"><input id="capability-connection-id" type="hidden"><label>Provider ID<input id="capability-connection-provider" placeholder="google-workspace" pattern="[a-z0-9][a-z0-9-]{0,63}" required></label><label>Account label<input id="capability-connection-label" placeholder="Work" required></label><label>Secret reference<input id="capability-connection-secret-ref" placeholder="managed:google/work" required></label><label>Status<select id="capability-connection-status"><option value="active">Active</option><option value="unhealthy">Unhealthy</option></select></label><label>Scopes<input id="capability-connection-scopes" placeholder="mail.read, calendar.read"></label><label>Capability grants<input id="capability-connection-capabilities" placeholder="email.search, email.read" required></label><div class="routine-actions"><button type="submit">Save account</button><button id="capability-connection-clear" type="button">Clear</button></div></form></details><details class="capability-section"><summary><strong>Approvals</strong></summary><div id="capability-approval-list"></div></details><details class="capability-section"><summary><strong>Inbound routes</strong></summary><div id="inbound-route-list"></div><form id="inbound-route-form" class="configuration-form"><label>Route ID<input id="inbound-route-id" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" required></label><label>Provider account<select id="inbound-route-connection" required></select></label><label>Destination<select id="inbound-route-kind"><option value="agent">Agent</option><option value="coordinator">Coordinator</option><option value="session">Pi session</option></select></label><label>Destination ID<input id="inbound-route-destination" required></label><label>Allowed senders<input id="inbound-route-senders" placeholder="user@example.com, U123"></label><label>Events per minute<input id="inbound-route-rate" type="number" min="1" max="120" value="10" required></label><label><input id="inbound-route-enabled" type="checkbox" checked> Enabled</label><button type="submit">Save route</button></form></details></section><section id="builder-automation-panel" class="builder-panel hidden" data-builder-panel><details class="capability-section"><summary><strong>Site monitors</strong></summary><div id="site-monitor-list"></div><form id="site-monitor-form" class="configuration-form"><label>ID<input id="site-monitor-id" pattern="[a-z0-9][a-z0-9-]{0,63}" required></label><label>Name<input id="site-monitor-name" required></label><label>Public URL<input id="site-monitor-url" type="url" required></label><label><input id="site-monitor-enabled" type="checkbox" checked> Enabled</label><button type="submit">Save monitor</button></form></details><details class="capability-section"><summary><strong>Finance watchlists</strong></summary><div id="finance-watchlist-list"></div><form id="finance-watchlist-form" class="configuration-form"><label>ID<input id="finance-watchlist-id" pattern="[a-z0-9][a-z0-9-]{0,63}" required></label><label>Name<input id="finance-watchlist-name" required></label><label>Symbols<input id="finance-watchlist-symbols" placeholder="AAPL, MSFT" required></label><label>Provider ID<input id="finance-watchlist-provider" placeholder="Optional"></label><label>Provider account<select id="finance-watchlist-connection"><option value="">None</option></select></label><label><input id="finance-watchlist-enabled" type="checkbox" checked> Enabled</label><button type="submit">Save watchlist</button></form></details><div id="routines"><div id="routine-list"></div></div><div id="workflows"><div id="workflow-list"></div></div></section><form id="agent-form"><button type="submit">Publish agent</button></form></div></section></aside>
<section id="settings-workspace" class="settings-workspace hidden" aria-label="Settings workspace"><header class="settings-header"><div class="settings-heading"><strong id="settings-project-name">Settings</strong><span id="settings-project-path"></span></div><button id="settings-close" class="settings-close" type="button" title="Close Settings" aria-label="Close Settings">×</button></header><div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections"><button type="button" data-settings-section="models">Models</button><button type="button" data-settings-section="connections">Connections</button><button type="button" data-settings-section="capabilities">Capabilities</button><button type="button" data-settings-section="plugins">Plugins &amp; MCP</button><button type="button" data-settings-section="security">Security</button></nav><div class="settings-content"><section id="settings-models" class="settings-panel" data-settings-panel><h2>Models</h2><p class="muted">Models available to this Pi deployment.</p><div id="settings-model-list" class="settings-grid"></div></section><section id="settings-connections" class="settings-panel hidden" data-settings-panel><h2>Connections</h2><p class="muted">Authenticated accounts and external endpoints.</p><div id="settings-connection-list" class="settings-grid"></div><details id="settings-connection-advanced" class="settings-advanced"><summary>Advanced</summary><div id="settings-advanced-connections"></div></details></section><section id="settings-capabilities" class="settings-panel hidden" data-settings-panel><h2>Capabilities</h2><p class="muted">Deployment catalogue and readiness. Agent grants are configured in Agent Builder.</p><input id="settings-capability-search" class="settings-search" type="search" placeholder="Search capabilities" aria-label="Search capabilities"><div id="settings-capability-list"></div></section><section id="settings-plugins" class="settings-panel hidden" data-settings-panel><h2>Plugins &amp; MCP</h2><p class="muted">Deployment-wide installation, enablement, and remote tool health.</p><div id="settings-plugin-list" class="settings-grid"></div><div id="settings-plugin-management"></div><div id="settings-mcp-list" class="settings-grid"></div></section><section id="settings-security" class="settings-panel hidden" data-settings-panel><h2>Security</h2><p class="muted">Credential, approval, browser, and routing controls.</p><div id="settings-security-list"></div></section></div></div></section>
<script src="/browser-client.js?token=${token}"></script></body></html>`;
}
