import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import { SerialOperationQueue } from "./serial-operation-queue.ts";

export type InboundDestination =
	| { kind: "agent"; id: string }
	| { kind: "session"; id: string }
	| { kind: "coordinator"; id: string };

export interface InboundRoute {
	id: string;
	connectionId: string;
	destination: InboundDestination;
	allowedSenders: string[];
	maxEventsPerMinute: number;
	enabled: boolean;
}

export interface InboundEvent {
	id: string;
	sender: string;
	text: string;
	receivedAt: string;
	route: InboundRoute;
}

interface InboundState {
	version: 1;
	routes: Record<string, InboundRoute>;
	processed: Record<string, string>;
}

/** Verifies signed inbound messages, fixes their destination, rate-limits senders, and deduplicates delivery. */
export class InboundRoutingService {
	readonly #statePath: string;
	readonly #connections: CapabilityConnectionRegistry;
	readonly #secretResolver: (secretRef: string) => string | undefined;
	readonly #queue = new SerialOperationQueue();
	readonly #recent = new Map<string, number[]>();
	#state: InboundState = { version: 1, routes: {}, processed: {} };

	constructor(
		directory: string,
		connections: CapabilityConnectionRegistry,
		secretResolver: (secretRef: string) => string | undefined,
	) {
		this.#statePath = resolve(directory, "inbound-routes.json");
		this.#connections = connections;
		this.#secretResolver = secretResolver;
	}

