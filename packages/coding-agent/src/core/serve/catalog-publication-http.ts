import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRoomService } from "./agent-room-service.ts";
import { matchesCapabilityToken } from "./capability-token.ts";
import { prepareCatalogPackage } from "./catalog-package.ts";

/** Preparation only until a destination implements native-package admission and publication receipts. */
export function withCatalogPublication(
	next: (request: IncomingMessage, response: ServerResponse) => void,
	token: string,
	agents: Pick<AgentRegistry, "list" | "get">,
	teams: Pick<AgentRoomService, "listDefinitions" | "getDefinition" | "listTools">,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/catalog-publication") return next(request, response);
		const send = (status: number, value: unknown) =>
			response
				.writeHead(status, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
					"x-content-type-options": "nosniff",
				})
				.end(JSON.stringify(value));
		if (!matchesCapabilityToken(token, url.searchParams.get("token"))) {
			send(401, { error: "Unauthorized" });
			return;
		}
		if (request.method !== "GET") {
			send(405, { error: "Catalog publication is not connected. You can review and download a package." });
			return;
		}
		void (async () => {
			const kind = url.searchParams.get("kind");
			const id = url.searchParams.get("id");
			if (!id) {
				send(200, {
					sources: [
						...(await agents.list()).map((agent) => ({ kind: "agent", id: agent.id, name: agent.name })),
						...teams.listDefinitions().map((team) => ({ kind: "team", id: team.id, name: team.name })),
					],
				});
				return;
			}
			if (kind !== "agent" && kind !== "team") {
				send(400, { error: "Choose an agent or team" });
				return;
			}
			const team = kind === "team" ? teams.getDefinition(id) : undefined;
			const selected = kind === "agent" ? await agents.get(id) : undefined;
			if (!team && !selected) {
				send(404, { error: "Saved agent or team was not found" });
				return;
			}
			const review = prepareCatalogPackage(
				selected ? [selected] : await agents.list(),
				team,
				teams.listTools(),
				url.searchParams.get("version") ?? "1.0.0",
			);
			send(200, review);
		})().catch((error: unknown) =>
			send(400, { error: error instanceof Error ? error.message : "Could not prepare package" }),
		);
	};
}
