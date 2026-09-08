import { createBashToolDefinition } from "../tools/bash.ts";
import { createPowerShellToolDefinition } from "../tools/powershell.ts";
import type { AgentExecutionContext } from "./agent-executor.ts";
import type { GovernedActionService } from "./governed-action-service.ts";

/** Explicit shell grants authorize host access, not a filesystem sandbox. */
export function createAgentCommandTools(
	context: AgentExecutionContext,
	environment: NodeJS.ProcessEnv,
	governed: GovernedActionService | undefined,
) {
	return (["bash", "powershell"] as const)
		.filter((name) => context.definition.tools.includes(name))
		.map((name) => {
			if (context.definition.permissionPolicy !== "workspace-write")
				throw new Error("Host command execution requires write permission");
			if (!governed) throw new Error("Host command execution requires the action gateway");
			const options = {
				exposeSessionEnvironment: false,
				spawnHook: (spawn: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
					...spawn,
					env: { ...environment },
				}),
			};
			const tool =
				name === "powershell"
					? createPowerShellToolDefinition(context.workspace, options)
					: createBashToolDefinition(context.workspace, options);
			const validator = Compile(tool.parameters);
			return {
				...tool,
				description: `${tool.description} This grant permits host commands outside the workspace. Use only for the assigned goal; pause for credentials or interactive authorization.`,
				execute: async (...args: Parameters<typeof tool.execute>) => {
					const [id, input, signal, update, extension] = args;
					if (!validator.Check(input) || !input.command.trim() || input.command.length > 32768)
						throw new Error("Invalid host command");
					const result = await governed.execute({
						family: "process.execute",
						target: {
							shell: name,
							workspace: context.workspace,
							commandDigest: createHash("sha256").update(input.command).digest("hex"),
						},
						identities: { agentId: context.definition.id, attemptId: context.runId },
						canonicalize: (target) => target,
						authorize: () => ({
							decision: signal?.aborted ? "deny" : "allow",
							reason: "Explicit host command grant",
							grant: name,
						}),
						dispatch: () =>
							tool.execute(
								id,
								{ ...input, timeout: Math.min(input.timeout ?? 120, 1800) },
								signal,
								update,
								extension,
							),
					});
					if (result.status === "denied") throw new Error(result.reason);
					return result.value;
				},
			};
		});
}

import { createHash } from "node:crypto";
import { Compile } from "typebox/compile";
