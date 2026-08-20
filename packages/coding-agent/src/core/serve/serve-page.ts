import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentDefinitionInput, AgentRegistry } from "./agent-registry.ts";
import type { AgentRoutineScheduler } from "./agent-routine-scheduler.ts";
import type { AgentRunManager } from "./agent-run-manager.ts";
import { SERVE_BROWSER_BUNDLE } from "./browser-bundle.generated.ts";
import { matchesCapabilityToken } from "./capability-token.ts";
import type { ExternalConnectionManager } from "./external-connection-manager.ts";

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"content-security-policy":
		"default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
} as const;

/** Serves the local console only to callers holding this process's capability token. */
export function createServePage(
	token: string,
	agentRegistry?: AgentRegistry,
	agentRunManager?: AgentRunManager,
	agentRoutineScheduler?: AgentRoutineScheduler,
	externalConnectionManager?: ExternalConnectionManager,
): (request: IncomingMessage, response: ServerResponse) => void {
	return (request, response) => {
		void serveRequest(
			request,
			response,
			token,
			agentRegistry,
			agentRunManager,
			agentRoutineScheduler,
			externalConnectionManager,
		).catch((error: unknown) => {
			if (response.headersSent) {
				response.end();
				return;
			}
			json(response, 500, { error: error instanceof Error ? error.message : "Internal server error" });
		});
	};
}

