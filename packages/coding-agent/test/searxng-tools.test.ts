import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createSearxngTools } from "../src/core/serve/searxng-tools.ts";

describe("createSearxngTools", () => {
	let server: Server;
	let origin: string;
	let requestedUrl: URL | undefined;

	beforeEach(async () => {
		server = createServer((request, response) => {
			requestedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					results: [
						{ title: "First", url: "https://example.com/first", content: "Summary", engine: "fixture" },
						{ title: "Second", url: "https://example.com/second" },
					],
				}),
			);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected an IP listener");
		origin = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});

	test("is absent until a SearXNG endpoint is configured", () => {
		expect(createSearxngTools(undefined)).toEqual([]);
		expect(createSearxngTools(" ")).toEqual([]);
	});

	test("queries the configured endpoint and returns bounded normalized results", async () => {
		const tool = createSearxngTools(`${origin}/instance/`)[0];
		if (!tool) throw new Error("Expected the SearXNG search tool");
		const result = await tool.execute(
			"search-1",
			{ query: "pi agents", categories: ["general"], language: "en", maxResults: 1 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(requestedUrl?.pathname).toBe("/instance/search");
		expect(requestedUrl?.searchParams.get("q")).toBe("pi agents");
		expect(requestedUrl?.searchParams.get("format")).toBe("json");
		expect(result.content).toEqual([
			{
				type: "text",
				text: expect.stringContaining('"title": "First"'),
			},
		]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected a text search result");
		expect(content.text).not.toContain('"title": "Second"');
	});

	test("rejects credentials embedded in the provider URL", () => {
		expect(() => createSearxngTools("https://user:secret@example.com")).toThrow("must not contain credentials");
	});
});
