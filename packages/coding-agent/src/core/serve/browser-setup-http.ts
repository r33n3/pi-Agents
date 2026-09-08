import type { IncomingMessage, ServerResponse } from "node:http";
import type { BrowserSessionManager } from "./browser-session-manager.ts";
import type { BrowserSetupStore } from "./browser-setup-store.ts";
import { matchesCapabilityToken } from "./capability-token.ts";

/** Small authenticated settings endpoint; uses the same store as team assignment. */
export function withBrowserSetup(
	next: (request: IncomingMessage, response: ServerResponse) => void,
	token: string,
	setup: BrowserSetupStore,
	manager: BrowserSessionManager,
	presentation: () => { sessionId: string; revision: number } | undefined,
) {
	return (request: IncomingMessage, response: ServerResponse): void => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/browser/setup" && url.pathname !== "/browser/presentation") {
			next(request, response);
			return;
		}
		const reply = (status: number, value: unknown) => {
			response
				.writeHead(status, {
					"content-type": "application/json",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				})
				.end(JSON.stringify(value));
		};
		if (!matchesCapabilityToken(token, url.searchParams.get("token"))) {
			reply(401, { error: "Unauthorized" });
			return;
		}
		if (request.method === "GET") {
			reply(200, url.pathname === "/browser/setup" ? setup.snapshot() : { presentation: presentation() });
			return;
		}
		if (request.method !== "POST" || url.pathname !== "/browser/setup") {
			reply(405, { error: "Method not allowed" });
			return;
		}
		void (async () => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				bytes += buffer.length;
				if (bytes > 128000) throw new Error("Browser setup request is too large");
				chunks.push(buffer);
			}
			// Conservatively serialize profile edits with active browser use.
			if (manager.list().some((entry) => entry.status !== "closed" && entry.profile.kind === "named"))
				throw new Error("Close named-profile browsers before editing browser setup");
			reply(200, await setup.save(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
		})().catch((error: unknown) =>
			reply(400, { error: error instanceof Error ? error.message : "Invalid browser setup" }),
		);
	};
}
