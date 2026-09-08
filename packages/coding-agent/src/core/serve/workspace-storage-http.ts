import { readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { matchesCapabilityToken } from "./capability-token.ts";

/** Directory names only: never serves credential, conversation, or executable file contents. */
export function withWorkspaceStorage(
	next: (request: IncomingMessage, response: ServerResponse) => void,
	token: string,
	workspace: string,
	settings: string,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/workspace-storage") return next(request, response);
		const headers = {
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			"content-security-policy":
				"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
		};
		if (!matchesCapabilityToken(token, url.searchParams.get("token"))) {
			response.writeHead(401, headers).end("Unauthorized");
			return;
		}
		if (request.method !== "GET") {
			response.writeHead(405, { ...headers, allow: "GET" }).end("Method not allowed");
			return;
		}
		if (url.searchParams.get("format") === "json") {
			response
				.writeHead(200, { ...headers, "content-type": "application/json" })
				.end(JSON.stringify({ workspace: resolve(workspace), settings: resolve(settings) }));
			return;
		}
		void (async () => {
			const root = await realpath(workspace);
			const folder = await realpath(resolve(root, url.searchParams.get("path") ?? "."));
			const subpath = relative(root, folder);
			if (isAbsolute(subpath) || subpath === ".." || subpath.startsWith(`..${sep}`)) {
				response.writeHead(403, headers).end("Folder is outside this workspace");
				return;
			}
			const entries = await readdir(folder, { withFileTypes: true });
			const link = (path: string, label: string) => {
				const query = new URLSearchParams({ token, path });
				return `<a href="/workspace-storage?${escapeHtml(query.toString())}">${escapeHtml(label)}</a>`;
			};
			const rows = entries
				.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
				.map(
					(entry) =>
						`<li>${entry.isDirectory() ? link(relative(root, resolve(folder, entry.name)), `${entry.name}/`) : escapeHtml(entry.name)}${entry.isSymbolicLink() ? " (link; not browsable)" : ""}</li>`,
				)
				.join("");
			response
				.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" })
				.end(
					`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workspace storage</title><style>body{background:#111114;color:#eee;font:15px system-ui;margin:24px;line-height:1.6}h1,a{color:#55c7ad}p{overflow-wrap:anywhere}ul{padding:0;list-style:none}li{padding:8px;border-bottom:1px solid #303036}small{color:#aaa}</style><h1>π Workspace storage</h1><p>${escapeHtml(folder)}</p><small>Read-only folder view on the Pi host. Files are listed, not opened or downloaded.</small><p>Agents, teams, memory, and history are stored in this workspace. Individual agents may use other working folders.</p><p>Settings and encrypted vault location: ${escapeHtml(resolve(settings))}</p>${subpath ? link(relative(root, resolve(folder, "..")), "Parent folder") : ""}<ul>${rows || "<li>This folder is empty.</li>"}</ul></html>`,
				);
		})().catch(() => response.writeHead(404, headers).end("Folder is unavailable"));
	};
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
	);
}
