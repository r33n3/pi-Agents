import type { Command, ModelControls, SessionSnapshot } from "@earendil-works/pi-protocol";
import { describe, expect, test } from "vitest";
import { connectClient, MemoryByteServer, sessionSnapshot } from "./support.ts";

describe("native model settings on session leases", () => {
	test("carries native create, atomic model replacement, defaults, and explicit legacy choices", async () => {
		const server = new MemoryByteServer();
		const client = await connectClient(server);
		const requests: Command[] = [];
		let snapshot: SessionSnapshot = sessionSnapshot("fixture");
		server.onMessage((message) => {
			if (message.type !== "request") return;
			const request = message.request;
			requests.push(request);
			if (
				request.command !== "create" &&
				request.command !== "set_model" &&
				request.command !== "set_model_controls"
			)
				return;
			snapshot = {
				...snapshot,
				revision: snapshot.revision + 1,
				...(request.command === "set_model" ? { model: request.model } : {}),
				...(request.modelControls === undefined ? {} : { modelControls: request.modelControls ?? undefined }),
			};
			server.send({
				type: "response",
				id: message.id,
				ok: true,
				result: { command: request.command, session: snapshot },
			});
		});
		try {
			const controls: ModelControls = { reasoningEffort: "low", processingTier: "fast" };
			const lease = await client.createSession({ modelControls: controls });
			expect(lease.snapshot?.modelControls).toEqual(controls);
			const model = { provider: "fixture", id: "replacement" };
			expect((await lease.setModel(model)).modelControls).toEqual(controls);
			expect(requests.at(-1)).not.toHaveProperty("modelControls");
			expect((await lease.setModel(model, {})).modelControls).toEqual({});
			expect((await lease.setModelControls({ reasoningBudget: -1 })).modelControls).toEqual({ reasoningBudget: -1 });
			expect((await lease.setModelControls(null)).modelControls).toBeUndefined();
			expect(requests.at(-1)).toEqual({ command: "set_model_controls", sessionId: "fixture", modelControls: null });
			await lease.setModelControls(controls);
			expect((await lease.setModel(model, null)).modelControls).toBeUndefined();
		} finally {
			client.disconnect();
		}
	});
});
