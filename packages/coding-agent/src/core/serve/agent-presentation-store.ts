import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface AgentPresentationMetadata {
	version: 1;
	agentId: string;
	pinnedOrder?: number;
	hidden: boolean;
	lastReadConversationSequence: number;
	updatedAt: number;
}

export interface AgentPresentationUpdate {
	pinnedOrder?: number | null;
	hidden?: boolean;
	lastReadConversationSequence?: number;
}

/** Owns display-only agent preferences outside executable definitions. */
export class AgentPresentationStore implements AsyncDisposable {
	readonly #path: string;
	readonly #queue = new SerialOperationQueue();
	readonly #records = new Map<string, AgentPresentationMetadata>();
	readonly #listeners = new Set<(agentId: string) => void>();

	constructor(root: string) {
		this.#path = resolve(root, "presentation", "agents.json");
	}

	async initialize(): Promise<void> {
		try {
			const value: unknown = JSON.parse(await readFile(this.#path, "utf8"));
			if (typeof value !== "object" || value === null || !("agents" in value) || !Array.isArray(value.agents)) {
				throw new Error("Invalid agent presentation projection");
			}
			for (const entry of value.agents) {
				const record = parsePresentation(entry);
				this.#records.set(record.agentId, record);
			}
		} catch (error) {
			if (isNodeError(error) && error.code !== "ENOENT") throw error;
			// This is a rebuildable display projection. Invalid JSON or records must not block agent execution.
			this.#records.clear();
		}
	}

	get(agentId: string): AgentPresentationMetadata {
		return clonePresentation(this.#records.get(agentId) ?? defaultPresentation(agentId));
	}

	list(): AgentPresentationMetadata[] {
		return [...this.#records.values()].map(clonePresentation);
	}

	async update(agentId: string, update: AgentPresentationUpdate): Promise<AgentPresentationMetadata> {
		return this.#queue.run(async () => {
			const current = this.#records.get(agentId) ?? defaultPresentation(agentId);
			const next: AgentPresentationMetadata = {
				...current,
				pinnedOrder:
					update.pinnedOrder === null
						? undefined
						: update.pinnedOrder === undefined
							? current.pinnedOrder
							: validOrder(update.pinnedOrder),
				hidden: update.hidden ?? current.hidden,
				lastReadConversationSequence:
					update.lastReadConversationSequence === undefined
						? current.lastReadConversationSequence
						: Math.max(current.lastReadConversationSequence, validSequence(update.lastReadConversationSequence)),
				updatedAt: Date.now(),
			};
			this.#records.set(agentId, next);
			await this.#persist();
			for (const listener of this.#listeners) listener(agentId);
			return clonePresentation(next);
		});
	}

	subscribe(listener: (agentId: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	dispose(): Promise<void> {
		return this.#queue.close();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #persist(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		const temporary = `${this.#path}.${randomUUID()}.tmp`;
		const agents = [...this.#records.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
		await writeFile(temporary, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, this.#path);
	}
}

function defaultPresentation(agentId: string): AgentPresentationMetadata {
	return {
		version: 1,
		agentId,
		hidden: false,
		lastReadConversationSequence: 0,
		updatedAt: 0,
	};
}

function parsePresentation(value: unknown): AgentPresentationMetadata {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Invalid agent presentation metadata");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.agentId !== "string" || !record.agentId) {
		throw new Error("Invalid agent presentation identity");
	}
	return {
		version: 1,
		agentId: record.agentId,
		pinnedOrder: record.pinnedOrder === undefined ? undefined : validOrder(record.pinnedOrder),
		hidden: typeof record.hidden === "boolean" ? record.hidden : false,
		lastReadConversationSequence: validSequence(record.lastReadConversationSequence),
		updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
	};
}

function validOrder(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		throw new Error("Pinned order must be a non-negative integer");
	return Number(value);
}

function validSequence(value: unknown): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw new Error("Read sequence must be a non-negative integer");
	}
	return Number(value);
}

function clonePresentation(value: AgentPresentationMetadata): AgentPresentationMetadata {
	return { ...value };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
