import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export interface SiteMonitorDefinition {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface FinanceWatchlistDefinition {
	id: string;
	name: string;
	symbols: string[];
	providerId?: string;
	connectionId?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

interface EverydayConfigurationState {
	version: 1;
	monitors: Record<string, SiteMonitorDefinition>;
	watchlists: Record<string, FinanceWatchlistDefinition>;
}

type SiteMonitorInput = Omit<SiteMonitorDefinition, "createdAt" | "updatedAt">;
type FinanceWatchlistInput = Omit<FinanceWatchlistDefinition, "createdAt" | "updatedAt">;

/** Owns validated, durable targets used by everyday-data tools and routines. */
export class EverydayConfigurationRegistry {
	readonly #path: string;
	readonly #queue = new SerialOperationQueue();
	#state: EverydayConfigurationState = { version: 1, monitors: {}, watchlists: {} };

	constructor(directory: string) {
		this.#path = resolve(directory, "configurations.json");
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.#path), { recursive: true });
		try {
			this.#state = normalizeState(JSON.parse(await readFile(this.#path, "utf8")) as unknown);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			await this.#persist();
		}
	}

	snapshot(): { monitors: SiteMonitorDefinition[]; watchlists: FinanceWatchlistDefinition[] } {
		return {
			monitors: Object.values(this.#state.monitors).sort((left, right) => left.name.localeCompare(right.name)),
			watchlists: Object.values(this.#state.watchlists).sort((left, right) => left.name.localeCompare(right.name)),
		};
	}

	findMonitor(id: string): SiteMonitorDefinition | undefined {
		return this.#state.monitors[id];
	}

	async saveMonitor(input: SiteMonitorInput): Promise<SiteMonitorDefinition> {
		return this.#queue.run(async () => {
			const existing = this.#state.monitors[input.id];
			const now = new Date().toISOString();
			const monitor = normalizeMonitor({
				...input,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
			this.#state.monitors[monitor.id] = monitor;
			await this.#persist();
			return monitor;
		});
	}

	async deleteMonitor(id: string): Promise<boolean> {
		return this.#delete("monitors", identifier(id, "monitor id"));
	}

	async saveWatchlist(input: FinanceWatchlistInput): Promise<FinanceWatchlistDefinition> {
		return this.#queue.run(async () => {
			const existing = this.#state.watchlists[input.id];
			const now = new Date().toISOString();
			const watchlist = normalizeWatchlist({
				...input,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			});
			this.#state.watchlists[watchlist.id] = watchlist;
			await this.#persist();
			return watchlist;
		});
	}

	async deleteWatchlist(id: string): Promise<boolean> {
		return this.#delete("watchlists", identifier(id, "watchlist id"));
	}

	async #delete(collection: "monitors" | "watchlists", id: string): Promise<boolean> {
		return this.#queue.run(async () => {
			if (!this.#state[collection][id]) return false;
			delete this.#state[collection][id];
			await this.#persist();
			return true;
		});
	}

	async #persist(): Promise<void> {
		const temporary = resolve(dirname(this.#path), `.configurations.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, this.#path);
	}
}

function normalizeState(value: unknown): EverydayConfigurationState {
	const input = record(value, "everyday configuration state");
	if (input.version !== 1) throw new Error("Everyday configuration state version is unsupported");
	const monitors: Record<string, SiteMonitorDefinition> = {};
	for (const [id, value] of Object.entries(record(input.monitors, "site monitors"))) {
		const monitor = normalizeMonitor(value);
		if (monitor.id !== id) throw new Error(`Site monitor key ${id} does not match its id`);
		monitors[id] = monitor;
	}
	const watchlists: Record<string, FinanceWatchlistDefinition> = {};
	for (const [id, value] of Object.entries(record(input.watchlists, "finance watchlists"))) {
		const watchlist = normalizeWatchlist(value);
		if (watchlist.id !== id) throw new Error(`Finance watchlist key ${id} does not match its id`);
		watchlists[id] = watchlist;
	}
	return { version: 1, monitors, watchlists };
}

function normalizeMonitor(value: unknown): SiteMonitorDefinition {
	const input = record(value, "site monitor");
	const url = new URL(requiredString(input.url, "url"));
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Site monitor URL must use HTTP or HTTPS");
	return {
		id: identifier(input.id, "monitor id"),
		name: requiredString(input.name, "name"),
		url: url.href,
		enabled: boolean(input.enabled, "enabled"),
		createdAt: requiredString(input.createdAt, "createdAt"),
		updatedAt: requiredString(input.updatedAt, "updatedAt"),
	};
}

function normalizeWatchlist(value: unknown): FinanceWatchlistDefinition {
	const input = record(value, "finance watchlist");
	if (!Array.isArray(input.symbols) || input.symbols.length === 0 || input.symbols.length > 100) {
		throw new Error("Finance watchlist must contain between 1 and 100 symbols");
	}
	const symbols = [...new Set(input.symbols.map((entry) => requiredString(entry, "symbol").toUpperCase()))].sort();
	if (symbols.some((symbol) => !/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol))) {
		throw new Error("Finance watchlist contains an invalid symbol");
	}
	return {
		id: identifier(input.id, "watchlist id"),
		name: requiredString(input.name, "name"),
		symbols,
		providerId: optionalIdentifier(input.providerId, "providerId"),
		connectionId: optionalIdentifier(input.connectionId, "connectionId"),
		enabled: boolean(input.enabled, "enabled"),
		createdAt: requiredString(input.createdAt, "createdAt"),
		updatedAt: requiredString(input.updatedAt, "updatedAt"),
	};
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function identifier(value: unknown, name: string): string {
	const id = requiredString(value, name);
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`${name} is invalid`);
	return id;
}

function optionalIdentifier(value: unknown, name: string): string | undefined {
	return value === undefined || value === "" ? undefined : identifier(value, name);
}

function boolean(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
	return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
