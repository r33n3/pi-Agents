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
	test("requests GeoJSON for official alerts using explicit coordinates", async () => {
		respond('{"type":"FeatureCollection","features":[]}', "application/geo+json");
		const result = await run("weather_alerts", {
			location: "Ozark, Missouri",
			latitude: 37.0209,
			longitude: -93.206,
		});
		expect(fetchPublicText).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("point=37.0209,-93.206"),
			undefined,
			{ accept: "application/geo+json" },
		);
		expect(result.alerts).toEqual({ type: "FeatureCollection", features: [] });
		expect(result.location).toMatchObject({ name: "Ozark, Missouri", latitude: 37.0209 });
	});

	test("does not mistake XML or malformed JSON for a verified empty alert collection", async () => {
		respond("<feed/>", "application/atom+xml");
		await expect(run("weather_alerts", { location: "Ozark", latitude: 37, longitude: -93 })).rejects.toThrow(
			"instead of JSON",
		);
		respond('{"features":[]}');
		await expect(run("weather_alerts", { location: "Ozark", latitude: 37, longitude: -93 })).rejects.toThrow(
			"valid alert collection",
		);
		respond("{");
		await expect(run("weather_alerts", { location: "Ozark", latitude: 37, longitude: -93 })).rejects.toThrow(
			"invalid JSON",
		);
	});

	test("rejects ambiguous places instead of selecting the first Ozark", async () => {
		respond(
			JSON.stringify({
				results: [
					{
						name: "Ozark",
						admin1: "Arkansas",
						country: "United States",
						country_code: "US",
						latitude: 35.49,
						longitude: -93.83,
					},
					{
						name: "Ozark",
						admin1: "Missouri",
						country: "United States",
						country_code: "US",
						latitude: 37.02,
						longitude: -93.2,
					},
				],
			}),
		);
		await expect(run("weather_lookup", { location: "Ozark" })).rejects.toThrow("Ambiguous");
		expect(fetchPublicText).toHaveBeenCalledOnce();
	});

	test("honors a state/country constraint", async () => {
		respond(
			JSON.stringify({
				results: [
					{ name: "Ozark", admin1: "Arkansas", country_code: "US", latitude: 35.49, longitude: -93.83 },
					{ name: "Ozark", admin1: "Missouri", country_code: "US", latitude: 37.02, longitude: -93.2 },
				],
			}),
		);
		respond('{"current":{"temperature_2m":80}}');
		const result = await run("weather_lookup", { location: "Ozark", region: "Missouri", countryCode: "US" });
		expect(result.location).toMatchObject({ admin1: "Missouri", latitude: 37.02 });
		expect(vi.mocked(fetchPublicText).mock.calls[1]?.[0]).toContain("latitude=37.02&longitude=-93.2");
	});

	test("requires both coordinates", async () => {
		await expect(run("weather_lookup", { location: "Ozark", latitude: 37 })).rejects.toThrow("both valid");
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
			"<html><style>secret-style</style><body><script>secret-script</script><h1>Ozark &amp; Trails</h1><p>Open today</p></body></html>",
			"text/html; charset=utf-8",
		);
		await expect(run("page_read", { url: "https://example.com/source" })).resolves.toMatchObject({
			url: "https://example.com/source",
			fetchedAt: "2026-08-30T12:00:00Z",
			text: "Ozark & Trails Open today",
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
