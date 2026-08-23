import { describe, expect, test } from "vitest";
import { BrowserPolicy } from "../src/core/serve/browser-policy.ts";

describe("BrowserPolicy", () => {
	test("allows only loopback http URLs for loopback access", () => {
		const policy = new BrowserPolicy("loopback");
		expect(policy.assertNavigation("http://localhost:4173/").href).toBe("http://localhost:4173/");
		expect(policy.assertNavigation("https://127.0.0.1:3000/").hostname).toBe("127.0.0.1");
		expect(policy.assertNavigation("http://[::1]:4173/").hostname).toBe("[::1]");
		expect(() => policy.assertNavigation("https://example.com/")).toThrow("does not allow");
	});

	test("rejects unsafe protocols and disabled access", () => {
		expect(() => new BrowserPolicy("public-web").assertNavigation("file:///secret.txt")).toThrow("http and https");
		expect(() => new BrowserPolicy("disabled").assertNavigation("https://example.com/")).toThrow("disabled");
	});

	test("accepts private IP literals only for private-network access", () => {
		const policy = new BrowserPolicy("private-network");
		expect(policy.assertNavigation("http://192.168.1.20/").hostname).toBe("192.168.1.20");
		expect(() => policy.assertNavigation("https://example.com/")).toThrow("does not allow");
	});

	test("rejects private IP literals from public-web access after address validation", async () => {
		const policy = new BrowserPolicy("public-web");
		await expect(policy.assertResolvedNavigation("http://127.0.0.1:4173/")).rejects.toThrow(
			"does not allow resolved address",
		);
		await expect(policy.assertResolvedNavigation("http://192.168.1.20/")).rejects.toThrow(
			"does not allow resolved address",
		);
		await expect(policy.assertResolvedNavigation("http://[::1]/")).rejects.toThrow("does not allow resolved address");
	});
});
