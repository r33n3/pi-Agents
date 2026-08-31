import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEverydayDataTools } from "../src/core/serve/everyday-data-tools.ts";
import { fetchPublicText } from "../src/core/serve/public-web-fetch.ts";

vi.mock("../src/core/serve/public-web-fetch.ts", () => ({ fetchPublicText: vi.fn() }));
afterEach(() => vi.resetAllMocks());

function respond(text: string, contentType = "application/json") {
	vi.mocked(fetchPublicText).mockResolvedValueOnce({
		url: "https://example.com/source",
		contentType,
		text,
		fetchedAt: "2026-08-30T12:00:00Z",
	});
}

async function run(name: string, parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
	const tool = createEverydayDataTools("unused").find((candidate) => candidate.name === name)!;
	const result = await tool.execute("test", parameters, undefined, undefined, {} as ExtensionContext);
	const text = result.content.find((item) => item.type === "text");
	if (text?.type !== "text") throw new Error("Missing tool text");
	return JSON.parse(text.text) as Record<string, unknown>;
}

describe("everyday source tools", () => {
	// Locations and coordinates below are synthetic; all provider responses are mocked.
	test("requests GeoJSON for official alerts using explicit coordinates", async () => {
		respond('{"type":"FeatureCollection","features":[]}', "application/geo+json");
		const result = await run("weather_alerts", {
			location: "Exampletown, Region Two",
			latitude: 10.25,
			longitude: 20.5,
		});
		expect(fetchPublicText).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("point=10.25,20.5"), undefined, {
			accept: "application/geo+json",
		});
		expect(result.alerts).toEqual({ type: "FeatureCollection", features: [] });
		expect(result.location).toMatchObject({ name: "Exampletown, Region Two", latitude: 10.25 });
	});

	test("does not mistake XML or malformed JSON for a verified empty alert collection", async () => {
		respond("<feed/>", "application/atom+xml");
		await expect(run("weather_alerts", { location: "Exampletown", latitude: 10, longitude: 20 })).rejects.toThrow(
			"instead of JSON",
		);
		respond('{"features":[]}');
		await expect(run("weather_alerts", { location: "Exampletown", latitude: 10, longitude: 20 })).rejects.toThrow(
			"valid alert collection",
		);
		respond("{");
		await expect(run("weather_alerts", { location: "Exampletown", latitude: 10, longitude: 20 })).rejects.toThrow(
			"invalid JSON",
		);
	});

	test("rejects ambiguous places instead of selecting the first Exampletown", async () => {
		respond(
			JSON.stringify({
				results: [
					{
						name: "Exampletown",
						admin1: "Region One",
						country: "United States",
						country_code: "US",
						latitude: 30,
						longitude: 40,
					},
					{
						name: "Exampletown",
						admin1: "Region Two",
						country: "United States",
						country_code: "US",
						latitude: 10,
						longitude: 20,
					},
				],
			}),
		);
		await expect(run("weather_lookup", { location: "Exampletown" })).rejects.toThrow("Ambiguous");
		expect(fetchPublicText).toHaveBeenCalledOnce();
	});

	test("honors a state/country constraint", async () => {
		respond(
			JSON.stringify({
				results: [
					{ name: "Exampletown", admin1: "Region One", country_code: "US", latitude: 30, longitude: 40 },
					{ name: "Exampletown", admin1: "Region Two", country_code: "US", latitude: 10, longitude: 20 },
				],
			}),
		);
		respond('{"current":{"temperature_2m":80}}');
		const result = await run("weather_lookup", { location: "Exampletown", region: "Region Two", countryCode: "US" });
		expect(result.location).toMatchObject({ admin1: "Region Two", latitude: 10 });
		expect(vi.mocked(fetchPublicText).mock.calls[1]?.[0]).toContain("latitude=10&longitude=20");
	});

	test("requires both coordinates", async () => {
		await expect(run("weather_lookup", { location: "Exampletown", latitude: 10 })).rejects.toThrow("both valid");
		expect(fetchPublicText).not.toHaveBeenCalled();
	});

	test("distinguishes a valid empty RSS or Atom feed from a non-feed page", async () => {
		for (const xml of ["<rss><channel/></rss>", "<feed xmlns='http://www.w3.org/2005/Atom'/>"]) {
			respond(xml, "application/xml");
			await expect(run("feed_read", { url: "https://example.com/feed" })).resolves.toMatchObject({
				entries: [],
				status: "empty",
			});
		}
		respond("<html><body>Calendar</body></html>", "text/html");
		await expect(run("feed_read", { url: "https://example.com/calendar" })).rejects.toThrow("not an RSS/Atom");
	});

	test("rejects malformed XML and document entity declarations", async () => {
		respond("<rss><channel><item></channel>", "application/xml");
		await expect(run("feed_read", { url: "https://example.com/feed" })).rejects.toThrow("Malformed");
		respond('<!DOCTYPE rss [<!ENTITY x "unsafe">]><rss><channel/></rss>', "application/xml");
		await expect(run("feed_read", { url: "https://example.com/feed" })).rejects.toThrow("declarations");
	});

	test("decodes exactly one entity layer and supports Atom alternate links", async () => {
		respond(
			'<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>&amp;lt;Trail&amp;gt; &#x26; Trees</title><link rel="self" href="https://example.com/api"/><link rel="alternate" href="https://example.com/event?a=1&amp;b=2"/></entry></feed>',
			"application/atom+xml",
		);
		await expect(run("feed_read", { url: "https://example.com/feed" })).resolves.toMatchObject({
			entries: [{ title: "&lt;Trail&gt; & Trees", url: "https://example.com/event?a=1&b=2" }],
		});
	});

	test("retains source evidence from ordinary pages without script/style content", async () => {
		respond(
			"<html><style>secret-style</style><body><script>secret-script</script><h1>Exampletown &amp; Trails</h1><p>Open today</p></body></html>",
			"text/html; charset=utf-8",
		);
		await expect(run("page_read", { url: "https://example.com/source" })).resolves.toMatchObject({
			url: "https://example.com/source",
			fetchedAt: "2026-08-30T12:00:00Z",
			text: "Exampletown & Trails Open today",
			truncated: false,
		});
	});

	test("bounds malformed markup inside feed CDATA without regex backtracking", async () => {
		respond(
			`<rss><channel><item><title>Safe</title><description><![CDATA[${"<".repeat(100_000)}]]></description></item></channel></rss>`,
			"application/xml",
		);
		await expect(run("feed_read", { url: "https://example.com/feed" })).resolves.toMatchObject({
			entries: [{ title: "Safe" }],
		});
	});

	test("does not count an empty or unsupported page as evidence", async () => {
		respond("<html><script>renderApp()</script></html>", "text/html");
		await expect(run("page_read", { url: "https://example.com/" })).rejects.toThrow("no static text");
		respond("binary", "application/pdf");
		await expect(run("page_read", { url: "https://example.com/" })).rejects.toThrow("requires HTML");
	});
});
