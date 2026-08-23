import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BrowserOwner, BrowserRuntimeKind, BrowserWorkspace } from "./browser-session-manager.ts";
import type { BrowserWorkflowRegistry } from "./browser-workflow-registry.ts";
import type { BrowserWorkflowRunner } from "./browser-workflow-runner.ts";

const parameters = Type.Record(
	Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]{0,79}$" }),
	Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
);
const workflowParameters = Type.Object({
	id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
	version: Type.Integer({ minimum: 1 }),
	parameters: Type.Optional(parameters),
	approved: Type.Optional(Type.Boolean()),
});
const versionParameters = workflowParameters;

export interface BrowserWorkflowGrant {
	id: string;
	version: number;
}

export interface BrowserWorkflowToolScope {
	owner: BrowserOwner;
	workspace: BrowserWorkspace;
	profile?: { kind: "ephemeral" } | { kind: "named"; id: string };
	runtime?: BrowserRuntimeKind;
	allowedWorkflows?: BrowserWorkflowGrant[];
	frontendTests?: () => BrowserWorkflowGrant[];
}

/** Gives Pi and agents the same canonical validated workflow runtime used by the Browser UI. */
export function createBrowserWorkflowTools(
	registry: BrowserWorkflowRegistry,
	runner: BrowserWorkflowRunner,
	scope: BrowserWorkflowToolScope,
): ToolDefinition[] {
	return [
		{
			name: "browser_workflow_list",
			label: "browser_workflow_list",
			description: "List recorded browser workflows and their validation and activation state.",
			parameters: Type.Object({}),
			executionMode: "parallel",
			execute() {
				const workflows = registry
					.list()
					.filter((workflow) => workflowAllowed(scope, workflow.id, workflow.version))
					.map((workflow) => ({
						id: workflow.id,
						version: workflow.version,
						name: workflow.name,
						status: workflow.status,
						parameters: workflow.parameters.map((parameter) => ({
							name: parameter.name,
							type: parameter.type,
							required: parameter.required,
						})),
						issues: workflow.compileIssues,
						frontendTest: scope
							.frontendTests?.()
							.some((reference) => reference.id === workflow.id && reference.version === workflow.version),
					}))
					.sort((left, right) => left.name.localeCompare(right.name));
				return Promise.resolve(textResult(JSON.stringify(workflows, null, 2)));
			},
		},
		{
			name: "browser_workflow_get",
			label: "browser_workflow_get",
			description: "Read one exact canonical browser workflow definition without executing it.",
			parameters: Type.Object({
				id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
				version: Type.Integer({ minimum: 1 }),
			}),
			executionMode: "parallel",
			execute(_toolCallId, input) {
				const request = workflowToolInput(input);
				assertWorkflowAllowed(scope, request.id, request.version);
				const workflow = registry.get(request.id, request.version);
				if (!workflow) throw new Error(`Browser workflow ${request.id} version ${request.version} was not found`);
				return Promise.resolve(textResult(JSON.stringify(workflow, null, 2)));
			},
		},
		{
			name: "browser_workflow_validate",
			label: "browser_workflow_validate",
			description:
				"Validate one explicitly identified compiled browser workflow in a fresh context. This replays saved actions; never use it to start a new recording.",
			parameters: versionParameters,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const request = workflowToolInput(input);
				assertWorkflowAllowed(scope, request.id, request.version);
				const run = await runner.validate(request.id, request.version, {
					...scope,
					parameters: request.parameters,
					profile: scope.profile,
				});
				return textResult(JSON.stringify(run, null, 2));
			},
		},
		{
			name: "browser_workflow_activate",
			label: "browser_workflow_activate",
			description: "Activate an exactly validated browser workflow version for agent and routine execution.",
			parameters: Type.Object({
				id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
				version: Type.Integer({ minimum: 1 }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const request = workflowToolInput(input);
				assertWorkflowAllowed(scope, request.id, request.version);
				return textResult(JSON.stringify(await registry.activate(request.id, request.version), null, 2));
			},
		},
		{
			name: "browser_workflow_run",
			label: "browser_workflow_run",
			description:
				"Replay an explicitly identified active browser workflow with named parameters. Use only when the user asks to run or replay that saved workflow; never use it for page review or recording.",
			parameters: workflowParameters,
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const request = workflowToolInput(input);
				assertWorkflowAllowed(scope, request.id, request.version);
				const run = await runner.executeVersion(request.id, request.version, {
					...scope,
					parameters: request.parameters,
					profile: scope.profile,
					approved: request.approved,
				});
				return textResult(JSON.stringify(run, null, 2));
			},
		},
		{
			name: "browser_workflow_cancel",
			label: "browser_workflow_cancel",
			description: "Cancel a running browser workflow by its run ID.",
			parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }) }),
			executionMode: "parallel",
			async execute(_toolCallId, input) {
				if (typeof input !== "object" || input === null || Array.isArray(input) || !("runId" in input)) {
					throw new Error("Browser workflow run id is invalid");
				}
				const runId = input.runId;
				if (typeof runId !== "string" || !runId.trim() || runId.length > 128) {
					throw new Error("Browser workflow run id is invalid");
				}
				await runner.cancel(runId);
				return textResult(`Cancelled browser workflow run ${runId}`);
			},
		},
	];
}

function workflowAllowed(scope: BrowserWorkflowToolScope, id: string, version: number): boolean {
	return (
		scope.allowedWorkflows === undefined ||
		scope.allowedWorkflows.some((workflow) => workflow.id === id && workflow.version === version)
	);
}

function assertWorkflowAllowed(scope: BrowserWorkflowToolScope, id: string, version: number): void {
	if (!workflowAllowed(scope, id, version)) {
		throw new Error(`Browser workflow ${id} version ${version} is not assigned to this agent`);
	}
}

function workflowToolInput(value: unknown): {
	id: string;
	version: number;
	parameters: Record<string, string | number | boolean>;
	approved: boolean | undefined;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Workflow input is invalid");
	const input = value as Record<string, unknown>;
	if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id)) {
		throw new Error("Workflow id is invalid");
	}
	const version = input.version;
	if (!Number.isSafeInteger(version) || Number(version) < 1) {
		throw new Error("Workflow version must be a positive integer");
	}
	const values = input.parameters;
	if (values !== undefined && (typeof values !== "object" || values === null || Array.isArray(values))) {
		throw new Error("Workflow parameters must be an object");
	}
	const normalized: Record<string, string | number | boolean> = {};
	for (const [name, entry] of Object.entries((values ?? {}) as Record<string, unknown>)) {
		if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name)) throw new Error("Workflow parameter name is invalid");
		if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
			throw new Error(`Workflow parameter ${name} is invalid`);
		}
		normalized[name] = entry;
	}
	if (input.approved !== undefined && typeof input.approved !== "boolean") {
		throw new Error("Workflow approval must be a boolean");
	}
	return { id: input.id, version: Number(version), parameters: normalized, approved: input.approved };
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}
