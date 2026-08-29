import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createCredentialApiTools } from "../src/core/serve/credential-api-tools.ts";

describe("createCredentialApiTools", () => {
	let server: Server;
	let origin: string;
	let requestBody: string;

	beforeEach(async () => {
		requestBody = "";
		server = createServer((request, response) => {
			request.on("data", (chunk: Buffer) => {
				requestBody += chunk.toString("utf8");
			});
			request.on("end", () => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ success: true, path: request.url }));
			});
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

	test("resolves a self-hosted Firecrawl connection for each call", async () => {
		const values = new Map<string, string>([["FIRECRAWL_BASE_URL", origin]]);
		const tool = createCredentialApiTools((name) => values.get(name)).find(
			(candidate) => candidate.name === "firecrawl_search",
		);
		if (!tool) throw new Error("Expected Firecrawl search tool");
		const result = await tool.execute(
			"call-1",
			{ query: "vault backed tools", limit: 3 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(JSON.parse(requestBody)).toEqual({ query: "vault backed tools", limit: 3, sources: ["web"] });
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining('"success": true') });
	});

	test("fails closed when a service credential is absent", async () => {
		const tool = createCredentialApiTools(() => undefined).find(
			(candidate) => candidate.name === "currents_search_news",
		);
		if (!tool) throw new Error("Expected Currents tool");
		await expect(
			tool.execute("call-2", { query: "security" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("Currents is not configured in Settings > Connections");
	});
});
