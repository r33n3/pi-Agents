import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

export type ArtifactKind =
	| "text"
	| "markdown"
	| "html"
	| "image"
	| "pdf"
	| "document"
	| "spreadsheet"
	| "presentation"
	| "dataset"
	| "browser_workflow"
	| "directory"
	| "other";

export interface ArtifactSourceRef {
	kind: "url" | "provider" | "workspace" | "artifact";
	label: string;
	reference: string;
}

export interface ArtifactVersion {
	id: string;
	artifactId: string;
	ordinal: number;
	createdByTaskId: string;
	createdByAttemptId: string;
	mediaType: string;
	byteLength: number;
	sha256: string;
	fileName: string;
	sourceRefs: ArtifactSourceRef[];
	safeSummary?: string;
	createdAt: number;
}

export interface ArtifactRecord {
	id: string;
	title: string;
	kind: ArtifactKind;
	ownership: "managed";
	taskId: string;
	attemptId: string;
	conversationId: string;
	agentId?: string;
	workspaceRoot: string;
	currentVersionId: string;
	versionIds: string[];
	tags: string[];
	createdAt: number;
	updatedAt: number;
	archivedAt?: number;
}

export interface RegisterArtifactInput {
	title: string;
	taskId: string;
	attemptId: string;
	conversationId: string;
	agentId?: string;
	workspaceRoot: string;
	sourcePath: string;
	allowedRoot: string;
	kind?: ArtifactKind;
	sourceRefs?: ArtifactSourceRef[];
	safeSummary?: string;
}

export interface ArtifactContent {
	data: Uint8Array;
	mediaType: string;
	fileName: string;
	sha256: string;
}

/** Owns immutable, versioned task deliverables and their safe metadata. */
export class ArtifactStore {
	readonly #root: string;
	readonly #records = new Map<string, ArtifactRecord>();

	constructor(root: string) {
		this.#root = resolve(root, "artifacts");
	}

