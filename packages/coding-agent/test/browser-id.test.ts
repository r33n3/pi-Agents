import { describe, expect, test } from "vitest";
import { createBrowserId } from "../src/core/serve/browser/browser-id.ts";

describe("createBrowserId", () => {
	test("uses randomUUID when the browser exposes it", () => {
		expect(
			createBrowserId({
				randomUUID: () => "secure-context-id",
				getRandomValues: (bytes) => bytes,
			}),
		).toBe("secure-context-id");
	});

	test("falls back to getRandomValues on LAN HTTP pages", () => {
		expect(
			createBrowserId({
				getRandomValues: (bytes) => {
					bytes.forEach((_, index) => {
						bytes[index] = index;
					});
					return bytes;
				},
			}),
		).toBe("000102030405060708090a0b0c0d0e0f");
	});
});
