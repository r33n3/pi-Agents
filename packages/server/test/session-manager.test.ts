import { ClientMessageDecoder, type EventEnvelope } from "@earendil-works/pi-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ByteConnection, ConnectionState } from "../src/connection.ts";
import { LiveSessionManager } from "../src/sessions.ts";
import { TestServerService } from "../src/testing/service.ts";

const timers = new Set<NodeJS.Timeout>();

afterEach(() => {
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
});

describe("LiveSessionManager", () => {
	test("returns the initial session snapshot without broadcasting a duplicate", async () => {
		const service = new TestServerService();
		service.seed();
		const sent: EventEnvelope[] = [];
		const manager = new LiveSessionManager({
			service,
			isClosing: () => false,
			sendMessage: (_connection, message) => {
				sent.push(message);
				return Promise.resolve(true);
			},
			closeConnection: () => Promise.resolve(),
			disconnect: () => Promise.resolve(),
			broadcastServerSnapshot: vi.fn(),
			reportError: (error) => {
				throw error;
			},
		});
		const connection = createConnection();

		const result = await manager.executeCommand(connection, { command: "attach", sessionId: "session-1" });

		expect(result).toMatchObject({ command: "attach", session: { id: "session-1", attached: true } });
		expect(sent).toEqual([]);
		await manager.disconnect(connection);
	});
});

function createConnection(): ConnectionState {
	const timer = setTimeout(() => {}, 60_000);
	timers.add(timer);
	const connection: ByteConnection = {
		closed: false,
		send: () => Promise.resolve(),
		close: () => {},
	};
	return {
		id: "connection-1",
		connection,
		decoder: new ClientMessageDecoder(),
		sessionIds: new Set(),
		stage: "ready",
		disconnected: false,
		handshakeComplete: true,
		handshakeTimeout: timer,
	};
}
