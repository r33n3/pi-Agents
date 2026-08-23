import type { BrowserPageElement } from "./browser-session-manager.ts";
import type { BrowserCapturedAction, BrowserWorkflowCapture } from "./browser-workflow-capture.ts";
import type {
	BrowserAssertion,
	BrowserLocatorCandidate,
	BrowserTarget,
	BrowserWorkflowCompileIssue,
	BrowserWorkflowDefinition,
	BrowserWorkflowDefinitionInput,
	BrowserWorkflowRegistry,
	BrowserWorkflowStep,
} from "./browser-workflow-registry.ts";

export interface BrowserWorkflowCompileOptions {
	id?: string;
	name?: string;
	description?: string;
	targetOverrides?: Record<string, BrowserPageElement>;
}

/** Converts redacted capture evidence into a versioned, declarative browser workflow. */
export class BrowserWorkflowCompiler {
	readonly #registry: BrowserWorkflowRegistry;

	constructor(registry: BrowserWorkflowRegistry) {
		this.#registry = registry;
	}

	async compile(
		capture: BrowserWorkflowCapture,
		options: BrowserWorkflowCompileOptions = {},
	): Promise<BrowserWorkflowDefinition> {
		if (capture.status === "recording") throw new Error("Stop the browser recording before compiling it");
		const input = compileDefinition(capture, options);
		const draft = await this.#registry.saveDraft(input);
		return this.#registry.setStatus(
			draft.id,
			draft.version,
			draft.compileIssues.length === 0 ? "compiled" : "needs-input",
		);
	}
}

export function compileDefinition(
	capture: BrowserWorkflowCapture,
	options: BrowserWorkflowCompileOptions = {},
): BrowserWorkflowDefinitionInput {
	const issues: BrowserWorkflowCompileIssue[] = [];
	const entryUrl = validHttpUrl(capture.initial.url);
	if (!entryUrl) {
		issues.push({
			stepId: "entry",
			code: "missing-entry",
			message: "The recording did not begin on a valid HTTP(S) page.",
		});
	}
	const parameters: BrowserWorkflowDefinitionInput["parameters"] = [];
	const steps: BrowserWorkflowStep[] = [];
	const parameterNames = new Set<string>();
	for (const captured of capture.steps) {
		const id = workflowStepId(captured.id);
		const base = {
			id,
			preconditions: [] as BrowserAssertion[],
			postconditions: pagePostconditions(captured.before.url, captured.after.url),
			timeoutMs: 30_000,
			evidence: "failure" as const,
		};
		switch (captured.action.kind) {
			case "navigate":
				steps.push({ ...base, action: "navigate", urlTemplate: captured.action.url });
				break;
			case "back":
			case "forward":
			case "reload": {
				const url = validHttpUrl(captured.after.url);
				if (url) steps.push({ ...base, action: "navigate", urlTemplate: url.href });
				else unsupported(issues, id, captured.action);
				break;
			}
			case "click": {
				const target = compileTarget(options.targetOverrides?.[captured.id] ?? captured.action.target);
				if (target) steps.push({ ...base, action: "click", target });
				else missingTarget(issues, id, "click");
				break;
			}
			case "type": {
				const resolvedElement = options.targetOverrides?.[captured.id] ?? captured.action.target;
				const target = compileTarget(resolvedElement);
				if (!target) {
					missingTarget(issues, id, "type");
					break;
				}
				const name = uniqueParameterName(
					resolvedElement?.label || resolvedElement?.name || "value",
					parameterNames,
				);
				parameters.push({
					name,
					description: `Value entered into ${resolvedElement?.label || resolvedElement?.name || "the recorded field"}`,
					type: captured.action.sensitive ? "secret-ref" : "string",
					required: true,
					sensitive: captured.action.sensitive,
				});
				steps.push({ ...base, action: "fill", target, value: { kind: "parameter", name } });
				break;
			}
			case "scroll":
				// Semantic actions auto-scroll their targets into view, so raw wheel deltas are intentionally omitted.
				break;
		}
	}
	const finalState = capture.steps.at(-1)?.after ?? capture.initial;
	const completion = pagePostconditions("", finalState.url);
	if (completion.length === 0 && finalState.title)
		completion.push({ kind: "title", pattern: exactPattern(finalState.title) });
	if (completion.length === 0) completion.push({ kind: "page-ready" });
	const effectiveEntry = entryUrl ?? new URL("http://127.0.0.1/");
	return {
		id: options.id,
		name: options.name?.trim() || capture.initial.title.trim() || `Browser workflow ${capture.id.slice(0, 8)}`,
		description: options.description?.trim() || "Recorded managed-browser workflow",
		entry: {
			urlTemplate: effectiveEntry.href,
			allowedOrigins: allowedOrigins(capture, effectiveEntry.origin),
			ready: [{ kind: "page-ready" }],
		},
		parameters,
		steps,
		completion,
		requirements: {
			profile: capture.profile.kind === "named" ? "authenticated" : "none",
			viewport: capture.viewport,
			access: accessForOrigins(allowedOrigins(capture, effectiveEntry.origin)),
		},
		policy: { deadlineMs: 300_000, approval: "inherit" },
		source: { kind: "recording", captureId: capture.id },
		compileIssues: issues,
	};
}

