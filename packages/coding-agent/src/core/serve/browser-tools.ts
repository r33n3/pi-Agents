import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { BrowserAccess } from "./browser-policy.ts";
import type { BrowserProfile } from "./browser-profile-store.ts";
import type {
	BrowserOwner,
	BrowserSessionManager,
	BrowserSessionSnapshot,
	BrowserWorkspace,
} from "./browser-session-manager.ts";
import type { WorkspacePreviewServer } from "./workspace-preview-server.ts";

const openParameters = Type.Object({ url: Type.String({ minLength: 1, maxLength: 4096 }) });
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
	access: Exclude<BrowserAccess, "disabled">;
	profile?: BrowserProfile;
	workspacePreview?: WorkspacePreviewServer;
}

/** Creates browser tools whose access is fixed to one session or agent workspace. */
export function createBrowserTools(manager: BrowserSessionManager, scope: BrowserToolScope): ToolDefinition[] {
	return [
		{
			name: "browser_open",
			label: "browser_open",
			description:
				"Open an HTTP(S) URL or an HTML file inside this session's workspace in the managed browser Preview.",
			promptSnippet:
				"Use browser_open to render and review webpages. Pass a workspace HTML file path directly; it is served safely over loopback.",
			parameters: openParameters,
			executionMode: "sequential",
			async execute(_toolCallId, { url }) {
				const session = await getOrCreateSession(manager, scope);
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
): Promise<BrowserSessionSnapshot> {
	const existing = manager
		.list(scope.owner)
		.filter((session) => session.status === "ready" || session.status === "navigating")
		.sort((left, right) => right.updatedAt - left.updatedAt)[0];
	return existing ?? manager.create({ ...scope });
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
