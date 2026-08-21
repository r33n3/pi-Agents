import { describe, expect, test } from "vitest";
import { encodeBrowserFrame } from "../src/core/serve/browser-stream-server.ts";

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
});
