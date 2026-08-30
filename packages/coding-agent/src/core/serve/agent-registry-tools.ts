import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type {
	AgentBuildAutomationIntent,
	AgentBuildConfiguration,
	AgentBuildLifecycleService,
	AgentBuildRecord,
} from "./agent-build-lifecycle-service.ts";
import type { AgentDefinition, AgentRegistry } from "./agent-registry.ts";
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
	id: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
	name: Type.String({ minLength: 1, maxLength: 128 }),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
	systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	persona: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
	projectRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	tools: Type.Optional(
		Type.Union([
			Type.String({ description: "Comma-separated Pi tool allowlist" }),
			Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 }),
		]),
	),
	model: Type.Optional(Type.String({ description: "Canonical provider/model-id from the active model catalog" })),
	thinking: Type.Optional(thinking),
	memory: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("notes")])),
	executor: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("harness")])),
	permissionPolicy: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")])),
	browserAccess: Type.Optional(browserAccess),
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
});
const lifecycleParameters = Type.Object({
	buildId: Type.String({ pattern: "^build-[a-z0-9-]{1,127}$" }),
	action: Type.Union([
		Type.Literal("publish"),
		Type.Literal("run-proof"),
		Type.Literal("accept-proof"),
		Type.Literal("reject-proof"),
		Type.Literal("promote"),
		Type.Literal("schedule"),
	]),
	confirmed: Type.Boolean({ description: "True only after the user explicitly approved this exact action" }),
	prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
	feedback: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
	rating: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	skillName: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 })),
	skillDescription: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
	skillInstructions: Type.Optional(Type.String({ minLength: 1, maxLength: 65_536 })),
	timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
});

type ConfigureAgentTool = ToolDefinition<typeof configureParameters, { buildId: string; stage: "draft" }>;
type ManageAgentBuildTool = ToolDefinition<typeof lifecycleParameters, { buildId: string; stage: string }>;

export interface AgentRegistryLifecycleTools {
	promotion?: RunSkillPromotionService;
	routines?: RoutineRegistry;
	refreshRoutines?: () => Promise<void>;
}

