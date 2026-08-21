import { describe, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { BrowserFrame } from "../src/core/serve/browser-session-manager.ts";
import { BrowserStreamServer, encodeBrowserFrame } from "../src/core/serve/browser-stream-server.ts";

describe("browser stream framing", () => {
	test("encodes bounded metadata before the JPEG payload", () => {
		const packet = encodeBrowserFrame("session-1", {
			jpeg: new Uint8Array([255, 216, 255, 217]),
			width: 1440,
			height: 960,
			timestamp: 123,
		});
		const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
		expect(view.getUint8(0)).toBe(1);
		const metadataLength = view.getUint32(1);
		const metadata = JSON.parse(new TextDecoder().decode(packet.subarray(5, 5 + metadataLength)));
		expect(metadata).toEqual({ sessionId: "session-1", width: 1440, height: 960, timestamp: 123 });
		expect([...packet.subarray(5 + metadataLength)]).toEqual([255, 216, 255, 217]);
	});

	test("delivers a subscribed frame over an open WebSocket", async () => {
		const browserConsole = {
			get: () => ({}),
			async subscribeFrames(_id: string, listener: (frame: BrowserFrame) => void) {
				queueMicrotask(() =>
					listener({ jpeg: new Uint8Array([255, 216, 255, 217]), width: 10, height: 20, timestamp: 123 }),
				);
				return async () => {};
			},
			async pointerClick() {},
			async typeText() {},
			async scroll() {},
		};
		const bridge = new BrowserStreamServer(browserConsole);
		const server = new WebSocketServer({ port: 0 });
		server.on("connection", (socket) => bridge.accept(socket));
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP WebSocket address");
		const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		try {
			await new Promise<void>((resolve, reject) => {
				client.once("open", resolve);
				client.once("error", reject);
			});
			const frame = new Promise<Uint8Array>((resolve) => {
				client.on("message", (data, isBinary) => {
					if (isBinary && data instanceof Buffer) resolve(new Uint8Array(data));
				});
			});
			client.send(JSON.stringify({ type: "subscribe", sessionId: "session-1" }));
			expect((await frame)[0]).toBe(1);
		} finally {
			client.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
