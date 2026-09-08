import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createSearxngTools } from "../src/core/serve/searxng-tools.ts";

describe("createSearxngTools", () => {
	let server: Server;
	let origin: string;
	let requestedUrl: URL | undefined;
	let count: number;
	let payload: unknown;

	beforeEach(async () => {
		count = 0;
		payload = {
			results: [
				{ title: "First", url: "https://example.com/first", content: "Summary", engine: "fixture" },
				{ title: "Second", url: "https://example.com/second" },
			],
		};
		server = createServer((request, response) => {
			count++;
			requestedUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(payload));
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
	test("parallel agents reuse one search and preserve per-caller result limits", async () => {
		const tool = createSearxngTools(origin)[0]!;
		const results = await Promise.all(
			[1, 2, 1].map((maxResults) =>
				tool.execute("test", { query: "same trip", maxResults }, undefined, undefined, {} as ExtensionContext),
			),
		);
		expect(count).toBe(1);
		expect(JSON.stringify(results[0])).not.toContain("Second");
		expect(JSON.stringify(results[1])).toContain("Second");
		expect(JSON.stringify(results[1])).toContain("cached");
	});
	test("blocked engines produce actionable errors and pause different queries", async () => {
		payload = {
			results: [],
			unresponsive_engines: [
				["brave", "too many requests"],
				["startpage", "CAPTCHA"],
			],
		};
		const tool = createSearxngTools(origin)[0]!;
		await expect(
			tool.execute("test", { query: "one" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("startpage: CAPTCHA");
		await expect(
			tool.execute("test", { query: "two" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("temporarily unavailable");
		expect(count).toBe(1);
	});
	test("partial results retain engine failures, while genuine empty results remain successful", async () => {
		payload = {
			results: [{ title: "Available", url: "https://example.com" }],
			unresponsive_engines: [["brave", "CAPTCHA"]],
		};
		const result = await createSearxngTools(origin)[0]!.execute(
			"test",
			{ query: "one" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(JSON.stringify(result)).toContain("partial");
		expect(JSON.stringify(result)).toContain("CAPTCHA");
		payload = { results: [] };
		const empty = await createSearxngTools(origin)[0]!.execute(
			"test",
			{ query: "two" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(JSON.stringify(empty)).toContain("empty");
	});
	test("malformed responses do not become empty research", async () => {
		payload = {};
		await expect(
			createSearxngTools(origin)[0]!.execute("test", { query: "one" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("missing results array");
	});
	test("distinct searches are paced and cancelled queued calls do not reach the provider", async () => {
		const tool = createSearxngTools(origin)[0]!;
		const started = Date.now();
		await tool.execute("first", { query: "first" }, undefined, undefined, {} as ExtensionContext);
		const controller = new AbortController();
		controller.abort();
		await expect(
			tool.execute("cancelled", { query: "cancelled" }, controller.signal, undefined, {} as ExtensionContext),
		).rejects.toThrow();
		await tool.execute("second", { query: "second" }, undefined, undefined, {} as ExtensionContext);
		expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
		expect(count).toBe(2);
	});
});