	async initialize(): Promise<void> {
		await mkdir(dirname(this.#statePath), { recursive: true });
		try {
			this.#state = normalizeState(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
			await this.#persist();
		}
	}

	listRoutes(): InboundRoute[] {
		return Object.values(this.#state.routes).sort((left, right) => left.id.localeCompare(right.id));
	}

	async saveRoute(route: InboundRoute): Promise<InboundRoute> {
		const normalized = normalizeRoute(route);
		const connection = this.#connections.find(normalized.connectionId);
		if (!connection || connection.status !== "active") {
			throw new Error(`Inbound route connection ${normalized.connectionId} is unavailable`);
		}
		if (!connection.capabilityIds.some((id) => id.startsWith("messaging.") || id.startsWith("email."))) {
			throw new Error(`Inbound route connection ${normalized.connectionId} has no messaging capability`);
		}
		return this.#queue.run(async () => {
			this.#state.routes[normalized.id] = normalized;
			await this.#persist();
			return normalized;
		});
	}

	async deleteRoute(id: string): Promise<boolean> {
		return this.#queue.run(async () => {
			if (!this.#state.routes[id]) return false;
			delete this.#state.routes[id];
			for (const key of Object.keys(this.#state.processed)) {
				if (key.startsWith(`${id}:`)) delete this.#state.processed[key];
			}
			await this.#persist();
			return true;
		});
	}

	async accept(
		routeId: string,
		timestamp: string,
		signature: string,
		rawBody: Buffer,
	): Promise<InboundEvent | undefined> {
		if (rawBody.byteLength === 0 || rawBody.byteLength > 256 * 1024)
			throw new Error("Inbound message body is invalid");
		const route = this.#state.routes[routeId];
		if (!route?.enabled) throw new Error(`Inbound route ${routeId} is unavailable`);
		const connection = this.#connections.find(route.connectionId);
		if (!connection || connection.status !== "active") throw new Error(`Inbound route connection is unavailable`);
		const epochSeconds = Number(timestamp);
		if (!Number.isSafeInteger(epochSeconds) || Math.abs(Date.now() - epochSeconds * 1000) > 5 * 60_000) {
			throw new Error("Inbound message timestamp is invalid or expired");
		}
		const secret = this.#secretResolver(connection.secretRef);
		if (!secret) throw new Error(`Inbound route secret ${connection.secretRef} is unavailable`);
		verifySignature(secret, timestamp, rawBody, signature);
		const body = record(JSON.parse(rawBody.toString("utf8")) as unknown, "inbound message");
		const eventId = requiredString(body.eventId, "eventId");
		const sender = requiredString(body.sender, "sender");
		const text = requiredString(body.text, "text");
		if (text.length > 50_000) throw new Error("Inbound message text exceeds 50000 characters");
		if (route.allowedSenders.length > 0 && !route.allowedSenders.includes(sender)) {
			throw new Error(`Inbound sender ${sender} is not allowed`);
		}
		this.#assertRate(route, sender);
		return this.#queue.run(async () => {
			const dedupeKey = `${route.id}:${eventId}`;
			if (this.#state.processed[dedupeKey]) return undefined;
			const receivedAt = new Date().toISOString();
			this.#state.processed[dedupeKey] = receivedAt;
			const entries = Object.entries(this.#state.processed).sort((left, right) => right[1].localeCompare(left[1]));
			this.#state.processed = Object.fromEntries(entries.slice(0, 10_000));
			await this.#persist();
			return { id: eventId, sender, text, receivedAt, route };
		});
	}

	#assertRate(route: InboundRoute, sender: string): void {
		const key = `${route.id}:${sender}`;
		const cutoff = Date.now() - 60_000;
		const recent = (this.#recent.get(key) ?? []).filter((time) => time > cutoff);
		if (recent.length >= route.maxEventsPerMinute) throw new Error("Inbound sender rate limit exceeded");
		recent.push(Date.now());
		this.#recent.set(key, recent);
	}

	async #persist(): Promise<void> {
		const temporary = resolve(dirname(this.#statePath), `.inbound-routes.${randomUUID()}.tmp`);
		await writeFile(temporary, `${JSON.stringify(this.#state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, this.#statePath);
	}
}

function verifySignature(secret: string, timestamp: string, body: Buffer, signature: string): void {
	const supplied = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
	if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new Error("Inbound message signature is invalid");
	const expected = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest();
	const received = Buffer.from(supplied, "hex");
	if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
		throw new Error("Inbound message signature is invalid");
	}
}

function normalizeState(value: unknown): InboundState {
	const input = record(value, "inbound routing state");
	if (input.version !== 1) throw new Error("Inbound routing state version is unsupported");
	const routeInput = record(input.routes, "inbound routes");
	const processedInput = record(input.processed, "processed inbound events");
	const routes: Record<string, InboundRoute> = {};
	for (const [id, route] of Object.entries(routeInput)) routes[id] = normalizeRoute(route);
	const processed: Record<string, string> = {};
	for (const [id, timestamp] of Object.entries(processedInput)) processed[id] = requiredString(timestamp, "timestamp");
	return { version: 1, routes, processed };
}

function normalizeRoute(value: unknown): InboundRoute {
	const input = record(value, "inbound route");
	const id = identifier(input.id, "route id");
	const destinationInput = record(input.destination, "destination");
	const kind = destinationInput.kind;
	if (kind !== "agent" && kind !== "session" && kind !== "coordinator") throw new Error("destination kind is invalid");
	if (!Array.isArray(input.allowedSenders) || input.allowedSenders.some((entry) => typeof entry !== "string")) {
		throw new Error("allowedSenders must be a string list");
	}
	if (
		!Number.isSafeInteger(input.maxEventsPerMinute) ||
		Number(input.maxEventsPerMinute) < 1 ||
		Number(input.maxEventsPerMinute) > 120
	) {
		throw new Error("maxEventsPerMinute must be between 1 and 120");
	}
	if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
	return {
		id,
		connectionId: identifier(input.connectionId, "connection id"),
		destination: { kind, id: identifier(destinationInput.id, "destination id") },
		allowedSenders: [...new Set(input.allowedSenders.map((entry) => entry.trim()).filter(Boolean))].sort(),
		maxEventsPerMinute: Number(input.maxEventsPerMinute),
		enabled: input.enabled,
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
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error(`${name} is invalid`);
	return id;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
