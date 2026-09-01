import { afterEach, describe, expect, test } from "vitest";
import { PiServer } from "../src/index.ts";
import { ProtocolTestClient, TestServerService } from "../src/testing/index.ts";

const servers = new Set<PiServer>();
afterEach(async () => {
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
});

async function startServer() {
	const service = new TestServerService();
	const server = new PiServer(service, { listeners: [] });
	servers.add(server);
	await server.start();
	return { server, service };
}

async function connect(server: PiServer): Promise<ProtocolTestClient> {
	let client: ProtocolTestClient;
	let closed = false;
	const handler = server.accept({
		get closed() {
			return closed;
		},
		async send(chunk) {
			client.receive(chunk);
		},
		close(finalChunk) {
			if (closed) return;
			if (finalChunk) client.receive(finalChunk);
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	});
	client = new ProtocolTestClient({
		async send(chunk) {
			handler.onData(chunk);
		},
		async sendFragmented(chunk, splitAt) {
			handler.onData(chunk.subarray(0, splitAt));
			handler.onData(chunk.subarray(splitAt));
		},
		async close() {
			if (closed) return;
			closed = true;
			handler.onClose();
			client.markClosed();
		},
	});
	return client;
}

async function attach(client: ProtocolTestClient, sessionId: string) {
	const response = await client.request({ command: "attach", sessionId });
	if (!response.ok || response.result.command !== "attach") throw new Error("Attach failed");
	return response.result.session;
}

describe("native controls across the server protocol", () => {
	test("routes native settings and publishes the same selection to attached clients and reconnects", async () => {
		const { server, service } = await startServer();
		const first = await connect(server);
		const observer = await connect(server);
		await first.hello();
		await observer.hello();
		const modelControls = { reasoningEffort: "high", processingTier: "fast" };
		const created = await first.request({ command: "create", modelControls });
		if (!created.ok || created.result.command !== "create") throw new Error("Create failed");
		const sessionId = created.result.session.id;
		expect(created.result.session.modelControls).toEqual(modelControls);
		await attach(observer, sessionId);
		const model = { provider: "test", id: "replacement" };
		const retained = await first.request({ command: "set_model", sessionId, model });
		expect(retained).toMatchObject({ ok: true, result: { session: { model, modelControls } } });
		const defaults = await first.request({ command: "set_model", sessionId, model, modelControls: {} });
		expect(defaults).toMatchObject({ ok: true, result: { session: { modelControls: {} } } });
		const marker = observer.messages.length;
		await first.request({ command: "set_model_controls", sessionId, modelControls: { reasoningBudget: -1 } });
		await observer.nextFrom(
			marker,
			(message) =>
				message.type === "event" &&
				message.event.type === "session_snapshot" &&
				message.event.snapshot.modelControls?.reasoningBudget === -1,
		);
		await first.request({ command: "detach", sessionId });
		await observer.request({ command: "detach", sessionId });
		expect((await attach(first, sessionId)).modelControls).toEqual({ reasoningBudget: -1 });
		const restored = await first.request({ command: "set_model_controls", sessionId, modelControls: null });
		if (!restored.ok || restored.result.command !== "set_model_controls") throw new Error("Settings change failed");
		expect(restored.result.session.modelControls).toBeUndefined();
		expect(service.latestRuntime(sessionId).snapshot().modelControls).toBeUndefined();
		await first.request({ command: "set_model_controls", sessionId, modelControls });
		const legacy = await first.request({ command: "set_thinking", sessionId, thinkingLevel: "high" });
		if (!legacy.ok || legacy.result.command !== "set_thinking") throw new Error("Thinking change failed");
		expect(legacy.result.session.modelControls).toBeUndefined();
	});

	test("rejects mixed create settings before allocating a runtime and unattached native control changes", async () => {
		const { server, service } = await startServer();
		const client = await connect(server);
		await client.hello();
		expect(await client.request({ command: "create", thinkingLevel: "high", modelControls: {} })).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(service.lastCreatedId).toBeUndefined();
		expect(
			await client.request({ command: "set_model_controls", sessionId: "unattached", modelControls: {} }),
		).toMatchObject({ ok: false, error: { code: "invalid_request" } });
	});
});
