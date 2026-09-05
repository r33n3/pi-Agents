import { createHash } from "node:crypto";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PiAgentBundle } from "./pi-agent-bundle.ts";
import type { PiAgentTeamLauncher } from "./pi-agent-team-launcher.ts";

const parameters = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 80 }),
	steps: Type.Array(
		Type.Object({
			name: Type.String({ minLength: 1, maxLength: 80 }),
			instructions: Type.String({ minLength: 1, maxLength: 8000 }),
			tools: Type.Optional(Type.Array(Type.Union([Type.Literal("read"), Type.Literal("ls")]), { maxItems: 2 })),
		}),
		{
			minItems: 2,
			maxItems: 6,
			description:
				"Ordered specialist steps, ending with the coordinator that summarizes their results. Each step receives the user request and previous results.",
		},
	),
});

/** Compiles the common read-only team into the existing reviewed workflow contract. */
export function createTeamDraftTool(launcher: PiAgentTeamLauncher): ToolDefinition<typeof parameters> {
	return {
		name: "configure_team",
		label: "Prepare team",
		description:
			"Prepare a read-only, on-demand team for review. Supply reusable specialist responsibilities without fixed input filenames, with the final coordinator last. Input files belong to each user request. For file-review teams, include the read tool for every role, including the coordinator, so the host can supply verified inputs. The host wires the steps and forwards their outputs. This does not launch or run anything. Use this for a team request instead of pretending one agent has unconfigured delegates. The user reviews the team and clicks Launch team.",
		parameters,
		executionMode: "sequential",
		async execute(_id, input, _signal, _onUpdate, context) {
			if (!context.model) throw new Error("Select a model before preparing the team");
			const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const nameDigest = createHash("sha256").update(input.name.trim().toLowerCase()).digest("hex").slice(0, 16);
			const bundleId = `local-team-${nameDigest}`;
			const roles = input.steps.map((step, index) => ({
				id: `step-${index + 1}`,
				name: step.name,
				description: step.instructions,
				instructions: `${step.instructions}\nPerform only your assigned role; do not impersonate another specialist. Input filenames in these instructions are defaults: use the input explicitly requested for the current run, without substituting a different file. Use only observed evidence. If required input is missing or a predecessor reports failure, clearly report the limitation; do not invent a successful result.`,
				acceptanceCriteria: [],
				outputSchema: {},
				tools: [...new Set(step.tools ?? [])].map((name) => ({ name, version: 1, effect: "read" as const })),
				permissionPolicy: "read-only" as const,
				memory: { readableNamespaces: [], writableNamespaces: [] },
				policies: { escalationRules: [], stopConditions: [], forbiddenTools: [], guardrails: [] },
				delegateRoleIds: [],
			}));
			const bundle: PiAgentBundle = {
				schemaVersion: "pi.agents.bundle.v1",
				bundleId,
				packageId: bundleId,
				effectiveSourceDigest: digest,
				contractDigest: digest,
				executionForm: "pi-team-v1",
				roles,
				workflow: {
					id: bundleId,
					name: input.name,
					coordinatorRoleId: roles.at(-1)!.id,
					nodes: roles.map((role) => ({
						id: role.id,
						roleId: role.id,
						prompt: role.instructions,
						required: true,
					})),
					edges: roles.slice(1).map((role, index) => ({ from: roles[index]!.id, to: role.id })),
					maxConcurrency: 1,
					maxDelegationDepth: roles.length,
					failurePolicy: "stop",
				},
				assurance: { adapterId: "pi-local-team", adapterVersion: "1" },
			};
			const prepared = launcher.prepareWithLocalDefaults(bundle, context.cwd, {
				provider: context.model.provider,
				id: context.model.id,
			});
			return {
				content: [
					{
						type: "text",
						text: `Team ${input.name} is ready for review: ${roles.map((role) => role.name).join(" → ")}. Read-only, on demand, using the current model and folder. Review the team card and click Launch team, then ask it a question. It has not run yet.`,
					},
				],
				details: { teamDraft: { ...prepared, preparedAt: Date.now() } },
			};
		},
	};
}
