import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { WebSocketListener } from "../src/core/serve/websocket-listener.ts";

describe("WebSocketListener", () => {
	let listener: WebSocketListener;
	let received: Uint8Array[];

	beforeEach(async () => {
		received = [];
		listener = new WebSocketListener({ host: "127.0.0.1", port: 0, token: "secret-token" });
		await listener.start(() => ({
			onData: (chunk) => received.push(chunk),
			onClose: () => {},
			onError: () => {},
		}));
	});

	afterEach(async () => {
		await listener.close();
	});

	test("accepts authorized binary clients", async () => {
		const socket = await connect(`${listener.address}?token=secret-token`);
		socket.send(Buffer.from([1, 2, 3]), { binary: true });
		await expect.poll(() => received.length).toBe(1);
		expect([...received[0]]).toEqual([1, 2, 3]);
		socket.close();
	});

	test("closes clients with an invalid token", async () => {
		const socket = await connect(`${listener.address}?token=wrong`);
		const code = await new Promise<number>((resolve) => socket.once("close", resolve));
		expect(code).toBe(1008);
	});

	test("rejects text protocol frames", async () => {
		const socket = await connect(`${listener.address}?token=secret-token`);
		socket.send("not binary");
		const code = await new Promise<number>((resolve) => socket.once("close", resolve));
		expect(code).toBe(1003);
	});

	test("selects the next port when automatic selection is enabled", async () => {
		const blocker = createServer();
		await listenHttp(blocker);
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("Expected an IP listener");
		const fallback = new WebSocketListener({
			host: "127.0.0.1",
			port: address.port,
			token: "fallback-token",
			autoIncrementPort: true,
		});
		try {
			await fallback.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} }));
			expect(fallback.port).toBeGreaterThan(address.port);
		} finally {
			await fallback.close();
			await closeHttp(blocker);
		}
	});

	test("rejects an occupied explicit port without an unhandled WebSocket error", async () => {
		const blocker = createServer();
		await listenHttp(blocker);
		const address = blocker.address();
		if (!address || typeof address === "string") throw new Error("Expected an IP listener");
		const strict = new WebSocketListener({ host: "127.0.0.1", port: address.port, token: "strict-token" });
		try {
			await expect(
				strict.start(() => ({ onData: () => {}, onClose: () => {}, onError: () => {} })),
			).rejects.toMatchObject({ code: "EADDRINUSE" });
		} finally {
			await strict.close();
			await closeHttp(blocker);
		}
	});
});

function connect(url: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function listenHttp(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function closeHttp(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
