import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { AgentDefinition } from "./agent-registry.ts";

export const MAX_SCOPED_AGENT_FILE_BYTES = 1024 * 1024;
export const SUPPORTED_AGENT_TOOLS = ["read", "list", "write"] as const;
const readParameters = Type.Object({ path: Type.String({ minLength: 1 }) });
const listParameters = Type.Object({ path: Type.Optional(Type.String()) });
const writeParameters = Type.Object({
	path: Type.String({ minLength: 1 }),
	content: Type.String({ maxLength: MAX_SCOPED_AGENT_FILE_BYTES }),
});
export type ScopedAgentTool =
	| ToolDefinition<typeof readParameters, undefined>
	| ToolDefinition<typeof listParameters, undefined>
	| ToolDefinition<typeof writeParameters, undefined>;

export interface ScopedAgentFileOperations {
	read(path: string): Promise<string>;
	list(path: string): Promise<Array<{ kind: "directory" | "file"; name: string }>>;
	write(path: string, content: string): Promise<number>;
}

export function createScopedAgentTools(
	definition: AgentDefinition,
	workspace: string,
	operations: ScopedAgentFileOperations = createLocalScopedAgentFileOperations(workspace),
): ScopedAgentTool[] {
	const requested = new Set(definition.tools);
	const tools: ScopedAgentTool[] = [];
	if (requested.has("read")) tools.push(createReadTool(operations));
	if (requested.has("list")) tools.push(createListTool(operations));
	if (requested.has("write") && definition.permissionPolicy === "workspace-write") {
		tools.push(createWriteTool(operations));
	}
	return tools;
}

export function createLocalScopedAgentFileOperations(workspace: string): ScopedAgentFileOperations {
	return {
		async read(path) {
			const content = await readFile(await resolveCanonicalWorkspacePath(workspace, path, "existing"));
			if (content.byteLength > MAX_SCOPED_AGENT_FILE_BYTES) {
				throw new Error("Workspace file exceeds the 1 MiB read limit");
			}
			return content.toString("utf8");
		},
		async list(path) {
			const entries = await readdir(await resolveCanonicalWorkspacePath(workspace, path, "existing"), {
				withFileTypes: true,
			});
			return entries
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((entry) => ({ kind: entry.isDirectory() ? "directory" : "file", name: entry.name }));
		},
		async write(path, content) {
			const target = await resolveCanonicalWorkspacePath(workspace, path, "write");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
			return Buffer.byteLength(content, "utf8");
		},
	};
}

function createReadTool(operations: ScopedAgentFileOperations): ToolDefinition<typeof readParameters, undefined> {
	return {
		name: "read",
		label: "read",
		description: "Read a UTF-8 text file inside this agent's isolated workspace.",
		promptSnippet: "Read a workspace file",
		parameters: readParameters,
		async execute(_toolCallId, { path }) {
			return { content: [{ type: "text", text: await operations.read(path) }], details: undefined };
		},
	};
}

function createListTool(operations: ScopedAgentFileOperations): ToolDefinition<typeof listParameters, undefined> {
	return {
		name: "list",
		label: "list",
		description: "List files and directories at one path inside this agent's isolated workspace.",
		promptSnippet: "List a workspace directory",
		parameters: listParameters,
		async execute(_toolCallId, { path }) {
			const entries = await operations.list(path ?? ".");
			return {
				content: [
					{
						type: "text",
						text: entries
							.sort((left, right) => left.name.localeCompare(right.name))
							.map((entry) => `${entry.kind}\t${entry.name}`)
							.join("\n"),
					},
				],
				details: undefined,
			};
		},
	};
}

function createWriteTool(operations: ScopedAgentFileOperations): ToolDefinition<typeof writeParameters, undefined> {
	return {
		name: "write",
		label: "write",
		description: "Create or replace a UTF-8 text file inside this agent's isolated workspace.",
		promptSnippet: "Write a workspace file",
		parameters: writeParameters,
		async execute(_toolCallId, { path, content }) {
			const bytesWritten = await operations.write(path, content);
			return {
				content: [{ type: "text", text: `Wrote ${bytesWritten} bytes to ${path}` }],
				details: undefined,
			};
		},
	};
}

export async function resolveCanonicalWorkspacePath(
	workspace: string,
	requestedPath: string,
	mode: "existing" | "write",
): Promise<string> {
	const lexicalRoot = resolve(workspace);
	const lexicalTarget = resolveWorkspacePath(lexicalRoot, requestedPath);
	const canonicalRoot = await realpath(lexicalRoot);
	let canonicalTarget: string;
	try {
		canonicalTarget = await realpath(lexicalTarget);
	} catch (error) {
		if (mode !== "write" || !isNodeError(error) || error.code !== "ENOENT") throw error;
		let ancestor = dirname(lexicalTarget);
		while (true) {
			try {
				const canonicalAncestor = await realpath(ancestor);
				canonicalTarget = resolve(canonicalAncestor, relative(ancestor, lexicalTarget));
				break;
			} catch (ancestorError) {
				if (!isNodeError(ancestorError) || ancestorError.code !== "ENOENT") throw ancestorError;
				const parent = dirname(ancestor);
				if (parent === ancestor) throw ancestorError;
				ancestor = parent;
			}
		}
	}
	assertWithinWorkspace(canonicalRoot, canonicalTarget);
	return canonicalTarget;
}

export function resolveWorkspacePath(workspace: string, requestedPath: string): string {
	const root = resolve(workspace);
	const target = resolve(root, requestedPath);
	const fromRoot = relative(root, target);
	if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return target;
	throw new Error("Tool path escapes the agent workspace");
}

function assertWithinWorkspace(root: string, target: string): void {
	const fromRoot = relative(root, target);
	if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) return;
	throw new Error("Tool path escapes the agent workspace");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
