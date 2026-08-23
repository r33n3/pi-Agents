import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type BrowserAccess, browserAccessForUrl } from "./browser-policy.ts";
import type { BrowserProfile } from "./browser-profile-store.ts";
import type {
	BrowserOwner,
	BrowserRuntimeKind,
	BrowserSessionManager,
	BrowserSessionSnapshot,
	BrowserWorkspace,
} from "./browser-session-manager.ts";
import type { BrowserWorkflowCompiler } from "./browser-workflow-compiler.ts";
import type { WorkspacePreviewServer } from "./workspace-preview-server.ts";

const openParameters = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 4096 }),
	access: Type.Optional(
		Type.Union([Type.Literal("loopback"), Type.Literal("public-web"), Type.Literal("private-network")]),
	),
});
const snapshotParameters = Type.Object({ sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) });
const elementParameters = Type.Object({
	sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	revision: Type.Integer({ minimum: 1 }),
	ref: Type.String({ pattern: "^e[1-9][0-9]*$" }),
});
const fillParameters = Type.Object({ ...elementParameters.properties, text: Type.String({ maxLength: 100_000 }) });
const pressParameters = Type.Object({
	sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	key: Type.String({ minLength: 1, maxLength: 64 }),
});

export interface BrowserToolScope {
	owner: BrowserOwner;
	workspace: BrowserWorkspace;
	access: Exclude<BrowserAccess, "disabled"> | readonly Exclude<BrowserAccess, "disabled">[];
	profile?: BrowserProfile;
	runtime?: BrowserRuntimeKind;
	workspacePreview?: WorkspacePreviewServer;
	workflowCompiler?: BrowserWorkflowCompiler;
}

/** Creates owner-bound browser tools whose immutable session policies are limited to explicit access grants. */
export function createBrowserTools(manager: BrowserSessionManager, scope: BrowserToolScope): ToolDefinition[] {
	return [
		{
			name: "browser_open",
			label: "browser_open",
			description:
				"Open an HTTP(S) URL or a workspace HTML file for direct review. This does not record or replay a saved workflow.",
			promptSnippet:
				"Use browser_open for immediate page review. Public sites use an isolated public-web session; workspace files use loopback. Use browser_record_start only when the user asks to record new actions.",
			parameters: openParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { url, access }) {
				const selectedAccess = selectAccess(scope, url, access);
				const session = await getOrCreateSession(manager, scope, selectedAccess);
				const target = /^https?:\/\//i.test(url)
					? url
					: await scope.workspacePreview?.urlFor(scope.workspace.root, url);
				if (!target) throw new Error("Local file preview is unavailable in this browser session");
				const updated = await manager.navigate(session.id, target);
				return textResult(
					`Opened ${url} in browser session ${updated.id}. Use browser_snapshot and browser_screenshot to review it.`,
				);
			},
		},
		...(scope.workflowCompiler
			? [
					{
						name: "browser_record_start",
						label: "browser_record_start",
						description:
							"Start a new recording on the active managed browser session. Use only when the user asks to record or capture new browser actions; never replay an existing workflow first.",
						promptSnippet:
							"For a new recording: open the requested page, call browser_record_start, let the user take control and act, then call browser_record_stop. Do not list or run saved workflows.",
						parameters: snapshotParameters,
						executionMode: "sequential" as const,
						async execute(_toolCallId: string, { sessionId }: { sessionId?: string }) {
							const session = await getOwnedSession(manager, scope.owner, sessionId);
							const capture = await manager.startCapture(session.id);
							return textResult(
								`Recording ${capture.id} started in browser session ${session.id}. The user may take control and perform the browser actions.`,
							);
						},
					},
					{
						name: "browser_record_stop",
						label: "browser_record_stop",
						description:
							"Stop the active browser recording and compile those newly captured actions into a new workflow draft. This does not validate, activate, or replay it.",
						promptSnippet:
							"Call browser_record_stop only after the user finishes a new recording. Report the new workflow ID, version, status, access, and compile issues.",
						parameters: snapshotParameters,
						executionMode: "sequential" as const,
						async execute(_toolCallId: string, { sessionId }: { sessionId?: string }) {
							const session = await getOwnedSession(manager, scope.owner, sessionId);
							const capture = await manager.stopCapture(session.id);
							const workflow = await scope.workflowCompiler!.compile(capture);
							return textResult(
								JSON.stringify(
									{
										captureId: capture.id,
										workflowId: workflow.id,
										version: workflow.version,
										status: workflow.status,
										access: workflow.requirements.access,
										steps: workflow.steps.map((step) => ({ id: step.id, action: step.action })),
										issues: workflow.compileIssues,
									},
									null,
									2,
								),
							);
						},
					},
				]
			: []),
		{
			name: "browser_snapshot",
			label: "browser_snapshot",
			description: "Read the current page and return stable element references for one browser snapshot.",
			promptSnippet: "Inspect the current browser page before clicking or filling",
			parameters: snapshotParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { sessionId }) {
				const session = await getOwnedSession(manager, scope.owner, sessionId);
				const snapshot = await manager.snapshot(session.id);
				const elements = snapshot.elements
					.map((element) => `${element.ref}\t${element.role}\t${element.name}`)
					.join("\n");
				return textResult(`Snapshot ${snapshot.revision}: ${snapshot.title}\nURL: ${snapshot.url}\n${elements}`);
			},
		},
		{
			name: "browser_click",
			label: "browser_click",
			description: "Click one element reference from the latest browser snapshot.",
			parameters: elementParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { sessionId, revision, ref }) {
				const session = await getOwnedSession(manager, scope.owner, sessionId);
				await manager.click(session.id, revision, ref);
				return textResult(`Clicked ${ref}. Request a fresh browser_snapshot before another element action.`);
			},
		},
		{
			name: "browser_fill",
			label: "browser_fill",
			description: "Replace the value of an input or textarea reference from the latest browser snapshot.",
			parameters: fillParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { sessionId, revision, ref, text }) {
				const session = await getOwnedSession(manager, scope.owner, sessionId);
				await manager.fill(session.id, revision, ref, text);
				return textResult(`Filled ${ref}. Request a fresh browser_snapshot before another element action.`);
			},
		},
		{
			name: "browser_press",
			label: "browser_press",
			description: "Send a named key, such as Enter or Control+L, to the managed browser page.",
			parameters: pressParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { sessionId, key }) {
				const session = await getOwnedSession(manager, scope.owner, sessionId);
				await manager.press(session.id, key);
				return textResult(`Pressed ${key}. Request a fresh browser_snapshot before another element action.`);
			},
		},
		{
			name: "browser_screenshot",
			label: "browser_screenshot",
			description: "Capture the current managed browser viewport as a PNG image.",
			parameters: snapshotParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { sessionId }) {
				const session = await getOwnedSession(manager, scope.owner, sessionId);
				const screenshot = await manager.captureScreenshotArtifact(session.id);
				return {
					content: [
						{ type: "image", data: Buffer.from(screenshot.png).toString("base64"), mimeType: "image/png" },
					],
					details: screenshot.artifact,
				};
			},
		},
	];
}

