import { randomUUID } from "node:crypto";
import { ModelControlsError } from "@earendil-works/pi-ai";
import { ModelControlsSchema } from "@earendil-works/pi-protocol";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type AgentBuildAutomationIntent,
	type AgentBuildConfiguration,
	type AgentBuildLifecycleService,
	type AgentBuildRecord,
	configurationFromAgent,
	parseAgentCapabilityGrants,
} from "./agent-build-lifecycle-service.ts";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
import type {
	AgentBuildActionKind,
	ConversationBuildCoordinator,
	ConversationBuildView,
} from "./conversation-build-coordinator.ts";
import { validateCron } from "./cron-schedule.ts";
import type { RoutineRegistry } from "./routine-registry.ts";
import type { RunSkillPromotionService } from "./run-skill-promotion-service.ts";

const thinking = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);
const browserAccess = Type.Union([
	Type.Literal("disabled"),
	Type.Literal("loopback"),
	Type.Literal("public-web"),
	Type.Literal("private-network"),
]);
const configureParameters = Type.Object({
	buildId: Type.Optional(Type.String({ pattern: "^build-[a-z0-9-]{1,127}$" })),
	expectedBuildRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("edit"), Type.Literal("improve")])),
	id: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
	name: Type.String({ minLength: 1, maxLength: 128 }),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
	systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	persona: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	projectRoot: Type.Optional(
		Type.String({
			minLength: 1,
			maxLength: 4096,
			description:
				"Workspace directory. Omit to preserve the existing draft/agent workspace or use the current session directory for a new draft.",
		}),
	),
	tools: Type.Optional(
		Type.Union([
			Type.String({ description: "Comma-separated Pi tool allowlist" }),
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
		]),
	),
	capabilities: Type.Optional(
		Type.Array(Type.Unknown(), {
			maxItems: 128,
			description:
				"Complete capability grant list; each grant requires capabilityId and capabilityVersion. Omit to preserve, [] to clear.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Canonical provider/model-id from the active model catalog" })),
	thinking: Type.Optional(thinking),
	modelControls: Type.Optional(
		Type.Union([ModelControlsSchema, Type.Null()], {
			description:
				"Provider-native settings for the selected model. Omit to preserve, {} for provider defaults, null for legacy thinking. Choose premium processing only when the user requests it.",
		}),
	),
	memory: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("notes")])),
	executor: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("harness")])),
	permissionPolicy: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")])),
	browserAccess: Type.Optional(browserAccess),
	browserRuntime: Type.Optional(Type.Union([Type.Literal("managed-chromium"), Type.Literal("installed-chrome")])),
	browserProfile: Type.Optional(
		Type.Union([
			Type.Object({ kind: Type.Literal("ephemeral") }),
			Type.Object({ kind: Type.Literal("named"), id: Type.String({ minLength: 1, maxLength: 128 }) }),
		]),
	),
	browserWorkflows: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
				version: Type.Integer({ minimum: 1 }),
			}),
			{ maxItems: 128 },
		),
	),
	delegateAgentIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }), { maxItems: 32 })),
	exposeA2a: Type.Optional(Type.Boolean()),
	scheduleTask: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	scheduleCadence: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	scheduleTimezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	scheduleConfirmed: Type.Optional(Type.Boolean()),
	scheduleMode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("additional")])),
	criteria: Type.Optional(
		Type.Array(Type.Unknown(), {
			maxItems: 64,
			description: "Pass/fail/unverified improvement criteria retained with this package",
		}),
	),
	assumptions: Type.Optional(
		Type.Array(
			Type.Object({
				topic: Type.String({ minLength: 1, maxLength: 128 }),
				value: Type.String({ minLength: 1, maxLength: 2_000 }),
				rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
			}),
			{ maxItems: 32 },
		),
	),
	clarifications: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				topic: Type.String({ minLength: 1, maxLength: 128 }),
				materialTopic: Type.Union([
					Type.Literal("outcome"),
					Type.Literal("scope"),
					Type.Literal("recipient"),
					Type.Literal("authority"),
					Type.Literal("data-source"),
					Type.Literal("schedule"),
					Type.Literal("cost"),
					Type.Literal("acceptance"),
					Type.Literal("identity"),
				]),
				question: Type.String({ minLength: 1, maxLength: 2_000 }),
				reason: Type.String({ minLength: 1, maxLength: 2_000 }),
				blockingActions: Type.Array(
					Type.Union([
						Type.Literal("activate"),
						Type.Literal("publish"),
						Type.Literal("publish-and-schedule"),
						Type.Literal("run-proof"),
						Type.Literal("accept-proof"),
						Type.Literal("reject-proof"),
						Type.Literal("promote"),
						Type.Literal("schedule"),
					]),
					{ minItems: 1, maxItems: 6 },
				),
			}),
			{ maxItems: 3 },
		),
	),
	answeredClarificationIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 3 })),
});
const lifecycleParameters = Type.Object({
	buildId: Type.String({ pattern: "^build-[a-z0-9-]{1,127}$" }),
	action: Type.Union([
		Type.Literal("activate"),
		Type.Literal("publish"),
		Type.Literal("publish-and-schedule"),
		Type.Literal("run-proof"),
		Type.Literal("accept-proof"),
		Type.Literal("reject-proof"),
		Type.Literal("promote"),
		Type.Literal("schedule"),
	]),
	confirmed: Type.Boolean({ description: "True only after the user explicitly approved this exact action" }),
	confirmationText: Type.Optional(
		Type.String({ minLength: 1, maxLength: 2_000, description: "The user's exact confirmation response" }),
	),
	proposalId: Type.Optional(Type.String({ pattern: "^proposal-[a-z0-9-]{1,127}$" })),
	prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	feedback: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
	rating: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	skillName: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 })),
	skillDescription: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
	skillInstructions: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
	timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});
