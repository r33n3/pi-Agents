import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiServer } from "@earendil-works/pi-server";
import { TestServerService } from "@earendil-works/pi-server/testing";
import { AgentRegistry } from "../../src/core/serve/agent-registry.ts";
import { createServePage } from "../../src/core/serve/serve-page.ts";
import { WebSocketListener } from "../../src/core/serve/websocket-listener.ts";

const root = await mkdtemp(join(tmpdir(), "pi-serve-ui-smoke-"));
const port = Number(process.argv[2] ?? 4187);
const token = process.argv[3] ?? "smoke-token";
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("Fixture port is invalid");
const registry = new AgentRegistry(root);
await registry.initialize();
const service = new TestServerService();
service.seed("session-1", "Smoke session", root);
const listener = new WebSocketListener({
	host: "127.0.0.1",
	port,
	token,
	onHttpRequest: createServePage(token, registry),
});
const server = new PiServer(service, { listeners: [listener] });
await server.start();
console.log(`http://127.0.0.1:${port}/?token=${token}`);

async function stop(): Promise<void> {
	await server.close();
	await rm(root, { recursive: true, force: true });
	process.exit(0);
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
await new Promise(() => {});