async function serveRequest(
	request: IncomingMessage,
	response: ServerResponse,
	token: string,
	agentRegistry: AgentRegistry | undefined,
	agentRunManager: AgentRunManager | undefined,
	agentRoutineScheduler: AgentRoutineScheduler | undefined,
	externalConnectionManager: ExternalConnectionManager | undefined,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (!matchesCapabilityToken(token, url.searchParams.get("token"))) {
		response.writeHead(403, SECURITY_HEADERS).end();
		return;
	}
	if (url.pathname === "/agents.json" || url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
		await serveAgents(request, response, url, agentRegistry, agentRoutineScheduler);
		return;
	}
	if (url.pathname === "/runs.json" || url.pathname === "/runs" || url.pathname.startsWith("/runs/")) {
		await serveRuns(request, response, url, agentRunManager);
		return;
	}
	if (url.pathname === "/routines.json") {
		if (!agentRoutineScheduler) json(response, 503, { error: "Agent routine scheduler is unavailable" });
		else if (request.method === "GET") json(response, 200, { routines: agentRoutineScheduler.list() });
		else response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (url.pathname === "/external-connections.json") {
		if (!externalConnectionManager) json(response, 503, { error: "External connections are unavailable" });
		else if (request.method === "GET") {
			json(response, 200, { connections: externalConnectionManager.listConnections() });
		} else response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (
		url.pathname === "/external-runs.json" ||
		url.pathname === "/external-runs" ||
		url.pathname.startsWith("/external-runs/")
	) {
		await serveExternalRuns(request, response, url, externalConnectionManager);
		return;
	}
	if (request.method !== "GET") {
		response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET" }).end();
		return;
	}
	if (url.pathname === "/browser-client.js") {
		response
			.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8" })
			.end(SERVE_BROWSER_BUNDLE);
		return;
	}
	if (url.pathname !== "/" && url.pathname !== "/index.html") {
		response.writeHead(404, SECURITY_HEADERS).end();
		return;
	}
	response
		.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" })
		.end(renderPage(encodeURIComponent(token)));
}

async function serveExternalRuns(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	manager: ExternalConnectionManager | undefined,
): Promise<void> {
	if (!manager) {
		json(response, 503, { error: "External connections are unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/external-runs.json" || url.pathname === "/external-runs"
			? ""
			: decodeURIComponent(url.pathname.slice("/external-runs/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { runs: manager.listRuns() });
		return;
	}
	if (request.method === "GET" && suffix.endsWith("/result")) {
		const result = await manager.readResult(suffix.slice(0, -"/result".length));
		if (result === undefined) response.writeHead(404, SECURITY_HEADERS).end();
		else response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8" }).end(result);
		return;
	}
	if (request.method === "GET" && suffix !== "") {
		const run = manager.getRun(suffix);
		json(response, run ? 200 : 404, run ?? { error: "External run not found" });
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const body = object(await readJsonBody(request), "external run request");
			const model = body.model === undefined ? undefined : object(body.model, "model");
			json(
				response,
				202,
				await manager.start({
					connectionId: requiredString(body.connectionId, "connectionId"),
					prompt: requiredString(body.prompt, "prompt"),
					cwd: optionalString(body.cwd, "cwd"),
					model: model
						? {
								provider: requiredString(model.provider, "model.provider"),
								id: requiredString(model.id, "model.id"),
							}
						: undefined,
				}),
			);
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : "Invalid external run request" });
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/abort")) {
		try {
			json(response, 200, await manager.abort(suffix.slice(0, -"/abort".length)));
		} catch (error) {
			json(response, 409, { error: error instanceof Error ? error.message : "Could not abort external run" });
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveRuns(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	runManager: AgentRunManager | undefined,
): Promise<void> {
	if (!runManager) {
		json(response, 503, { error: "Agent run manager is unavailable" });
		return;
	}
	const suffix =
		url.pathname === "/runs.json" || url.pathname === "/runs"
			? ""
			: decodeURIComponent(url.pathname.slice("/runs/".length));
	if (request.method === "GET" && suffix === "") {
		json(response, 200, { runs: runManager.list() });
		return;
	}
	if (request.method === "GET" && suffix.endsWith("/result")) {
		const result = await runManager.readResult(suffix.slice(0, -"/result".length));
		if (result === undefined) response.writeHead(404, SECURITY_HEADERS).end();
		else response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/markdown; charset=utf-8" }).end(result);
		return;
	}
	if (request.method === "GET" && suffix !== "") {
		const run = runManager.get(suffix);
		json(response, run ? 200 : 404, run ?? { error: "Run not found" });
		return;
	}
	if (request.method === "POST" && suffix === "") {
		try {
			const body = object(await readJsonBody(request), "run request");
			json(
				response,
				202,
				await runManager.start(requiredString(body.agentId, "agentId"), requiredString(body.prompt, "prompt")),
			);
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : "Invalid run request" });
		}
		return;
	}
	if (request.method === "POST" && suffix.endsWith("/abort")) {
		try {
			json(response, 200, await runManager.abort(suffix.slice(0, -"/abort".length)));
		} catch (error) {
			json(response, 409, { error: error instanceof Error ? error.message : "Could not abort run" });
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, POST" }).end();
}

async function serveAgents(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	agentRegistry: AgentRegistry | undefined,
	agentRoutineScheduler: AgentRoutineScheduler | undefined,
): Promise<void> {
	if (!agentRegistry) {
		json(response, 503, { error: "Agent registry is unavailable" });
		return;
	}
	const id =
		url.pathname === "/agents.json" || url.pathname === "/agents"
			? undefined
			: decodeURIComponent(url.pathname.slice("/agents/".length));
	if (request.method === "GET" && id?.endsWith("/icon")) {
		const icon = await agentRegistry.readIcon(id.slice(0, -"/icon".length));
		if (!icon) response.writeHead(404, SECURITY_HEADERS).end();
		else response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "image/webp" }).end(icon);
		return;
	}
	if (request.method === "GET") {
		if (!id) {
			json(response, 200, { agents: await agentRegistry.list() });
			return;
		}
		const definition = await agentRegistry.get(id);
		json(response, definition ? 200 : 404, definition ?? { error: "Agent not found" });
		return;
	}
	if ((request.method === "POST" && !id) || (request.method === "PUT" && id)) {
		try {
			const input = (await readJsonBody(request)) as AgentDefinitionInput;
			if (id && input.id !== undefined && input.id !== id)
				throw new Error("Agent id does not match the request path");
			const saved = await agentRegistry.save({ ...input, id: id ?? input.id });
			await agentRoutineScheduler?.refresh();
			json(response, request.method === "POST" ? 201 : 200, saved);
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : "Invalid agent definition" });
		}
		return;
	}
	response.writeHead(405, { ...SECURITY_HEADERS, allow: id ? "GET, PUT" : "GET, POST" }).end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	let length = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > 64 * 1024) throw new Error("Request body exceeds 64 KiB");
		chunks.push(buffer);
	}
	if (length === 0) throw new Error("Request body is required");
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response
		.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" })
		.end(`${JSON.stringify(value)}\n`);
}

function object(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, name);
}