const inspectParameters = Type.Object({
	buildId: Type.Optional(Type.String({ pattern: "^build-[a-z0-9-]{1,127}$" })),
});

type ConfigureAgentTool = ToolDefinition<
	typeof configureParameters,
	{ buildId: string; buildRevision: number; stage: "draft"; openClarificationIds: string[] }
>;
type ManageAgentBuildTool = ToolDefinition<
	typeof lifecycleParameters,
	{
		buildId: string;
		stage: string;
		proposalId?: string;
		proposalDigest?: string;
		proposalState?: "pending" | "completed";
	}
>;
type InspectAgentBuildTool = ToolDefinition<
	typeof inspectParameters,
	{ builds: Array<{ buildId: string; revision: number; stage: string; ready: boolean }> }
>;

export interface AgentRegistryLifecycleTools {
	promotion?: RunSkillPromotionService;
	routines?: RoutineRegistry;
	refreshRoutines?: () => Promise<void>;
	conversationBuilds?: ConversationBuildCoordinator;
	sessionId?: string;
}

/** Gives Pi chat the same durable draft lifecycle used by Agent Builder. */
export function createAgentRegistryTools(
	registry: AgentRegistry,
	lifecycle: AgentBuildLifecycleService,
	services: AgentRegistryLifecycleTools = {},
): [ConfigureAgentTool, ManageAgentBuildTool, InspectAgentBuildTool] {
	return [
		{
			name: "configure_agent",
			label: "configure_agent",
			description:
				"Create or update a durable agent draft for review in Agent Builder. This never deploys, runs, promotes, or schedules the agent.",
			promptSnippet:
				"Use configure_agent as soon as a useful reversible draft can be formed. Infer safe defaults and record them as assumptions. Ask at most one concise question when two plausible answers materially change outcome, scope, recipient, authority, data, schedule, cost, acceptance, or identity; record it in clarifications while still staging unaffected fields. Cosmetic choices are not questions. This never deploys. Test the unpublished candidate, review its evidence, then use manage_agent_build for an exact action proposal.",
			parameters: configureParameters,
			executionMode: "sequential",
			async execute(toolCallId, parameters, _signal, _onUpdate, context) {
				if (parameters.modelControls != null && parameters.thinking !== undefined)
					throw new ModelControlsError("Choose agent modelControls or legacy thinking, not both");
				const existing = await findExistingAgent(registry, parameters.id, parameters.name);
				const staged = parameters.buildId
					? await lifecycle.get(parameters.buildId)
					: (await lifecycle.list()).find(
							(record) =>
								(existing !== undefined && record.agentId === existing.id) ||
								(!record.agentId && record.name.toLowerCase() === parameters.name.toLowerCase()),
						);
				const base = staged?.configuration ?? (existing ? configurationFromAgent(existing) : undefined);
				const model = parameters.model === undefined ? base?.model : parseModel(parameters.model);
				const modelControls =
					parameters.modelControls !== undefined
						? (parameters.modelControls ?? undefined)
						: parameters.thinking === undefined
							? base?.modelControls
							: undefined;
				const tools = normalizeTools(parameters.tools ?? base?.tools ?? ["read", "list"]);
				const access = parameters.browserAccess ?? base?.browserAccess ?? "disabled";
				if (access === "disabled") remove(tools, "browser");
				else if (!tools.includes("browser")) tools.push("browser");
				const permissionPolicy =
					parameters.permissionPolicy ??
					base?.permissionPolicy ??
					(tools.some((tool) => ["write", "edit", "bash"].includes(tool)) ? "workspace-write" : "read-only");
				const projectRoot = parameters.projectRoot ?? base?.projectRoot ?? context.cwd;
				if (!projectRoot) throw new Error("A projectRoot is required before an agent draft can be saved");
				const description =
					parameters.description ?? base?.description ?? `Complete the goal for ${parameters.name}`;
				const configuration: AgentBuildConfiguration = {
					personaId: base?.personaId,
					name: parameters.name,
					description,
					persona:
						parameters.systemPrompt ??
						parameters.persona ??
						base?.persona ??
						`You are ${parameters.name}. Accomplish the stated goal using only the approved tools.`,
					projectRoot,
					tools,
					capabilities: parseAgentCapabilityGrants(parameters.capabilities) ?? base?.capabilities,
					model,
					thinking: modelControls === undefined ? (parameters.thinking ?? base?.thinking) : undefined,
					modelControls,
					memory: parameters.memory ?? base?.memory ?? "none",
					executor: parameters.executor ?? base?.executor ?? "harness",
					permissionPolicy,
					browserAccess: access,
					browserRuntime: parameters.browserRuntime ?? base?.browserRuntime,
					browserProfile: parameters.browserProfile ?? base?.browserProfile,
					browserWorkflows: parameters.browserWorkflows ?? base?.browserWorkflows,
					delegateAgentIds: parameters.delegateAgentIds ?? base?.delegateAgentIds ?? [],
					exposeA2a: parameters.exposeA2a ?? base?.exposeA2a ?? false,
				};
				const automationIntent = automation(parameters);
				const draft = {
					name: parameters.name,
					objective: description,
					projectRoot,
					configuration,
					automationIntent,
					criteria: parameters.criteria,
					agentId: existing?.id,
				};
				const conversation = services.conversationBuilds;
				const view = conversation
					? await conversation.applyIntent({
							sessionId: requiredConversationSessionId(services),
							mode: parameters.mode ?? (existing ? "edit" : "create"),
							sourceMessageId: toolCallId,
							buildId: parameters.buildId ?? staged?.id,
							expectedBuildRevision: parameters.buildId ? parameters.expectedBuildRevision : staged?.revision,
							draft,
							assumptions: parameters.assumptions,
							clarifications: parameters.clarifications,
							answeredClarificationIds: parameters.answeredClarificationIds,
						})
					: undefined;
				const build = view?.build ?? (await lifecycle.stageDraft(draft));
				const scheduleNote = automationIntent
					? " The requested schedule was retained as an intent only; it requires proof acceptance and activation. Skill export is optional."
					: "";
				const openClarifications = view?.link?.clarifications.filter((item) => item.status === "open") ?? [];
				const clarificationNote =
					openClarifications.length > 0
						? ` Material question: ${openClarifications.map((item) => item.question).join(" ")}`
						: "";
				return {
					content: [
						{
							type: "text",
							text: `Staged draft ${build.name} (${build.id}, revision ${build.revision}). Workspace: ${projectRoot}${parameters.projectRoot === undefined && base?.projectRoot === undefined ? " (defaulted to the current session directory)" : ""}. Test it before publication.${clarificationNote}${scheduleNote}`,
						},
					],
					details: {
						buildId: build.id,
						buildRevision: build.revision,
						stage: "draft",
						openClarificationIds: openClarifications.map((item) => item.id),
					},
				};
			},
		},
		{
			name: "manage_agent_build",
			label: "manage_agent_build",
			description:
				"Perform an explicitly confirmed publish, proof, or proof-review action on a durable Agent Builder package.",
			promptSnippet:
				"Use manage_agent_build for testing, proof review, activation, optional skill export, or scheduling. First omit proposalId and use confirmed=false to prepare an exact proposal. After a later user approval, call again with its proposalId and confirmed=true. The host verifies the actual user message; confirmationText grants no authority. When several proposals are pending, the user must reply approve followed by the exact proposal ID. Activate after accepting proof; skill export is optional. Rejection requires a 1-5 rating and concrete feedback.",
			parameters: lifecycleParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const conversation = services.conversationBuilds;
				const sessionId = conversation ? requiredConversationSessionId(services) : undefined;
				const payload = exactActionPayload(parameters);
				if (conversation && !parameters.proposalId) {
					if (parameters.confirmed)
						throw new Error(
							"proposalId is required for confirmation. Use inspect_agent_build to recover the pending proposal ID, then retry the same approved action. Do not prepare a replacement proposal.",
						);
					const current = await lifecycle.get(parameters.buildId);
					const proposal = await conversation.prepareAction({
						buildId: parameters.buildId,
						sessionId: sessionId!,
						action: parameters.action,
						payload,
						preview: actionPreview(current, parameters.action, payload),
					});
					return {
						content: [
							{
								type: "text",
								text: `${proposal.binding.preview}\n\nProposal ID: ${proposal.id}\nReply yes to approve this exact action, or no to leave it pending. After approval, call manage_agent_build with proposalId ${proposal.id}, confirmed=true, and the same action payload.`,
							},
						],
						details: {
							buildId: current.id,
							stage: current.stage,
							proposalId: proposal.id,
							proposalDigest: proposal.binding.digest,
							proposalState: "pending",
						},
					};
				}
				if (!parameters.confirmed)
					throw new Error("Ask the user to confirm this exact agent lifecycle proposal first");
				if (conversation) {
					const authorized = await conversation.authorizeAction({
						proposalId: parameters.proposalId!,
						buildId: parameters.buildId,
						sessionId: sessionId!,
						action: parameters.action,
						payload,
					});
					if (authorized.state === "completed") {
						const current = await lifecycle.get(parameters.buildId);
						return {
							content: [
								{
									type: "text",
									text: `This action already completed. Recorded result: ${JSON.stringify(authorized.result)}`,
								},
							],
							details: {
								buildId: current.id,
								stage: current.stage,
								proposalId: authorized.id,
								proposalState: "completed",
							},
						};
					}
				}
				let build: AgentBuildRecord;
				let partialResult: Record<string, unknown> | undefined;
				try {
					if (parameters.action === "activate") build = await lifecycle.activate(parameters.buildId);
					else if (parameters.action === "publish") build = await lifecycle.publishDraft(parameters.buildId);
					else if (parameters.action === "publish-and-schedule") {
						if (!services.routines) throw new Error("Agent scheduling is unavailable");
						const current = await lifecycle.get(parameters.buildId);
						if (!current.automationIntent?.confirmed) throw new Error("Confirm the schedule intent first");
						validateCron(
							cronFromCadence(current.automationIntent.cadence),
							parameters.timezone ?? current.automationIntent.timezone,
						);
						build = await lifecycle.publishDraft(parameters.buildId);
						partialResult = {
							publish: { status: "completed", agentId: build.agentId, revision: build.agentRevision },
							schedule: { status: "pending" },
						};
						if (conversation && parameters.proposalId)
							await conversation.recordActionProgress(parameters.proposalId, partialResult);
						build = await scheduleAgentBuild(lifecycle, services.routines, services.refreshRoutines, parameters);
						partialResult.schedule = { status: "completed", routineIds: build.routineIds };
					} else if (parameters.action === "run-proof") {
						if (!parameters.prompt) throw new Error("A concrete proof task is required");
						build = await lifecycle.startProof(parameters.buildId, parameters.prompt);
					} else if (parameters.action === "accept-proof") {
						build = await lifecycle.reviewProof(parameters.buildId, true);
					} else if (parameters.action === "reject-proof") {
						if (!parameters.feedback || parameters.rating === undefined) {
							throw new Error("Rejecting a proof requires a 1-5 rating and improvement feedback");
						}
						build = await lifecycle.recordFeedback(parameters.buildId, {
							rating: parameters.rating,
							summary: parameters.feedback,
						});
						if (build.stage === "proof-ready") build = await lifecycle.reviewProof(parameters.buildId, false);
					} else if (parameters.action === "promote")
						build = await promoteAgentBuild(lifecycle, services.promotion, parameters);
					else
						build = await scheduleAgentBuild(lifecycle, services.routines, services.refreshRoutines, parameters);
					if (conversation && parameters.proposalId) {
						await conversation.completeAction(parameters.proposalId, {
							buildId: build.id,
							buildRevision: build.revision,
							stage: build.stage,
							actions: partialResult,
						});
					}
				} catch (error) {
					if (conversation && parameters.proposalId) {
						await conversation.failAction(
							parameters.proposalId,
							error instanceof Error ? error.message : String(error),
							partialResult,
						);
					}
					throw error;
				}
				return {
					content: [
						{
							type: "text",
							text:
								parameters.action === "activate"
									? `Agent ${build.name} revision ${build.agentRevision} is active. Skill export is optional.`
									: `Agent build ${build.name} is now ${build.stage}.`,
						},
					],
					details: {
						buildId: build.id,
						stage: build.stage,
						proposalId: parameters.proposalId,
						proposalState: parameters.proposalId ? "completed" : undefined,
					},
				};
			},
		},
		{
			name: "inspect_agent_build",
			label: "inspect_agent_build",
			description:
				"Inspect current agent draft, proof, evidence, questions, readiness, and pending approval without changing anything.",
			promptSnippet:
				"Use inspect_agent_build when the user asks how an agent build or test is progressing, what remains, or whether it is ready. This is read-only and never requires confirmation.",
			parameters: inspectParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const conversation = services.conversationBuilds;
				const views: ConversationBuildView[] = conversation
					? parameters.buildId
						? [await conversation.inspect(parameters.buildId)]
						: await conversation.list(requiredConversationSessionId(services))
					: (parameters.buildId ? [await lifecycle.get(parameters.buildId)] : await lifecycle.list()).map(
							(build) => ({
								build,
								link: undefined,
								proposals: [],
								readiness: { ready: build.stage === "proven", blockers: [] },
							}),
						);
				const summaries = views.map((view) => {
					const checks = view.build.evaluation?.checks ?? [];
					const openQuestions = view.link?.clarifications.filter((item) => item.status === "open") ?? [];
					const proposal = view.proposals.find((item) => item.state === "pending");
					return [
						`${view.build.name} (${view.build.id}, revision ${view.build.revision})`,
						`Stage: ${view.build.stage}`,
						`Active accepted revision: ${view.build.activeProof?.agentRevision ?? "none"}; candidate revision: ${view.build.candidateRevision ?? "none"}`,
						view.build.proof
							? `Proof: ${view.build.proof.status} (${view.build.proof.runId})`
							: "Proof: not started",
						checks.length > 0
							? `Evidence: ${checks.filter((check) => check.status === "pass").length} passed, ${checks.filter((check) => check.status === "fail").length} failed, ${checks.filter((check) => check.status === "unverified").length} unverified`
							: "Evidence: not evaluated",
						`Readiness: ${view.readiness.ready ? "ready" : view.readiness.blockers.join("; ") || "not ready"}`,
						...(openQuestions.length > 0
							? [`Open decisions: ${openQuestions.map((item) => item.question).join(" ")}`]
							: []),
						...(proposal ? [`Pending approval (${proposal.id}): ${proposal.binding.preview}`] : []),
					].join("\n");
				});
				return {
					content: [
						{ type: "text", text: summaries.join("\n\n") || "No agent builds are linked to this session." },
					],
					details: {
						builds: views.map((view) => ({
							buildId: view.build.id,
							revision: view.build.revision,
							stage: view.build.stage,
							ready: view.readiness.ready,
						})),
					},
				};
			},
		},
	];
}

