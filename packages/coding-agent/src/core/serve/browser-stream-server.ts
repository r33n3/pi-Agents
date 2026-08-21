import { type RawData, WebSocket } from "ws";
import type { BrowserFrame } from "./browser-session-manager.ts";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 128 * 1024;
const FRAME_VERSION = 1;

interface StreamRequest {
	type: "subscribe" | "input";
	sessionId: string;
	requestId?: string;
	input?: unknown;
}

interface BrowserStreamConsole {
	get(id: string): unknown;
	subscribeFrames(id: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>>;
	pointerClick(id: string, x: number, y: number): Promise<void>;
	typeText(id: string, text: string): Promise<void>;
	scroll(id: string, deltaX: number, deltaY: number): Promise<void>;
}

/** Bridges managed Chromium frames and user input over one authenticated WebSocket. */
export class BrowserStreamServer {
	readonly #browserConsole: BrowserStreamConsole;

	constructor(browserConsole: BrowserStreamConsole) {
		this.#browserConsole = browserConsole;
	}

	accept(socket: WebSocket): void {
		let unsubscribe: (() => Promise<void>) | undefined;
		let activeSessionId: string | undefined;
		let closed = false;
		let chain = Promise.resolve();
		const closeSubscription = async () => {
			const stop = unsubscribe;
			unsubscribe = undefined;
			activeSessionId = undefined;
			await stop?.();
		};
		socket.on("message", (data, isBinary) => {
			chain = chain
				.then(async () => {
					if (isBinary) throw new Error("Browser stream accepts JSON control messages only");
					const request = parseRequest(data);
					if (request.type === "subscribe") {
						if (request.sessionId === activeSessionId) return;
						await closeSubscription();
						if (!this.#browserConsole.get(request.sessionId)) throw new Error("Browser session not found");
						activeSessionId = request.sessionId;
						const stop = await this.#browserConsole.subscribeFrames(request.sessionId, (frame) => {
							if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
							socket.send(encodeBrowserFrame(request.sessionId, frame), { binary: true });
						});
						if (closed) {
							await stop();
							return;
						}
						unsubscribe = stop;
						this.#sendJson(socket, { type: "subscribed", sessionId: request.sessionId });
						return;
					}
					await this.#handleInput(request);
					this.#sendJson(socket, { type: "inputResult", requestId: request.requestId, ok: true });
				})
				.catch((error: unknown) => {
					this.#sendJson(socket, {
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				});
		});
		const close = () => {
			closed = true;
			void closeSubscription();
		};
		socket.once("close", close);
		socket.once("error", close);
	}

	async #handleInput(request: StreamRequest): Promise<void> {
		const input = object(request.input, "browser input");
		if (input.kind === "click") {
			await this.#browserConsole.pointerClick(
				request.sessionId,
				finiteNumber(input.x, "x"),
				finiteNumber(input.y, "y"),
			);
			return;
		}
		if (input.kind === "type") {
			if (typeof input.text !== "string" || input.text.length === 0) throw new Error("text is required");
			await this.#browserConsole.typeText(request.sessionId, input.text);
			return;
		}
		if (input.kind === "scroll") {
			await this.#browserConsole.scroll(
				request.sessionId,
				finiteNumber(input.deltaX, "deltaX"),
				finiteNumber(input.deltaY, "deltaY"),
			);
			return;
		}
		throw new Error("Unsupported browser input kind");
	}

	#sendJson(socket: WebSocket, value: unknown): void {
		if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= MAX_BUFFERED_BYTES) {
			socket.send(JSON.stringify(value));
		}
	}
}

export function encodeBrowserFrame(sessionId: string, frame: BrowserFrame): Uint8Array {
	const metadata = Buffer.from(
		JSON.stringify({ sessionId, width: frame.width, height: frame.height, timestamp: frame.timestamp }),
		"utf8",
	);
	const packet = Buffer.allocUnsafe(5 + metadata.byteLength + frame.jpeg.byteLength);
	packet.writeUInt8(FRAME_VERSION, 0);
	packet.writeUInt32BE(metadata.byteLength, 1);
	metadata.copy(packet, 5);
	packet.set(frame.jpeg, 5 + metadata.byteLength);
	return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength);
}

function parseRequest(data: RawData): StreamRequest {
	const bytes = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
	if (bytes.byteLength > MAX_MESSAGE_BYTES) throw new Error("Browser stream message exceeds 128 KiB");
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	const request = object(value, "browser stream request");
	if ((request.type !== "subscribe" && request.type !== "input") || typeof request.sessionId !== "string") {
		throw new Error("Browser stream request is invalid");
	}
	return {
		type: request.type,
		sessionId: request.sessionId,
		requestId: typeof request.requestId === "string" ? request.requestId : undefined,
		input: request.input,
	};
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
	return value;
}
