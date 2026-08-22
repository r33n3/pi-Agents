import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentRegistry } from "./agent-registry.ts";

const thinking = Type.Union(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)),
);
const browserAccess = Type.Union(
	["disabled", "loopback", "public-web", "private-network"].map((value) => Type.Literal(value)),
);
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
				"Use agent_deploy when the user asks to create, configure, update, or deploy a reusable local agent.",
			parameters: deployParameters,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				const existing = parameters.id ? await registry.get(parameters.id) : undefined;
				const saved = await registry.save({
					id: parameters.id,
					name: parameters.name,
					description: parameters.description,
					persona: parameters.persona,
					projectRoot: parameters.projectRoot,
					tools: parameters.tools ?? existing?.tools ?? ["read", "list"],
					model: parameters.model ?? existing?.model,
					thinking: parameters.thinking ?? existing?.thinking,
					memory: existing?.memory ?? "none",
					executor: parameters.executor ?? existing?.executor ?? "harness",
					permissionPolicy: parameters.permissionPolicy ?? existing?.permissionPolicy ?? "read-only",
					schedules: existing?.schedules ?? [],
					browser: {
						access: parameters.browserAccess ?? existing?.browser?.access ?? "disabled",
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