interface ExactAgentBuildActionParameters {
	buildId: string;
	proposalId?: string;
	action: AgentBuildActionKind;
	prompt?: string;
	feedback?: string;
	rating?: number;
	skillName?: string;
	skillDescription?: string;
	skillInstructions?: string;
	timezone?: string;
}

function exactActionPayload(parameters: ExactAgentBuildActionParameters): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		buildId: parameters.buildId,
		action: parameters.action,
	};
	for (const key of [
		"prompt",
		"feedback",
		"rating",
		"skillName",
		"skillDescription",
		"skillInstructions",
		"timezone",
	] as const) {
		if (parameters[key] !== undefined) payload[key] = parameters[key];
	}
	return payload;
}

function actionPreview(
	build: AgentBuildRecord,
	action: AgentBuildActionKind,
	payload: Record<string, unknown>,
): string {
	const heading =
		action === "run-proof"
			? "Test candidate"
			: action === "accept-proof"
				? "Accept proof"
				: action === "reject-proof"
					? "Reject proof"
					: action === "promote"
						? "Promote reviewed workflow"
						: action === "schedule"
							? "Enable routine"
							: action === "publish-and-schedule"
								? "Activate and enable routine"
								: "Activate agent";
	const details = [
		`${heading}: ${build.name}`,
		`Build revision: ${build.revision}`,
		`Outcome: ${build.objective}`,
		`Workspace: ${build.projectRoot}`,
	];
	if (build.proof) details.push(`Proof: ${build.proof.runId} (${build.proof.status})`);
	if (build.evaluation) {
		details.push(
			`Evidence: ${build.evaluation.checks.filter((check) => check.status === "pass").length}/${build.evaluation.checks.length} checks passed`,
		);
	}
	if (typeof payload.prompt === "string") details.push(`Test task: ${payload.prompt}`);
	if (typeof payload.timezone === "string") details.push(`Timezone: ${payload.timezone}`);
	if (build.automationIntent && (action === "schedule" || action === "publish-and-schedule")) {
		details.push(
			`Schedule: ${build.automationIntent.cadence} ${payload.timezone ?? build.automationIntent.timezone}`,
			`Routine task: ${build.automationIntent.task}`,
		);
	}
	if (build.configuration) {
		details.push(
			`Model: ${build.configuration.model ? `${build.configuration.model.provider}/${build.configuration.model.id}` : "session default"}`,
			`Model controls: ${build.configuration.modelControls ? JSON.stringify(build.configuration.modelControls) : `legacy thinking ${build.configuration.thinking ?? "inherited"}`}`,
			`Tools: ${build.configuration.tools.join(", ") || "none"}`,
			`Capability grants: ${build.configuration.capabilities?.map((grant) => `${grant.capabilityId}@${grant.capabilityVersion} (${grant.approval ?? "default"}${grant.providerId ? `, ${grant.providerId}` : ""}${grant.connectionId ? `, account ${grant.connectionId}` : ""})`).join("; ") || "none"}`,
			`Permissions: ${build.configuration.permissionPolicy}`,
			`Browser access: ${build.configuration.browserAccess}`,
		);
	}
	return details.join("\n");
}

