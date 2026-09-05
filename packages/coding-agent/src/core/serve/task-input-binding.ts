import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { MAX_SCOPED_AGENT_FILE_BYTES, resolveCanonicalWorkspacePath } from "./scoped-agent-tools.ts";

export interface TaskInputBinding {
	workspace: string;
	files: Array<{ path: string; sha256: string }>;
}

export interface TaskInputEvidence {
	path: string;
	sha256: string;
}

/** Recognizes explicit text-file review requests only; never searches personas or conversation history. */
export async function bindTaskInputs(goal: string, workspace: string): Promise<TaskInputBinding | undefined> {
	if (!/\b(read|review|check|inspect|analy[sz]e|calculate|summari[sz]e)\b/i.test(goal)) return undefined;
	if (/\b(write|edit|create|delete|rename|move|save|update)\b/i.test(goal)) return undefined;
	const matches = [
		...goal.matchAll(
			/`([^`\n]+\.(?:csv|tsv|txt|json|md))`|"([^"\n]+\.(?:csv|tsv|txt|json|md))"|(?<![\w/:\\])([\w./-]+\.(?:csv|tsv|txt|json|md))\b/gi,
		),
	];
	const paths = [...new Set(matches.map((match) => match[1] ?? match[2] ?? match[3]!))];
	if (paths.length === 0) return undefined;
	if (paths.length > 8) throw new Error("A file review supports at most 8 explicit inputs");
	if (/\b(instead|except|rather|not|ignore)\b/i.test(goal) && paths.length > 1) {
		throw new Error("File selection is ambiguous. Name only the files to review in this request.");
	}
	const root = await realpath(workspace);
	const files: TaskInputBinding["files"] = [];
	for (const path of paths) {
		try {
			const canonical = await resolveCanonicalWorkspacePath(root, path, "existing");
			const bytes = await readFile(canonical);
			if (bytes.byteLength > MAX_SCOPED_AGENT_FILE_BYTES) throw new Error("Input exceeds the 1 MiB read limit");
			files.push({
				path: relative(root, canonical).replaceAll("\\", "/"),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			});
		} catch (error) {
			throw new Error(`Cannot bind input ${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { workspace: root, files };
}

export function parseTaskInputBinding(value: unknown): TaskInputBinding | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "object" ||
		value === null ||
		!("workspace" in value) ||
		typeof value.workspace !== "string" ||
		!("files" in value) ||
		!Array.isArray(value.files) ||
		value.files.length < 1 ||
		value.files.length > 8
	)
		throw new Error("Invalid task input binding");
	return { workspace: value.workspace, files: parseTaskInputEvidence(value.files)! };
}

export function parseTaskInputEvidence(value: unknown): TaskInputEvidence[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid task input evidence");
	return value.map((entry: unknown) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("path" in entry) ||
			typeof entry.path !== "string" ||
			!entry.path ||
			!("sha256" in entry) ||
			typeof entry.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(entry.sha256)
		)
			throw new Error("Invalid bound input");
		return { path: entry.path, sha256: entry.sha256 };
	});
}

export function inputEvidenceError(
	binding: TaskInputBinding | undefined,
	evidence: readonly TaskInputEvidence[] | undefined,
): string | undefined {
	if (!binding) return undefined;
	const missing = binding.files.filter(
		(file) => !evidence?.some((read) => read.path === file.path && read.sha256 === file.sha256),
	);
	return missing.length
		? `Input verification failed: no host read evidence for ${missing.map((file) => file.path).join(", ")}`
		: undefined;
}
