import { describe, expect, test } from "vitest";
import { BrowserPolicy, browserAccessForUrl } from "../src/core/serve/browser-policy.ts";

describe("BrowserPolicy", () => {
	test("allows only loopback http URLs for loopback access", () => {
		const policy = new BrowserPolicy("loopback");
		expect(policy.assertNavigation("http://localhost:4173/").href).toBe("http://localhost:4173/");
		expect(policy.assertNavigation("http://app.localhost:4173/").hostname).toBe("app.localhost");
		expect(policy.assertNavigation("https://127.0.0.1:3000/").hostname).toBe("127.0.0.1");
		expect(policy.assertNavigation("http://[::1]:4173/").hostname).toBe("[::1]");
		expect(() => policy.assertNavigation("https://example.com/")).toThrow("does not allow");
		expect(() => policy.assertNavigation("http://[::ffff:127.0.0.1]/")).toThrow("does not allow");
	});

	test("rejects unsafe protocols and disabled access", () => {
		expect(() => new BrowserPolicy("public-web").assertNavigation("file:///secret.txt")).toThrow("http and https");
		expect(() => new BrowserPolicy("disabled").assertNavigation("https://example.com/")).toThrow("disabled");
	});

	test("accepts loopback and private IP literals only for private-network access", () => {
		const policy = new BrowserPolicy("private-network");
		expect(policy.assertNavigation("http://127.0.0.1/").hostname).toBe("127.0.0.1");
		expect(policy.assertNavigation("http://192.168.1.20/").hostname).toBe("192.168.1.20");
		expect(policy.assertNavigation("http://169.254.169.254/").hostname).toBe("169.254.169.254");
		expect(policy.assertNavigation("http://[fd00::1]/").hostname).toBe("[fd00::1]");
		expect(policy.assertNavigation("http://[fe80::1]/").hostname).toBe("[fe80::1]");
		expect(() => policy.assertNavigation("https://example.com/")).toThrow("does not allow");
		expect(() => policy.assertNavigation("http://100.64.0.1/")).toThrow("does not allow");
		expect(() => policy.assertNavigation("http://192.0.2.1/")).toThrow("does not allow");
		expect(() => policy.assertNavigation("http://224.0.0.1/")).toThrow("does not allow");
	});

	test("rejects non-public IPv4 literals from public-web access", async () => {
		const policy = new BrowserPolicy("public-web");
		const addresses = [
			"0.0.0.0",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.169.254",
			"172.16.0.1",
			"192.0.0.1",
			"192.0.2.1",
			"192.31.196.1",
			"192.52.193.1",
			"192.88.99.1",
			"192.168.1.20",
			"192.175.48.1",
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.1",
			"240.0.0.1",
			"255.255.255.255",
		];
		for (const address of addresses) {
			await expect(policy.assertResolvedNavigation(`http://${address}/`)).rejects.toThrow("does not allow");
		}
		for (const nonCanonicalLoopback of ["2130706433", "0x7f000001", "0177.0.0.1"]) {
			await expect(policy.assertResolvedNavigation(`http://${nonCanonicalLoopback}/`)).rejects.toThrow(
				"does not allow",
			);
		}
	});

	test("rejects non-public and IPv4-mapped IPv6 literals from public-web access", async () => {
		const policy = new BrowserPolicy("public-web");
		const addresses = [
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:10.0.0.1",
			"::ffff:8.8.8.8",
			"0:0:0:0:0:ffff:808:808",
			"64:ff9b::808:808",
			"64:ff9b:1::1",
			"100::1",
			"100:0:0:1::1",
			"2001::1",
			"2001:db8::1",
			"2002::1",
			"2620:4f:8000::1",
			"3fff::1",
			"5f00::1",
			"fc00::1",
			"fe80::1",
			"fec0::1",
			"ff02::1",
		];
		for (const address of addresses) {
			await expect(policy.assertResolvedNavigation(`http://[${address}]/`)).rejects.toThrow("does not allow");
		}
	});

	test("accepts public IPv4 and IPv6 literals from public-web access", async () => {
		const policy = new BrowserPolicy("public-web");
		await expect(policy.assertResolvedNavigation("https://8.8.8.8/")).resolves.toHaveProperty("hostname", "8.8.8.8");
		await expect(policy.assertResolvedNavigation("https://[2606:4700:4700::1111]/")).resolves.toHaveProperty(
			"hostname",
			"[2606:4700:4700::1111]",
		);
	});

	test("selects access only for routable URL classes", () => {
		expect(browserAccessForUrl("http://localhost:4173/")).toBe("loopback");
		expect(browserAccessForUrl("http://127.0.0.2/")).toBe("loopback");
		expect(browserAccessForUrl("http://192.168.1.20/")).toBe("private-network");
		expect(browserAccessForUrl("http://[fd00::1]/")).toBe("private-network");
		expect(browserAccessForUrl("https://8.8.8.8/")).toBe("public-web");
		expect(browserAccessForUrl("https://example.com/")).toBe("public-web");
		expect(() => browserAccessForUrl("http://192.0.2.1/")).toThrow("special-use");
		expect(() => browserAccessForUrl("http://[::ffff:8.8.8.8]/")).toThrow("special-use");
	});
});