function requiredConversationSessionId(services: AgentRegistryLifecycleTools): string {
	const sessionId = services.sessionId?.trim();
	if (!sessionId) throw new Error("Conversation build tools require an active Pi session identity");
	return sessionId;
}

async function promoteAgentBuild(
	lifecycle: AgentBuildLifecycleService,
	promotion: RunSkillPromotionService | undefined,
	parameters: ExactAgentBuildActionParameters,
): Promise<AgentBuildRecord> {
	if (!promotion) throw new Error("Skill promotion is unavailable");
	const current = await lifecycle.get(parameters.buildId);
	if (!current.proof) throw new Error("This agent build has no reviewed proof to promote");
	await promotion.promote({
		runId: current.proof.runId,
		name: parameters.skillName ?? skillName(current.name),
		description: parameters.skillDescription ?? `Repeat the reviewed ${current.name} workflow for similar requests.`,
		instructions:
			parameters.skillInstructions ??
			[
				`Perform the reviewed ${current.name} workflow for this task:`,
				"",
				current.proof.prompt,
				"",
				"Respect the active workspace and capability grants. Verify every retained criterion before reporting completion.",
			].join("\n"),
	});
	return lifecycle.get(parameters.buildId);
}

async function scheduleAgentBuild(
	lifecycle: AgentBuildLifecycleService,
	routines: RoutineRegistry | undefined,
	refreshRoutines: (() => Promise<void>) | undefined,
	parameters: ExactAgentBuildActionParameters,
): Promise<AgentBuildRecord> {
	if (!routines) throw new Error("Agent scheduling is unavailable");
	const current = await lifecycle.get(parameters.buildId);
	if (!current.agentId || !current.automationIntent) {
		throw new Error("Stage and confirm a schedule intent before enabling automation");
	}
	await lifecycle.assertAutomationAllowed(current.agentId);
	if (!current.automationIntent.confirmed) throw new Error("Confirm the schedule intent before enabling automation");
	const routine = await routines.save({
		id:
			current.automationIntent.mode === "replace" && current.routineIds[0]
				? current.routineIds[0]
				: `routine-${parameters.proposalId?.replace(/^proposal-/, "") ?? randomUUID()}`,
		name: `${current.name} routine`,
		prompt: current.automationIntent.task,
		enabled: true,
		cron: cronFromCadence(current.automationIntent.cadence),
		timezone: parameters.timezone ?? current.automationIntent.timezone,
		maxDurationMinutes: 30,
		target: { kind: "agent", agentId: current.agentId },
		model: current.activeConfiguration?.model,
		cwd: current.activeConfiguration?.projectRoot ?? current.projectRoot,
	});
	await refreshRoutines?.();
	return lifecycle.markAutomated(current.agentId, routine.id);
}

