import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";

interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): Promise<void>;
}

interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

interface PiServerListener {
	readonly address?: string;
	start(accept: ByteConnectionAcceptor): Promise<void>;
	close(): Promise<void>;
}

import { type WebSocket, WebSocketServer } from "ws";
import { matchesCapabilityToken } from "./capability-token.ts";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTIONS = 8;
const MAX_AUTO_PORT_ATTEMPTS = 100;

export interface WebSocketListenerOptions {
	host: string;
	port: number;
	token: string;
	autoIncrementPort?: boolean;
	onHttpRequest?: (request: IncomingMessage, response: ServerResponse) => void;
	auxiliary?: {
		path: string;
		onConnection(socket: WebSocket): void;
	};
}

class WebSocketConnection implements ByteConnection {
	private closedValue = false;
	private readonly socket: WebSocket;

	constructor(socket: WebSocket) {
		this.socket = socket;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.closedValue) return Promise.resolve();
		if (chunk.byteLength > MAX_FRAME_BYTES) return Promise.reject(new Error("WebSocket frame exceeds 16 MiB"));
		if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
			return Promise.reject(new Error("WebSocket client is not consuming data"));
		}
		return new Promise((resolve, reject) =>
			this.socket.send(chunk, { binary: true }, (error) => {
				if (!error || expectedSocketDisconnect(error)) {
					if (error) this.closedValue = true;
					resolve();
					return;
				}
				reject(error);
			}),
		);
	}

	close(): Promise<void> {
		if (this.closedValue) return Promise.resolve();
		this.closedValue = true;
		this.socket.close();
		return Promise.resolve();
	}

	markClosed(): void {
		this.closedValue = true;
	}
}

/** A token-gated WebSocket byte listener for the local `pi --serve` control plane. */
export class WebSocketListener implements PiServerListener {
	private readonly options: WebSocketListenerOptions;
	private server: Server | undefined;
	private sockets: WebSocketServer | undefined;
	private auxiliarySockets: WebSocketServer | undefined;
	private accept: ByteConnectionAcceptor | undefined;
	private boundAddress: string | undefined;
	private boundPort: number | undefined;

	constructor(options: WebSocketListenerOptions) {
		this.options = options;
	}

	get address(): string | undefined {
		return this.boundAddress;
	}

	get port(): number | undefined {
		return this.boundPort;
	}

	async start(accept: ByteConnectionAcceptor): Promise<void> {
		if (this.server) throw new Error("WebSocket listener is already started");
		this.accept = accept;
		const server = createServer((request, response) => {
			if (this.options.onHttpRequest) {
				this.options.onHttpRequest(request, response);
				return;
			}
			response.writeHead(404).end();
		});
		this.server = server;
		try {
			const port = await listen(
				server,
				this.options.host,
				this.options.port,
				this.options.autoIncrementPort === true,
			);
			const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
			sockets.on("connection", (socket, request) => this.acceptSocket(socket, request.url));
			this.sockets = sockets;
			if (this.options.auxiliary) {
				const auxiliarySockets = new WebSocketServer({
					noServer: true,
					maxPayload: MAX_FRAME_BYTES,
				});
				auxiliarySockets.on("connection", (socket, request) => this.acceptAuxiliarySocket(socket, request.url));
				this.auxiliarySockets = auxiliarySockets;
			}
			server.on("upgrade", (request, socket, head) => {
				const path = new URL(request.url ?? "/", "http://localhost").pathname;
				const target =
					path === "/pi"
						? this.sockets
						: path === this.options.auxiliary?.path
							? this.auxiliarySockets
							: undefined;
				if (!target) {
					socket.destroy();
					return;
				}
				target.handleUpgrade(request, socket, head, (webSocket) => {
					target.emit("connection", webSocket, request);
				});
			});
			this.boundPort = port;
			const urlHost = this.options.host.includes(":") ? `[${this.options.host}]` : this.options.host;
			this.boundAddress = `ws://${urlHost}:${port}/pi`;
		} catch (error) {
			this.server = undefined;
			this.accept = undefined;
			throw error;
		}
	}

	async close(): Promise<void> {
		this.boundAddress = undefined;
		this.boundPort = undefined;
		for (const socket of this.sockets?.clients ?? []) socket.terminate();
		for (const socket of this.auxiliarySockets?.clients ?? []) socket.terminate();
		await new Promise<void>((resolve) => this.sockets?.close(() => resolve()) ?? resolve());
		await new Promise<void>((resolve) => this.auxiliarySockets?.close(() => resolve()) ?? resolve());
		await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
		this.sockets = undefined;
		this.auxiliarySockets = undefined;
		this.server = undefined;
	}

	private acceptSocket(socket: WebSocket, requestUrl: string | undefined): void {
		const token = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("token");
		if (!matchesCapabilityToken(this.options.token, token)) {
			socket.close(1008, "Unauthorized");
			return;
		}
		if ((this.sockets?.clients.size ?? 0) > MAX_CONNECTIONS) {
			socket.close(1013, "Connection limit reached");
			return;
		}
		const accept = this.accept;
		if (!accept) {
			socket.close();
			return;
		}
		const connection = new WebSocketConnection(socket);
		const handler = accept(connection);
		socket.on("message", (data, isBinary) => {
			if (!isBinary) {
				handler.onError(new Error("PiServer requires binary WebSocket frames"));
				socket.close(1003, "Binary frames required");
				return;
			}
			const bytes = data instanceof Buffer ? data : Buffer.concat(data as Buffer[]);
			handler.onData(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		});
		socket.on("error", (error) => {
			if (!expectedSocketDisconnect(error)) handler.onError(error);
		});
		socket.once("close", () => {
			connection.markClosed();
			handler.onClose();
		});
	}

	private acceptAuxiliarySocket(socket: WebSocket, requestUrl: string | undefined): void {
		const token = new URL(requestUrl ?? "/", "http://localhost").searchParams.get("token");
		if (!matchesCapabilityToken(this.options.token, token)) {
			socket.close(1008, "Unauthorized");
			return;
		}
		if ((this.auxiliarySockets?.clients.size ?? 0) > MAX_CONNECTIONS) {
			socket.close(1013, "Connection limit reached");
			return;
		}
		this.options.auxiliary?.onConnection(socket);
	}
}

export function expectedSocketDisconnect(error: Error): boolean {
	if (!("code" in error) || typeof error.code !== "string") return false;
	return ["ECONNRESET", "EPIPE", "WS_ERR_SOCKET_CLOSED"].includes(error.code);
}

async function listen(server: Server, host: string, requestedPort: number, autoIncrement: boolean): Promise<number> {
	const attempts = autoIncrement ? MAX_AUTO_PORT_ATTEMPTS : 1;
	for (let offset = 0; offset < attempts && requestedPort + offset <= 65_535; offset++) {
		const candidate = requestedPort + offset;
		try {
			await listenOnce(server, host, candidate);
			const address = server.address();
			return address && typeof address !== "string" ? address.port : candidate;
		} catch (error) {
			if (!autoIncrement || !isAddressInUse(error)) throw error;
		}
	}
	throw new Error(
		`No available TCP port found from ${requestedPort} through ${Math.min(65_535, requestedPort + attempts - 1)}`,
	);
}

function listenOnce(server: Server, host: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
}