async function getOrCreateSession(
	manager: BrowserSessionManager,
	scope: BrowserToolScope,
	access: Exclude<BrowserAccess, "disabled">,
): Promise<BrowserSessionSnapshot> {
	const runtime = scope.runtime ?? "managed-chromium";
	const profile = scope.profile ?? { kind: "ephemeral" as const };
	const existing = manager
		.list(scope.owner)
		.filter(
			(session) =>
				(session.status === "ready" || session.status === "navigating") &&
				session.access === access &&
				session.runtime === runtime &&
				sameProfile(session.profile, profile),
		)
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	return (
		existing ??
		manager.create({
			owner: scope.owner,
			workspace: scope.workspace,
			access,
			profile: scope.profile,
			runtime: scope.runtime,
		})
	);
}

function sameProfile(left: BrowserProfile, right: BrowserProfile): boolean {
	return left.kind === right.kind && (left.kind === "ephemeral" || (right.kind === "named" && left.id === right.id));
}

function selectAccess(
	scope: BrowserToolScope,
	url: string,
	requested: Exclude<BrowserAccess, "disabled"> | undefined,
): Exclude<BrowserAccess, "disabled"> {
	const grants = Array.isArray(scope.access) ? [...scope.access] : [scope.access];
	if (requested) {
		if (!grants.includes(requested)) throw new Error(`Browser access ${requested} is not granted to this owner`);
		return requested;
	}
	const required = /^https?:\/\//i.test(url) ? browserAccessForUrl(url) : "loopback";
	if (grants.includes(required)) return required;
	if (required === "loopback" && grants.includes("private-network")) return "private-network";
	throw new Error(`Browser target requires ${required} access, which is not granted to this owner`);
}

function getOwnedSession(
	manager: BrowserSessionManager,
	owner: BrowserOwner,
	sessionId: string | undefined,
): BrowserSessionSnapshot {
	const session = sessionId
		? manager.get(sessionId)
		: manager
				.list(owner)
				.filter((entry) => entry.status === "ready" || entry.status === "navigating")
				.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	if (!session || session.owner.kind !== owner.kind || session.owner.id !== owner.id) {
		throw new Error("No browser session is available for this owner");
	}
	return session;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}