function skillName(value: string): string {
	const name = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64)
		.replace(/-$/, "");
	if (!name) throw new Error("Provide a valid skillName before promotion");
	return name;
}

function cronFromCadence(value: string): string {
	const cadence = value.trim();
	const daily = /^daily\s+(\d{2}):(\d{2})$/i.exec(cadence);
	if (daily) return `${Number(daily[2])} ${Number(daily[1])} * * *`;
	if (/^hourly$/i.test(cadence)) return "0 * * * *";
	const weekly = /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+(\d{2}):(\d{2})$/i.exec(cadence);
	if (weekly) {
		const day = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(weekly[1]!.toLowerCase());
		return `${Number(weekly[3])} ${Number(weekly[2])} * * ${day}`;
	}
	const interval = /^every\s+(\d+)(m|h)$/i.exec(cadence);
	if (interval) {
		const amount = Number(interval[1]);
		if (amount < 1) throw new Error("Schedule cadence interval must be positive");
		return interval[2]!.toLowerCase() === "m" ? `*/${amount} * * * *` : `0 */${amount} * * *`;
	}
	throw new Error("Supported schedule cadences are daily HH:MM, hourly, weekly DAY HH:MM, or every Nm/Nh");
}

async function findExistingAgent(
	registry: AgentRegistry,
	id: string | undefined,
	name: string,
): Promise<AgentDefinition | undefined> {
	if (id) {
		const definition = await registry.get(id);
		if (!definition && id.toLowerCase() === name.toLowerCase()) return undefined;
		if (!definition) throw new Error(`Agent ${id} was not found`);
		return definition;
	}
	return (await registry.list()).find((agent) => agent.name.toLowerCase() === name.toLowerCase());
}

