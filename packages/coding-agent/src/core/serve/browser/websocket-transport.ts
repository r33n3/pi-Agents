import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "@earendil-works/pi-client";

export function createBrowserWebSocketTransport(url: string): ByteTransportFactory {
	return (handlers) => connect(url, handlers);
}

function connect(url: string, handlers: ByteTransportHandlers): Promise<ByteTransport> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.binaryType = "arraybuffer";
		let connected = false;
		let closed = false;

		socket.addEventListener("open", () => {
			if (closed) return;
			connected = true;
			resolve(
				new BrowserWebSocketTransport(socket, () => {
					closed = true;
				}),
			);
		});
		socket.addEventListener("message", (event) => {
			if (!closed && event.data instanceof ArrayBuffer) handlers.onData(new Uint8Array(event.data));
		});
		socket.addEventListener("close", () => {
			if (closed) return;
			closed = true;
			if (connected) handlers.onClose();
			else reject(new Error("WebSocket closed before the Pi protocol handshake"));
		});
		socket.addEventListener("error", () => {
			if (closed) return;
			const error = new Error("WebSocket transport failed");
			if (connected) handlers.onError(error);
			else {
				closed = true;
				reject(error);
			}
		});
	});
}

class BrowserWebSocketTransport implements ByteTransport {
	readonly #socket: WebSocket;
	readonly #markClosed: () => void;
	#closed = false;

	constructor(socket: WebSocket, markClosed: () => void) {
		this.#socket = socket;
		this.#markClosed = markClosed;
	}

	send(chunk: Uint8Array): Promise<void> {
		if (this.#closed) return Promise.reject(new Error("WebSocket transport is closed"));
		this.#socket.send(chunk);
		return Promise.resolve();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#markClosed();
		this.#socket.close();
	}
}
