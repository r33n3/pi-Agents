import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import Type from "typebox";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { createEditToolDefinition } from "../tools/edit.ts";
import { createReadToolDefinition } from "../tools/read.ts";
import { createWriteToolDefinition } from "../tools/write.ts";
import type { AgentDefinition } from "./agent-registry.ts";

export const MAX_SCOPED_AGENT_FILE_BYTES = 1024 * 1024;
export const SUPPORTED_AGENT_TOOLS = ["read", "list", "write", "edit", "bash", "powershell"] as const;
const listParameters = Type.Object({ path: Type.Optional(Type.String()) });
export type ScopedAgentTool =
	| ReturnType<typeof createReadToolDefinition>
	| ReturnType<typeof createWriteToolDefinition>
	| ReturnType<typeof createEditToolDefinition>
	| ToolDefinition<typeof listParameters, undefined>;

export interface ScopedAgentFileOperations {
	readBytes?(path: string): Promise<Buffer>;
	read(path: string): Promise<string>;
	list(path: string): Promise<Array<{ kind: "directory" | "file"; name: string }>>;
	write(path: string, content: string): Promise<number>;
}

export function createScopedAgentTools(
	definition: AgentDefinition,
	workspace: string,
	operations: ScopedAgentFileOperations = createLocalScopedAgentFileOperations(workspace),
): ToolDefinition[] {
	const requested = new Set(definition.tools);
	const tools: ScopedAgentTool[] = [];
	const read = async (path: string) =>
		operations.readBytes ? operations.readBytes(path) : Buffer.from(await operations.read(path), "utf8");
	if (requested.has("read"))
		tools.push(
			createReadToolDefinition(workspace, {
				operations: {
					readFile: read,
					access: async () => {},
					detectImageMimeType: async (path) => detectSupportedImageMimeType(await read(path)),
				},
			}),
		);
	if (requested.has("list")) tools.push(createListTool(operations));
	if (requested.has("write") && definition.permissionPolicy === "workspace-write") {
		tools.push(
			createWriteToolDefinition(workspace, {
				operations: {
					mkdir: async () => {}, // The authorized write operation owns directory creation.
					writeFile: async (path, content) => {
						await operations.write(path, content);
					},
				},
			}),
		);
	}
	if (requested.has("edit") && definition.permissionPolicy === "workspace-write")
		tools.push(
			createEditToolDefinition(workspace, {
				operations: {
					readFile: read,
					access: async () => {},
					writeFile: async (path, content) => {
						await operations.write(path, content);
					},
				},
			}),
		);
	// Pi tools have heterogeneous parameter schemas; the runtime validates each tool's schema.
	return tools as ToolDefinition[];
}

export function createLocalScopedAgentFileOperations(workspace: string): ScopedAgentFileOperations {
	return {
		async readBytes(path) {
			const bytes = await readFile(await resolveCanonicalWorkspacePath(workspace, path, "existing"));
			if (bytes.byteLength > MAX_SCOPED_AGENT_FILE_BYTES)
				throw new Error("Workspace file exceeds the 1 MiB read limit");
			return bytes;
		},
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
			if (Buffer.byteLength(content, "utf8") > MAX_SCOPED_AGENT_FILE_BYTES)
				throw new Error("Workspace file exceeds the 1 MiB write limit");
			const target = await resolveCanonicalWorkspacePath(workspace, path, "write");
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, content, "utf8");
			return Buffer.byteLength(content, "utf8");
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