function compileTarget(element: BrowserPageElement | undefined): BrowserTarget | undefined {
	if (!element) return undefined;
	const candidates: BrowserLocatorCandidate[] = [];
	if (element.testId) candidates.push({ kind: "test-id", value: element.testId });
	if (element.label) candidates.push({ kind: "label", text: element.label, exact: true });
	if (element.role && element.name)
		candidates.push({ kind: "role", role: element.role, name: element.name, exact: true });
	if (element.id) candidates.push({ kind: "id", value: element.id });
	if (element.name) candidates.push({ kind: "text", text: element.name, exact: true });
	if (candidates.length === 0) return undefined;
	return {
		frame: (element.frame ?? []).map((frame) => ({
			name: frame.name || undefined,
			urlPattern: frame.url ? exactPattern(frame.url) : undefined,
		})),
		candidates,
		expected: { tag: element.tag, role: element.role, inputType: element.inputType },
	};
}

function pagePostconditions(before: string, after: string): BrowserAssertion[] {
	if (!after || after === before) return [];
	return [{ kind: "url", pattern: exactPattern(after) }];
}

function exactPattern(value: string): string {
	return `^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

function workflowStepId(value: string): string {
	const id = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return id || "recorded-step";
}

function uniqueParameterName(value: string, used: Set<string>): string {
	const base =
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+(.)/g, (_match, character: string) => character.toUpperCase())
			.replace(/^[^a-z]+/, "")
			.slice(0, 64) || "value";
	let candidate = base;
	let suffix = 2;
	while (used.has(candidate)) {
		candidate = `${base.slice(0, 72)}${suffix}`;
		suffix++;
	}
	used.add(candidate);
	return candidate;
}

function allowedOrigins(capture: BrowserWorkflowCapture, fallback: string): string[] {
	const origins = new Set<string>([fallback]);
	for (const state of [capture.initial, ...capture.steps.flatMap((step) => [step.before, step.after])]) {
		const url = validHttpUrl(state.url);
		if (url) origins.add(url.origin);
	}
	return [...origins];
}

function accessForOrigins(origins: string[]): "loopback" | "private-network" | "public-web" {
	if (origins.every((origin) => /^(https?:\/\/)(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|$)/i.test(origin))) {
		return "loopback";
	}
	if (
		origins.every((origin) => {
			const hostname = new URL(origin).hostname;
			return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname);
		})
	) {
		return "private-network";
	}
	return "public-web";
}

function validHttpUrl(value: string): URL | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}

function missingTarget(issues: BrowserWorkflowCompileIssue[], stepId: string, action: string): void {
	issues.push({
		stepId,
		code: "missing-target",
		message: `The recorded ${action} could not be mapped to a stable page element. Select a semantic target before validation.`,
	});
}

function unsupported(issues: BrowserWorkflowCompileIssue[], stepId: string, action: BrowserCapturedAction): void {
	issues.push({
		stepId,
		code: "unsupported-action",
		message: `The recorded ${action.kind} action did not produce a valid HTTP(S) destination.`,
	});
}