/** Gives Pi chat the same durable draft lifecycle used by Agent Builder. */
export function createAgentRegistryTools(
	registry: AgentRegistry,
	lifecycle: AgentBuildLifecycleService,
	services: AgentRegistryLifecycleTools = {},
): [ConfigureAgentTool, ManageAgentBuildTool] {
	return [
		{
			name: "configure_agent",
			label: "configure_agent",
			description:
				"Create or update a durable agent draft for review in Agent Builder. This never deploys, runs, promotes, or schedules the agent.",
			promptSnippet:
				"Use configure_agent after progressively clarifying the agent's concrete goal, working folder, model, access, and success criteria. It only stages a durable draft. Tell the user to review and explicitly create or apply it, then run one proof. Automation remains locked until the user accepts the proof and promotes it to a skill.",
			parameters: configureParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const existing = await findExistingAgent(registry, parameters.id, parameters.name);
				const staged = (await lifecycle.list()).find(
					(record) =>
						(existing !== undefined && record.agentId === existing.id) ||
						(!record.agentId && record.name.toLowerCase() === parameters.name.toLowerCase()),
				);
				const base = staged?.configuration ?? (existing ? configurationFromAgent(existing) : undefined);
				const model = parameters.model === undefined ? base?.model : parseModel(parameters.model);
				const tools = normalizeTools(parameters.tools ?? base?.tools ?? ["read", "list"]);
				const access = parameters.browserAccess ?? base?.browserAccess ?? "disabled";
				if (access === "disabled") remove(tools, "browser");
				else if (!tools.includes("browser")) tools.push("browser");
				const permissionPolicy =
					parameters.permissionPolicy ??
					base?.permissionPolicy ??
					(tools.some((tool) => ["write", "edit", "bash"].includes(tool)) ? "workspace-write" : "read-only");
				const projectRoot = parameters.projectRoot ?? base?.projectRoot;
				if (!projectRoot) throw new Error("A projectRoot is required before an agent draft can be saved");
				const description =
					parameters.description ?? base?.description ?? `Complete the goal for ${parameters.name}`;
				const configuration: AgentBuildConfiguration = {
					name: parameters.name,
					description,
					persona:
						parameters.systemPrompt ??
						parameters.persona ??
						base?.persona ??
						`You are ${parameters.name}. Accomplish the stated goal using only the approved tools.`,
					projectRoot,
					tools,
					model,
					thinking: parameters.thinking ?? base?.thinking,
					memory: parameters.memory ?? base?.memory ?? "none",
					executor: parameters.executor ?? base?.executor ?? "harness",
					permissionPolicy,
					browserAccess: access,
					delegateAgentIds: parameters.delegateAgentIds ?? base?.delegateAgentIds ?? [],
					exposeA2a: parameters.exposeA2a ?? base?.exposeA2a ?? false,
				};
				const automationIntent = automation(parameters);
				const build = await lifecycle.stageDraft({
					name: parameters.name,
					objective: description,
					projectRoot,
					configuration,
					automationIntent,
					criteria: parameters.criteria,
					agentId: existing?.id,
				});
				const scheduleNote = automationIntent
					? " The requested schedule was retained as an intent only; it cannot be activated before proof acceptance and skill promotion."
					: "";
				return {
					content: [
						{
							type: "text",
							text: `Staged draft ${build.name} (${build.id}). Review its advanced configuration and explicitly ${existing ? "apply the update" : "create the agent"}.${scheduleNote}`,
						},
					],
					details: { buildId: build.id, stage: "draft" },
				};
			},
		},
		{
			name: "manage_agent_build",
			label: "manage_agent_build",
			description:
				"Perform an explicitly confirmed publish, proof, or proof-review action on a durable Agent Builder package.",
			promptSnippet:
				"Use manage_agent_build only when the user explicitly asks to publish, run the proof, accept it, reject it, promote it, or enable its retained schedule. Confirm the exact interpreted action in plain language first and set confirmed=true only after their yes or direct command. Rejection requires a 1-5 rating and concrete feedback. Never accept a proof with failed mandatory evidence checks. Promotion and scheduling remain separate confirmations.",
			parameters: lifecycleParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				if (!parameters.confirmed) throw new Error("Ask the user to confirm this agent lifecycle action first");
				let build: AgentBuildRecord;
				if (parameters.action === "publish") build = await lifecycle.publishDraft(parameters.buildId);
				else if (parameters.action === "run-proof") {
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
				} else if (parameters.action === "promote") {
					if (!services.promotion) throw new Error("Skill promotion is unavailable");
					const current = await lifecycle.get(parameters.buildId);
					if (!current.proof) throw new Error("This agent build has no reviewed proof to promote");
					await services.promotion.promote({
						runId: current.proof.runId,
						name: parameters.skillName ?? skillName(current.name),
						description:
							parameters.skillDescription ??
							`Repeat the reviewed ${current.name} workflow for similar requests.`,
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
					build = await lifecycle.get(parameters.buildId);
				} else {
					if (!services.routines) throw new Error("Agent scheduling is unavailable");
					const current = await lifecycle.get(parameters.buildId);
					if (!current.agentId || !current.automationIntent) {
						throw new Error("Stage and confirm a schedule intent before enabling automation");
					}
					await lifecycle.assertAutomationAllowed(current.agentId);
					const routine = await services.routines.save({
						id: current.automationIntent.mode === "replace" ? current.routineIds[0] : undefined,
						name: `${current.name} routine`,
						prompt: current.automationIntent.task,
						enabled: true,
						cron: cronFromCadence(current.automationIntent.cadence),
						timezone: parameters.timezone ?? current.automationIntent.timezone,
						maxDurationMinutes: 30,
						target: { kind: "agent", agentId: current.agentId },
						model: current.configuration?.model,
						cwd: current.projectRoot,
					});
					await services.refreshRoutines?.();
					build = await lifecycle.markAutomated(current.agentId, routine.id);
				}
				return {
					content: [
						{
							type: "text",
							text: `Agent build ${build.name} is now ${build.stage}.`,
						},
					],
					details: { buildId: build.id, stage: build.stage },
				};
			},
		},
	];
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

function configurationFromAgent(definition: AgentDefinition): AgentBuildConfiguration {
	return {
		name: definition.name,
		description: definition.description,
		persona: definition.persona,
		projectRoot: definition.projectRoot,
		tools: [...definition.tools],
		model: definition.model ? { ...definition.model } : undefined,
		thinking: definition.thinking,
		memory: definition.memory,
		executor: definition.executor,
		permissionPolicy: definition.permissionPolicy,
		browserAccess: definition.browser?.access ?? "disabled",
		delegateAgentIds: [...definition.delegateAgentIds],
		exposeA2a: definition.a2a.enabled,
	};
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
	return {
		task: parameters.scheduleTask,
		cadence: parameters.scheduleCadence,
		timezone: parameters.scheduleTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
		mode: parameters.scheduleMode ?? "replace",
		confirmed: true,
	};
}
