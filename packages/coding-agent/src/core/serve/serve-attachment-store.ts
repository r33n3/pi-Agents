import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

export const MAX_SERVE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_SERVE_ATTACHMENTS_PER_PROMPT = 8;

export interface ServeAttachment {
	id: string;
	sessionId: string;
	name: string;
	mimeType: string;
	size: number;
	path: string;
}

export interface ServeAttachmentInput {
	sessionId: string;
	name: string;
	mimeType?: string;
	data: string;
}

export type ServeAttachmentScanner = (attachment: ServeAttachment) => Promise<void>;

/** Owns short-lived, process-local files uploaded through the web console. */
export class ServeAttachmentStore {
	readonly #rootPromise = mkdtemp(join(tmpdir(), "pi-serve-attachments-"));
	readonly #attachments = new Map<string, ServeAttachment>();
	readonly #scanner: ServeAttachmentScanner | undefined;

	constructor(scanner?: ServeAttachmentScanner) {
		this.#scanner = scanner;
	}

	async save(input: ServeAttachmentInput): Promise<ServeAttachment> {
		const sessionId = requiredSegment(input.sessionId, "sessionId");
		const name = safeFilename(input.name);
		const mimeType = normalizeMimeType(input.mimeType);
		const data = decodeBase64(input.data);
		if (data.length === 0) throw new Error("Attachment is empty");
		if (data.length > MAX_SERVE_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 10 MiB");

		const id = randomUUID();
		const directory = join(await this.#rootPromise, sessionId);
		await mkdir(directory, { recursive: true });
		const path = join(directory, `${id}${extname(name).slice(0, 16)}`);
		await writeFile(path, data, { flag: "wx" });
		const attachment = { id, sessionId, name, mimeType, size: data.length, path };
		try {
			await this.#scanner?.(attachment);
		} catch (error) {
			await rm(path, { force: true });
			throw error;
		}
		this.#attachments.set(id, attachment);
		return attachment;
	}

	get(id: string): ServeAttachment | undefined {
		return this.#attachments.get(id);
	}

	getForSession(sessionId: string, ids: string[]): ServeAttachment[] {
		if (ids.length > MAX_SERVE_ATTACHMENTS_PER_PROMPT) {
			throw new Error(`A prompt can include at most ${MAX_SERVE_ATTACHMENTS_PER_PROMPT} attachments`);
		}
		const uniqueIds = new Set(ids);
		if (uniqueIds.size !== ids.length) throw new Error("Attachment ids must be unique");
		return ids.map((id) => {
			const attachment = this.#attachments.get(id);
			if (!attachment || attachment.sessionId !== sessionId) throw new Error(`Unknown attachment: ${id}`);
			return attachment;
		});
	}

	async read(id: string): Promise<Buffer> {
		const attachment = this.#attachments.get(id);
		if (!attachment) throw new Error("Attachment not found");
		return readFile(attachment.path);
	}

	async rename(id: string, name: string): Promise<ServeAttachment> {
		const attachment = this.#attachments.get(id);
		if (!attachment) throw new Error("Attachment not found");
		const safeName = safeFilename(name);
		const nextPath = join(
			await this.#rootPromise,
			attachment.sessionId,
			`${attachment.id}${extname(safeName).slice(0, 16)}`,
		);
		if (nextPath !== attachment.path) await rename(attachment.path, nextPath);
		const updated = { ...attachment, name: safeName, path: nextPath };
		this.#attachments.set(id, updated);
		return updated;
	}

	async delete(id: string): Promise<boolean> {
		const attachment = this.#attachments.get(id);
		if (!attachment) return false;
		this.#attachments.delete(id);
		await rm(attachment.path, { force: true });
		return true;
	}

	async dispose(): Promise<void> {
		this.#attachments.clear();
		await rm(await this.#rootPromise, { recursive: true, force: true });
	}
}

function requiredSegment(value: string, name: string): string {
	const trimmed = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)) {
		throw new Error(`${name} is invalid`);
	}
	return trimmed;
}

function safeFilename(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || basename(trimmed) !== trimmed || /[\0<>:"|?*]/.test(trimmed)) {
		throw new Error("Attachment name is invalid");
	}
	return trimmed.slice(0, 180);
}

function normalizeMimeType(value: string | undefined): string {
	const mimeType = value?.trim().toLowerCase() || "application/octet-stream";
	if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) {
		throw new Error("Attachment MIME type is invalid");
	}
	return mimeType;
}

function decodeBase64(value: string): Buffer {
	const normalized = value.replace(/\s/g, "");
	if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
		throw new Error("Attachment data is not valid base64");
	}
	return Buffer.from(normalized, "base64");
}
