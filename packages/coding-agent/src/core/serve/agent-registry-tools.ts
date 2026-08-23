import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { BrowserAccess } from "./browser-policy.ts";

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
const deployParameters = Type.Object({
	id: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" })),
	name: Type.String({ minLength: 1, maxLength: 128 }),
	description: Type.String({ minLength: 1, maxLength: 4000 }),
	persona: Type.String({ minLength: 1, maxLength: 20_000 }),
	projectRoot: Type.String({ minLength: 1, maxLength: 4096 }),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 128 })),
	model: Type.Optional(
		Type.Object({
			provider: Type.String({ minLength: 1, maxLength: 128 }),
			id: Type.String({ minLength: 1, maxLength: 256 }),
		}),
	),
	thinking: Type.Optional(thinking),
	executor: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("harness")])),
	permissionPolicy: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")])),
	browserAccess: Type.Optional(browserAccess),
	delegateAgentIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }), { maxItems: 32 })),
	exposeA2a: Type.Optional(Type.Boolean()),
});

/** Gives the primary Pi session a durable, validated path to deploy agents visible in the web console. */
export function createAgentRegistryTools(
	registry: AgentRegistry,
): ToolDefinition<typeof deployParameters, undefined>[] {
	return [
		{
			name: "agent_deploy",
			label: "agent_deploy",
			description: "Create or update a durable local agent definition shown in the Pi Agents workspace.",
			promptSnippet:
				"Use agent_deploy when the user asks to create, configure, update, or deploy a reusable local agent. Model provider and id values must be copied exactly from the active model catalog; never use a display name as the model id. The browser tool defaults to loopback-only access; request public-web or private-network access explicitly when required.",
			parameters: deployParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const existing = parameters.id ? await registry.get(parameters.id) : undefined;
				const tools = [...(parameters.tools ?? existing?.tools ?? ["read", "list"])];
				let access: BrowserAccess | undefined = parameters.browserAccess;
				if (access === undefined) {
					if (parameters.tools === undefined && existing) access = existing.browser?.access ?? "disabled";
					else {
						const existingAccess = existing?.browser?.access;
						access = tools.includes("browser")
							? existingAccess && existingAccess !== "disabled"
								? existingAccess
								: "loopback"
							: "disabled";
					}
				}
				const browserToolIndex = tools.indexOf("browser");
				if (access === "disabled" && browserToolIndex >= 0) tools.splice(browserToolIndex, 1);
				else if (access !== "disabled" && browserToolIndex < 0) tools.push("browser");
				const saved = await registry.save({
					id: parameters.id,
					name: parameters.name,
					description: parameters.description,
					persona: parameters.persona,
					projectRoot: parameters.projectRoot,
					tools,
					model: parameters.model ?? existing?.model,
					thinking: parameters.thinking ?? existing?.thinking,
					memory: existing?.memory ?? "none",
					executor: parameters.executor ?? existing?.executor ?? "harness",
					permissionPolicy: parameters.permissionPolicy ?? existing?.permissionPolicy ?? "read-only",
					schedules: existing?.schedules ?? [],
					browser: {
						access,
						runtime: "managed-chromium",
						profile: { kind: "ephemeral" },
					},
					delegateAgentIds: parameters.delegateAgentIds ?? existing?.delegateAgentIds ?? [],
					a2a: { enabled: parameters.exposeA2a ?? existing?.a2a.enabled ?? false },
				});
				return {
					content: [
						{
							type: "text",
							text: `Deployed agent ${saved.name} (${saved.id}) revision ${saved.revision} for ${saved.projectRoot}`,
						},
					],
					details: undefined,
				};
			},
		},
	];
}