function parseModel(value: string): { provider: string; id: string } {
	const separator = value.indexOf("/");
	if (separator < 1 || separator === value.length - 1) {
		throw new Error(`Invalid agent model ${value}. Use the canonical provider/model-id format.`);
	}
	return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function normalizeTools(value: string | string[]): string[] {
	const tools = Array.isArray(value) ? value : value.split(",");
	return [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))];
}

function remove(values: string[], value: string): void {
	const index = values.indexOf(value);
	if (index >= 0) values.splice(index, 1);
}

function automation(parameters: {
	scheduleTask?: string;
	scheduleCadence?: string;
	scheduleTimezone?: string;
	scheduleConfirmed?: boolean;
	scheduleMode?: "replace" | "additional";
}): AgentBuildAutomationIntent | undefined {
	const hasTask = parameters.scheduleTask !== undefined;
	const hasCadence = parameters.scheduleCadence !== undefined;
	if (hasTask !== hasCadence) throw new Error("Scheduling requires both scheduleTask and scheduleCadence");
	if (!hasTask || !parameters.scheduleTask || !parameters.scheduleCadence) return undefined;
	if (parameters.scheduleConfirmed !== true) {
		throw new Error("Do not choose a schedule for the user. Ask them to select or confirm the cadence first.");
	}
	const timezone = parameters.scheduleTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	validateCron(cronFromCadence(parameters.scheduleCadence), timezone);
	return {
		task: parameters.scheduleTask,
		cadence: parameters.scheduleCadence,
		timezone,
		mode: parameters.scheduleMode ?? "replace",
		confirmed: true,
	};
}