	async initialize(): Promise<void> {
		await mkdir(this.#root, { recursive: true });
		for (const entry of await readdir(this.#root, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isIdentifier(entry.name)) continue;
			try {
				const record = parseArtifact(
					JSON.parse(await readFile(resolve(this.#root, entry.name, "artifact.json"), "utf8")),
				);
				this.#records.set(record.id, record);
			} catch {
				// Malformed artifact directories remain quarantined and are not exposed.
			}
		}
	}

	list(options: { taskId?: string; agentId?: string; includeArchived?: boolean } = {}): ArtifactRecord[] {
		return [...this.#records.values()]
			.filter(
				(record) =>
					(options.taskId === undefined || record.taskId === options.taskId) &&
					(options.agentId === undefined || record.agentId === options.agentId) &&
					(options.includeArchived === true || record.archivedAt === undefined),
			)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.map(cloneArtifact);
	}

	get(id: string): ArtifactRecord | undefined {
		assertIdentifier(id, "artifact id");
		const record = this.#records.get(id);
		return record ? cloneArtifact(record) : undefined;
	}

	async getVersion(artifactId: string, versionId?: string): Promise<ArtifactVersion | undefined> {
		const record = this.#records.get(artifactId);
		if (!record) return undefined;
		const selected = versionId ?? record.currentVersionId;
		if (!record.versionIds.includes(selected)) return undefined;
		return this.#readVersion(artifactId, selected);
	}

	async readContent(artifactId: string, versionId?: string): Promise<ArtifactContent | undefined> {
		const version = await this.getVersion(artifactId, versionId);
		if (!version) return undefined;
		const path = this.#contentPath(artifactId, version.id);
		const data = await readFile(path);
		if (data.byteLength !== version.byteLength || sha256(data) !== version.sha256) {
			throw new Error("Artifact content failed integrity validation");
		}
		return { data, mediaType: version.mediaType, fileName: version.fileName, sha256: version.sha256 };
	}

	async register(input: RegisterArtifactInput): Promise<ArtifactRecord> {
		const artifactId = randomUUID();
		const versionId = randomUUID();
		const now = Date.now();
		const source = await validateOwnedFile(input.sourcePath, input.allowedRoot);
		const sourceStat = await stat(source);
		if (!sourceStat.isFile()) throw new Error("Artifact source must be a file");
		if (sourceStat.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 50 MB managed limit");
		const data = await readFile(source);
		const detected = detectArtifact(source);
		const version: ArtifactVersion = {
			id: versionId,
			artifactId,
			ordinal: 1,
			createdByTaskId: input.taskId,
			createdByAttemptId: input.attemptId,
			mediaType: detected.mediaType,
			byteLength: data.byteLength,
			sha256: sha256(data),
			fileName: sanitizeFileName(basename(source)),
			sourceRefs: (input.sourceRefs ?? []).map(cloneSourceRef),
			safeSummary: input.safeSummary,
			createdAt: now,
		};
		const record: ArtifactRecord = {
			id: artifactId,
			title: requiredText(input.title, "artifact title"),
			kind: input.kind ?? detected.kind,
			ownership: "managed",
			taskId: requiredText(input.taskId, "task id"),
			attemptId: requiredText(input.attemptId, "attempt id"),
			conversationId: requiredText(input.conversationId, "conversation id"),
			agentId: input.agentId,
			workspaceRoot: resolve(input.workspaceRoot),
			currentVersionId: versionId,
			versionIds: [versionId],
			tags: [],
			createdAt: now,
			updatedAt: now,
		};
		await this.#writeVersion(record, version, source);
		this.#records.set(record.id, record);
		return cloneArtifact(record);
	}

	async addVersion(artifactId: string, input: RegisterArtifactInput): Promise<ArtifactRecord> {
		const record = this.#records.get(artifactId);
		if (!record) throw new Error(`Artifact ${artifactId} was not found`);
		const source = await validateOwnedFile(input.sourcePath, input.allowedRoot);
		const sourceStat = await stat(source);
		if (!sourceStat.isFile()) throw new Error("Artifact source must be a file");
		if (sourceStat.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the 50 MB managed limit");
		const data = await readFile(source);
		const detected = detectArtifact(source);
		const createdAt = Date.now();
		const version: ArtifactVersion = {
			id: randomUUID(),
			artifactId,
			ordinal: record.versionIds.length + 1,
			createdByTaskId: requiredText(input.taskId, "task id"),
			createdByAttemptId: requiredText(input.attemptId, "attempt id"),
			mediaType: detected.mediaType,
			byteLength: data.byteLength,
			sha256: sha256(data),
			fileName: sanitizeFileName(basename(source)),
			sourceRefs: (input.sourceRefs ?? []).map(cloneSourceRef),
			safeSummary: input.safeSummary,
			createdAt,
		};
		await this.#writeVersion(record, version, source);
		record.versionIds.push(version.id);
		record.currentVersionId = version.id;
		record.updatedAt = createdAt;
		record.archivedAt = undefined;
		await this.#persistArtifact(record);
		return cloneArtifact(record);
	}

	async restore(artifactId: string, versionId: string, taskId: string, attemptId: string): Promise<ArtifactRecord> {
		const record = this.#records.get(artifactId);
		if (!record) throw new Error(`Artifact ${artifactId} was not found`);
		if (!record.versionIds.includes(versionId)) throw new Error(`Artifact version ${versionId} was not found`);
		const previous = await this.#readVersion(artifactId, versionId);
		const nextId = randomUUID();
		const next: ArtifactVersion = {
			...previous,
			id: nextId,
			ordinal: record.versionIds.length + 1,
			createdByTaskId: taskId,
			createdByAttemptId: attemptId,
			safeSummary: `Restored version ${previous.ordinal}`,
			createdAt: Date.now(),
		};
		const source = this.#contentPath(artifactId, versionId);
		await this.#writeVersion(record, next, source);
		record.versionIds.push(next.id);
		record.currentVersionId = next.id;
		record.updatedAt = next.createdAt;
		await this.#persistArtifact(record);
		return cloneArtifact(record);
	}

	async archive(id: string): Promise<ArtifactRecord> {
		const record = this.#records.get(id);
		if (!record) throw new Error(`Artifact ${id} was not found`);
		record.archivedAt = Date.now();
		record.updatedAt = record.archivedAt;
		await this.#persistArtifact(record);
		return cloneArtifact(record);
	}

	async delete(id: string): Promise<void> {
		assertIdentifier(id, "artifact id");
		if (!this.#records.delete(id)) throw new Error(`Artifact ${id} was not found`);
		await rm(resolve(this.#root, id), { recursive: true, force: true });
	}

	async #writeVersion(record: ArtifactRecord, version: ArtifactVersion, source: string): Promise<void> {
		const content = this.#contentPath(record.id, version.id);
		await mkdir(dirname(content), { recursive: true });
		const temporary = `${content}.${randomUUID()}.tmp`;
		await copyFile(source, temporary);
		await rename(temporary, content);
		await writeAtomic(this.#versionPath(record.id, version.id), `${JSON.stringify(version, null, 2)}\n`);
		await this.#persistArtifact(record);
	}

	async #readVersion(artifactId: string, versionId: string): Promise<ArtifactVersion> {
		return parseVersion(JSON.parse(await readFile(this.#versionPath(artifactId, versionId), "utf8")));
	}

	#versionPath(artifactId: string, versionId: string): string {
		return resolve(this.#root, artifactId, "versions", versionId, "version.json");
	}

	#contentPath(artifactId: string, versionId: string): string {
		return resolve(this.#root, artifactId, "versions", versionId, "content");
	}

	async #persistArtifact(record: ArtifactRecord): Promise<void> {
		await writeAtomic(resolve(this.#root, record.id, "artifact.json"), `${JSON.stringify(record, null, 2)}\n`);
	}
}

async function validateOwnedFile(path: string, root: string): Promise<string> {
	const candidate = await realpath(resolve(path));
	const owner = await realpath(resolve(root));
	const child = relative(owner, candidate);
	if (child === "" || child === ".") throw new Error("Artifact source must be a file beneath its owned root");
	if (child.startsWith("..") || resolve(owner, child) !== candidate)
		throw new Error("Artifact source escapes its owned root");
	if (process.platform === "win32" && basename(candidate).includes(":")) {
		throw new Error("Artifact source uses an unsupported alternate data stream");
	}
	return candidate;
}

function detectArtifact(path: string): { kind: ArtifactKind; mediaType: string } {
	switch (extname(path).toLowerCase()) {
		case ".md":
			return { kind: "markdown", mediaType: "text/markdown; charset=utf-8" };
		case ".txt":
		case ".log":
			return { kind: "text", mediaType: "text/plain; charset=utf-8" };
		case ".html":
		case ".htm":
			return { kind: "html", mediaType: "text/html; charset=utf-8" };
		case ".png":
			return { kind: "image", mediaType: "image/png" };
		case ".jpg":
		case ".jpeg":
			return { kind: "image", mediaType: "image/jpeg" };
		case ".webp":
			return { kind: "image", mediaType: "image/webp" };
		case ".pdf":
			return { kind: "pdf", mediaType: "application/pdf" };
		case ".csv":
			return { kind: "dataset", mediaType: "text/csv; charset=utf-8" };
		case ".json":
			return { kind: "dataset", mediaType: "application/json" };
		case ".docx":
			return {
				kind: "document",
				mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			};
		case ".xlsx":
			return { kind: "spreadsheet", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
		case ".pptx":
			return {
				kind: "presentation",
				mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
			};
		default:
			return { kind: "other", mediaType: "application/octet-stream" };
	}
}

function parseArtifact(value: unknown): ArtifactRecord {
	const record = object(value, "artifact");
	if (!Array.isArray(record.versionIds) || !record.versionIds.every((entry) => typeof entry === "string")) {
		throw new Error("Invalid artifact versions");
	}
	if (!Array.isArray(record.tags) || !record.tags.every((entry) => typeof entry === "string")) {
		throw new Error("Invalid artifact tags");
	}
	const kind = record.kind;
	if (!isArtifactKind(kind)) throw new Error("Invalid artifact kind");
	return {
		id: requiredText(record.id, "artifact id"),
		title: requiredText(record.title, "artifact title"),
		kind,
		ownership: "managed",
		taskId: requiredText(record.taskId, "artifact task id"),
		attemptId: requiredText(record.attemptId, "artifact attempt id"),
		conversationId: requiredText(record.conversationId, "artifact conversation id"),
		agentId: optionalText(record.agentId),
		workspaceRoot: requiredText(record.workspaceRoot, "artifact workspace"),
		currentVersionId: requiredText(record.currentVersionId, "artifact current version"),
		versionIds: [...record.versionIds],
		tags: [...record.tags],
		createdAt: requiredNumber(record.createdAt, "artifact createdAt"),
		updatedAt: requiredNumber(record.updatedAt, "artifact updatedAt"),
		archivedAt: optionalNumber(record.archivedAt),
	};
}

function parseVersion(value: unknown): ArtifactVersion {
	const record = object(value, "artifact version");
	if (!Array.isArray(record.sourceRefs)) throw new Error("Invalid artifact source references");
	return {
		id: requiredText(record.id, "artifact version id"),
		artifactId: requiredText(record.artifactId, "artifact id"),
		ordinal: requiredNumber(record.ordinal, "artifact version ordinal"),
		createdByTaskId: requiredText(record.createdByTaskId, "artifact version task"),
		createdByAttemptId: requiredText(record.createdByAttemptId, "artifact version attempt"),
		mediaType: requiredText(record.mediaType, "artifact media type"),
		byteLength: requiredNumber(record.byteLength, "artifact byte length"),
		sha256: requiredText(record.sha256, "artifact digest"),
		fileName: requiredText(record.fileName, "artifact file name"),
		sourceRefs: record.sourceRefs.map(parseSourceRef),
		safeSummary: optionalText(record.safeSummary),
		createdAt: requiredNumber(record.createdAt, "artifact version createdAt"),
	};
}

function parseSourceRef(value: unknown): ArtifactSourceRef {
	const record = object(value, "artifact source");
	const kind = record.kind;
	if (kind !== "url" && kind !== "provider" && kind !== "workspace" && kind !== "artifact") {
		throw new Error("Invalid artifact source kind");
	}
	return {
		kind,
		label: requiredText(record.label, "source label"),
		reference: requiredText(record.reference, "source reference"),
	};
}

function cloneArtifact(record: ArtifactRecord): ArtifactRecord {
	return { ...record, versionIds: [...record.versionIds], tags: [...record.tags] };
}

function cloneSourceRef(source: ArtifactSourceRef): ArtifactSourceRef {
	return { ...source };
}

function sha256(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function sanitizeFileName(value: string): string {
	const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim();
	return cleaned.slice(0, 128) || "artifact";
}

function isIdentifier(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertIdentifier(value: string, name: string): void {
	if (!isIdentifier(value)) throw new Error(`${name} is invalid`);
}

function isArtifactKind(value: unknown): value is ArtifactKind {
	return [
		"text",
		"markdown",
		"html",
		"image",
		"pdf",
		"document",
		"spreadsheet",
		"presentation",
		"dataset",
		"browser_workflow",
		"directory",
		"other",
	].includes(String(value));
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
	return value;
}

function optionalText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number`);
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
}