function renderPage(token: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>π Agents</title>
<style>
:root{color-scheme:dark;--bg:#09090a;--panel:#101012;--surface:#1a1a1e;--surface2:#24242a;--line:#2d2d33;--text:#f2f2f3;--muted:#92929b;--pi:#7eb5f5;--danger:#ef4444;--rail-width:256px;--details-width:360px}*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,ui-sans-serif,system-ui,sans-serif;display:grid;grid-template-columns:var(--rail-width) 5px minmax(420px,1fr) 5px var(--details-width)}button,textarea,select,input{font:inherit}button{cursor:pointer}.hidden{display:none!important}.muted{color:var(--muted)}.rail,.details{position:relative;min-width:0;min-height:0;background:var(--panel);overflow:hidden}.rail{display:flex;flex-direction:column;padding:14px}.details{display:flex;flex-direction:column;padding:14px}.pi-watermark{position:absolute;z-index:0;left:-24px;bottom:-58px;color:var(--pi);font:italic 900 260px/1 "Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif;letter-spacing:-.18em;opacity:.045;transform:rotate(-11deg) scaleX(.86);user-select:none;pointer-events:none;filter:blur(.2px)}.rail-tabs,.tabs,.builder-tabs{position:relative;z-index:1;display:flex;gap:4px;border-bottom:1px solid var(--line)}.rail-tabs{margin-bottom:12px}.rail-tabs button,.tabs button,.builder-tabs button{flex:1;background:transparent;border:0;color:var(--muted);padding:10px 7px}.rail-tabs button.active,.tabs button.active,.builder-tabs button.active{color:var(--text);border-bottom:2px solid var(--pi)}.rail-panel,.details [data-panel],.builder-panel{position:relative;z-index:1;min-height:0;overflow:auto;scrollbar-gutter:stable}.rail-panel{flex:1}.section-title{margin:18px 8px 8px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.12em}.nav-item,.card{background:color-mix(in srgb,var(--surface) 92%,transparent);border:1px solid transparent;border-radius:11px;padding:12px;margin-top:8px}.nav-item{display:block;width:100%;color:var(--text);text-align:left}.nav-item:hover{background:var(--surface2)}.nav-item.active{background:var(--surface2);border-color:#3b3b44}.nav-item:disabled{opacity:.45;cursor:not-allowed}.session-entry strong,.session-entry span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-entry span{margin-top:4px;font-size:11px}.connection-group{margin:14px 0}.connection-heading{display:flex;align-items:center;gap:7px;padding:0 7px;color:var(--muted);font-size:11px}.connection-heading i{width:7px;height:7px;border-radius:50%;background:#43c58a}.connection-heading button{margin-left:auto;background:transparent;border:0;color:var(--muted);font-size:17px}.new-agent{color:var(--pi)}#connection-form{display:grid;gap:8px;margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:11px;background:rgba(15,15,17,.75)}#connection-form label{font-size:11px;color:var(--muted)}#connection-url{width:100%;margin-top:5px;background:var(--bg);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}#connection-form button,.secondary-action{border:1px solid var(--line);border-radius:8px;background:var(--surface2);color:var(--text);padding:9px}.resizer{position:relative;z-index:20;background:var(--line);cursor:col-resize;touch-action:none}.resizer:hover,.resizer.dragging{background:var(--pi)}main{display:flex;flex-direction:column;min-width:0;min-height:0;background:radial-gradient(circle at 50% 18%,rgba(126,181,245,.035),transparent 38%)}.header{min-height:59px;display:flex;align-items:center;gap:10px;padding:0 16px;border-bottom:1px solid var(--line)}.session-tabs{display:flex;gap:5px;min-width:0;overflow-x:auto;scrollbar-width:none}.session-tabs::-webkit-scrollbar{display:none}.session-tab{max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;color:var(--muted);border:1px solid transparent;border-radius:8px;padding:8px 11px}.session-tab.active{background:var(--surface);border-color:var(--line);color:var(--text)}#status{margin-left:auto;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px}#status.error{color:var(--danger)}#transcript{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:30px max(28px,calc((100% - 860px)/2));scrollbar-gutter:stable}.message{white-space:pre-wrap;line-height:1.65;margin:0 0 20px;padding:0;max-width:820px}.message.assistant{margin-right:auto}.message.user{width:fit-content;max-width:min(76%,720px);margin-left:auto;background:#202d3d;border:1px solid #2e4057;border-radius:18px 18px 5px 18px;padding:12px 16px}.message.tool{border:1px solid var(--line);border-radius:10px;background:rgba(20,20,23,.7);color:var(--muted);font-size:12px;padding:11px 13px}.message-label{text-transform:uppercase;letter-spacing:.1em;color:var(--pi);font-size:9px;font-weight:700;margin-bottom:7px}.message.user .message-label{display:none}.thinking{color:var(--muted);font-style:italic;border-left:2px solid var(--line);padding-left:11px}.tool-call{color:#c4a7e7}.chat-dock{padding:8px max(18px,calc((100% - 900px)/2)) 18px;background:linear-gradient(transparent,var(--bg) 18%)}.controls{display:flex;align-items:center;gap:9px;padding:4px 8px 8px;color:var(--muted);font-size:11px}.controls label{display:flex;align-items:center;gap:5px}.controls select{max-width:210px;background:transparent;color:var(--muted);border:0;padding:4px}.controls #phase{margin-left:auto;text-transform:capitalize}#composer{display:flex;align-items:flex-end;gap:8px;padding:8px;background:var(--surface);border:1px solid #3a3a42;border-radius:19px;box-shadow:0 14px 40px rgba(0,0,0,.32)}#prompt{flex:1;resize:none;min-height:44px;max-height:180px;background:transparent;color:var(--text);border:0;outline:0;padding:11px 9px;line-height:1.5;overflow-y:auto}#composer-action{flex:0 0 42px;width:42px;height:42px;display:grid;place-items:center;border:0;border-radius:50%;background:var(--text);color:var(--bg);transition:background .16s,transform .16s}#composer-action:hover{transform:scale(1.04)}#composer-action svg{width:19px;height:19px;fill:none;stroke:currentColor;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round}#composer-action .stop-icon{display:none;width:13px;height:13px;border-radius:2px;background:white}#composer-action.is-stopping{background:var(--danger);color:white}#composer-action.is-stopping .send-icon{display:none}#composer-action.is-stopping .stop-icon{display:block}#composer-action:disabled{opacity:.35;cursor:default;transform:none}.tabs{flex:0 0 auto;margin-bottom:14px}.details [data-panel]{flex:1}.card strong{display:block;margin-bottom:6px}.builder-tabs{margin:4px 0 12px}.builder-panel{max-height:calc(100vh - 120px)}#agent-form,#run-form,#external-run-form{display:grid;gap:10px}#agent-form label,#run-form label,#external-run-form label{display:grid;gap:5px;color:var(--muted);font-size:11px}#agent-form input,#agent-form textarea,#agent-form select,#run-form textarea,#run-form select,#builder-prompt,#external-run-form input,#external-run-form textarea,#external-run-form select{width:100%;background:#131316;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px}#agent-form button,#run-form button,#builder-chat-form button,#external-run-form button{background:var(--pi);color:#07101b;border:0;border-radius:8px;padding:10px;font-weight:700}.external-warning{color:#e4ba68;font-size:11px;line-height:1.45}.external-result{white-space:pre-wrap;max-height:260px;overflow:auto;margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#131316}.result-actions{display:flex;gap:7px}.result-actions button{flex:1;border:1px solid var(--line);border-radius:7px;background:var(--surface2);color:var(--text);padding:7px}.result-actions button.abort{color:var(--danger);border-color:var(--danger)}#builder-chat{height:calc(100vh - 310px);min-height:220px;overflow:auto;overscroll-behavior:contain;padding:4px;scrollbar-gutter:stable}#builder-chat .message{max-width:100%;margin-bottom:13px;font-size:12px}#builder-chat .message.user{padding:9px 11px}#builder-chat-form{display:grid;gap:8px;margin-top:10px}.run-card button{margin-top:8px;background:transparent;color:var(--danger);border:1px solid var(--danger);border-radius:6px;padding:5px}.run-error{color:var(--danger)}@media(max-width:1050px){:root{--rail-width:210px;--details-width:310px}}@media(max-width:820px){body{grid-template-columns:190px 4px minmax(0,1fr)}.details,.right-resizer{display:none}.left-resizer{display:block}}@media(max-width:620px){body{display:block}.rail,.resizer{display:none}main{height:100dvh}#transcript{padding:20px 16px}.header{padding:0 9px}.chat-dock{padding:6px 10px 12px}.controls{overflow-x:auto}}
#agent-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.agent-entry{display:flex;min-width:0;flex-direction:column;align-items:center;gap:7px;margin-top:0;padding:7px;text-align:center}.agent-icon{display:grid;width:100%;aspect-ratio:1;place-items:center;object-fit:cover;border-radius:8px;background:var(--surface2);color:var(--pi);font:700 34px/1 Georgia,serif}.agent-name{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.session-row{display:flex;align-items:center;gap:6px;padding:4px}.session-row:hover{background:var(--surface2)}.session-select{min-width:0;flex:1;background:transparent;border:0;color:var(--text);text-align:left;padding:8px}.session-select.active{color:var(--pi)}.session-rename{background:transparent;border:0;color:var(--muted);font-size:10px;padding:7px 4px}.session-rename:hover{color:var(--text)}
.external-connection-entry strong,.external-connection-entry span{display:block;overflow:hidden;text-overflow:ellipsis}.external-connection-entry span{margin-top:4px;font-size:11px}
</style></head><body>
<aside class="rail"><div class="pi-watermark" aria-hidden="true">π</div><nav class="rail-tabs" aria-label="Workspace"><button class="active" data-rail-tab="sessions">Sessions</button><button data-rail-tab="agents">Agents</button></nav><section id="sessions" class="rail-panel" data-rail-panel><button id="show-connection-form" class="secondary-action" type="button">+ Connect another Pi</button><form id="connection-form" class="hidden"><label>Pi control URL<input id="connection-url" type="url" placeholder="http://127.0.0.1:4173/?token=…" required></label><button type="submit">Connect</button></form><div id="connection-list"></div></section><section id="agents" class="rail-panel hidden" data-rail-panel><div class="section-title">Agents</div><div id="agent-list"></div><button id="new-agent" class="nav-item new-agent">+ New Agent</button><div class="section-title">External connections</div><div id="external-connection-list"></div></section></aside>
<div id="left-resizer" class="resizer left-resizer" role="separator" aria-label="Resize navigation" aria-orientation="vertical" tabindex="0"></div>
<main><header class="header"><div id="session-tabs" class="session-tabs" role="tablist" aria-label="Open Pi sessions"></div><span id="status">Connecting…</span></header><section id="transcript" aria-live="polite"></section><div class="chat-dock"><div class="controls"><label>Model <select id="model"></select></label><label>Thinking <select id="thinking"><option>off</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select></label><span id="phase">idle</span></div><form id="composer"><textarea id="prompt" aria-label="Message Pi" placeholder="Message Pi…" rows="1"></textarea><button id="composer-action" type="submit" aria-label="Send message"><svg class="send-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg><span class="stop-icon" aria-hidden="true"></span></button></form></div></main>
<div id="right-resizer" class="resizer right-resizer" role="separator" aria-label="Resize details" aria-orientation="vertical" tabindex="0"></div>
<aside class="details"><nav class="tabs"><button class="active" data-tab="overview">Overview</button><button data-tab="activity">Activity</button><button data-tab="routines">Routines</button><button data-tab="configure">Builder</button><button class="hidden" data-tab="external">External</button></nav><section id="overview" data-panel><div class="card"><strong>Connected session</strong><span class="muted">Choose any available Pi session from the chat tabs or connect another local Pi from Sessions.</span></div></section><section id="activity" data-panel class="hidden"><div class="card"><strong>Run an agent</strong><form id="run-form"><label>Agent<select id="run-agent"></select></label><label>Task<textarea id="run-prompt" required></textarea></label><button type="submit">Start isolated run</button></form></div><div id="run-list"></div></section><section id="routines" data-panel class="hidden"><div id="routine-list"></div></section><section id="configure" data-panel class="hidden"><div class="card"><strong id="builder-title">Build a new agent</strong><nav class="builder-tabs"><button class="active" type="button" data-builder-tab="builder-chat-panel">Chat</button><button type="button" data-builder-tab="builder-settings-panel">Settings</button></nav><section id="builder-chat-panel" class="builder-panel" data-builder-panel><div id="builder-chat"></div><form id="builder-chat-form"><textarea id="builder-prompt" placeholder="Describe the agent you want to build"></textarea><button type="submit">Ask builder</button></form></section><section id="builder-settings-panel" class="builder-panel hidden" data-builder-panel><form id="agent-form"><input id="agent-id" type="hidden"><label>Name<input id="agent-name" required></label><label>Description<textarea id="agent-description" required></textarea></label><label>Persona<textarea id="agent-persona" required></textarea></label><label>Model<select id="agent-model"></select></label><label>Tools<input id="agent-tools" placeholder="read, list, write"></label><label>Memory<select id="agent-memory"><option value="none">None</option><option value="notes">Notes</option></select></label><label>Executor<select id="agent-executor"><option value="harness">Isolated harness</option><option value="session">Pi session</option></select></label><label>Permissions<select id="agent-permissions"><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option></select></label><div class="section-title">Optional routine</div><label>Routine id<input id="routine-id" value="routine"></label><label>Every minutes<input id="routine-interval" type="number" min="1" value="60"></label><label>Routine task<textarea id="routine-prompt"></textarea></label><label><input id="routine-enabled" type="checkbox"> Enabled</label><button type="submit">Save agent</button></form></section></div></section><section id="external" data-panel class="hidden"><div class="card"><strong id="external-title">External connection</strong><p id="external-description" class="muted"></p><p id="external-warning" class="external-warning"></p><form id="external-run-form"><input id="external-id" type="hidden"><label id="external-prompt-label">Task<textarea id="external-prompt" required></textarea></label><label>Working directory<input id="external-cwd" required></label><label>Model<select id="external-model"></select></label><button type="submit">Delegate</button></form></div><div id="external-run-list"></div></section></aside>
<script src="/browser-client.js?token=${token}"></script></body></html>`;
}
