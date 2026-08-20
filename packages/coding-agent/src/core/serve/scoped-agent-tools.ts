import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentDefinition } from "./agent-registry.ts";

const MAX_FILE_BYTES = 1024 * 1024;
export const SUPPORTED_AGENT_TOOLS = ["read", "list", "write"] as const;
const readParameters = Type.Object({ path: Type.String({ minLength: 1 }) });
const listParameters = Type.Object({ path: Type.Optional(Type.String()) });
const writeParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	content: Type.String({ maxLength: MAX_FILE_BYTES }),
});
export type ScopedAgentTool =
	| ToolDefinition<typeof readParameters, undefined>
	| ToolDefinition<typeof listParameters, undefined>
	| ToolDefinition<typeof writeParameters, undefined>;

export function createScopedAgentTools(definition: AgentDefinition, workspace: string): ScopedAgentTool[] {
	const requested = new Set(definition.tools);
	const tools: ScopedAgentTool[] = [];
	if (requested.has("read")) tools.push(createReadTool(workspace));
	if (requested.has("list")) tools.push(createListTool(workspace));
	if (requested.has("write") && definition.permissionPolicy === "workspace-write") {
		tools.push(createWriteTool(workspace));
	}
	return tools;
}

function createReadTool(workspace: string): ToolDefinition<typeof readParameters, undefined> {
	return {
		name: "read",
		label: "read",
		description: "Read a UTF-8 text file inside this agent's isolated workspace.",
		promptSnippet: "Read a workspace file",
		parameters: readParameters,
		async execute(_toolCallId, { path }) {
			const content = await readFile(resolveWorkspacePath(workspace, path));
			if (content.byteLength > MAX_FILE_BYTES) throw new Error("Workspace file exceeds the 1 MiB read limit");
			return { content: [{ type: "text", text: content.toString("utf8") }], details: undefined };
		},
	};
}

function createListTool(workspace: string): ToolDefinition<typeof listParameters, undefined> {
	return {
		name: "list",
		label: "list",
		description: "List files and directories at one path inside this agent's isolated workspace.",
		promptSnippet: "List a workspace directory",
		parameters: listParameters,
		async execute(_toolCallId, { path }) {
			const entries = await readdir(resolveWorkspacePath(workspace, path ?? "."), { withFileTypes: true });
			return {
				content: [
					{
						type: "text",
						text: entries
							.sort((left, right) => left.name.localeCompare(right.name))
							.map((entry) => `${entry.isDirectory() ? "directory" : "file"}\t${entry.name}`)
							.join("\n"),
					},
				],
				details: undefined,
			};
		},
	};
}

function createWriteTool(workspace: string): ToolDefinition<typeof writeParameters, undefined> {
	return {
		name: "write",
		label: "write",
		description: "Create or replace a UTF-8 text file inside this agent's isolated workspace.",
		promptSnippet: "Write a workspace file",
		parameters: writeParameters,
		async execute(_toolCallId, { path, content }) {
			const target = resolveWorkspacePath(workspace, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
			return {
				content: [{ type: "text", text: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

export function resolveWorkspacePath(workspace: string, requestedPath: string): string {
	const root = resolve(workspace);
	const target = resolve(root, requestedPath);
	const fromRoot = relative(root, target);
	if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return target;
	throw new Error("Tool path escapes the agent workspace");
}
