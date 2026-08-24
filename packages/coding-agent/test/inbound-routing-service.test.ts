import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import { InboundRoutingService } from "../src/core/serve/inbound-routing-service.ts";

describe("InboundRoutingService", () => {
	let root: string;
	let connections: CapabilityConnectionRegistry;
	let routing: InboundRoutingService;
	const secret = "fixture-secret";

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-inbound-routing-"));
		connections = new CapabilityConnectionRegistry(join(root, "connections"));
		await connections.initialize();
		await connections.save({
			id: "chat-work",
			providerId: "slack",
			accountLabel: "Work",
			secretRef: "env:FIXTURE_WEBHOOK_SECRET",
			scopes: ["messages.read"],
			capabilityIds: ["messaging.history"],
		});
		routing = new InboundRoutingService(join(root, "routing"), connections, (reference) =>
			reference === "env:FIXTURE_WEBHOOK_SECRET" ? secret : undefined,
		);
		await routing.initialize();
		await routing.saveRoute({
			id: "work-chat",
			connectionId: "chat-work",
			destination: { kind: "coordinator", id: "pi-coordinator" },
			allowedSenders: ["U123"],
			maxEventsPerMinute: 2,
			enabled: true,
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("verifies signatures, fixes the destination, and deduplicates persisted events", async () => {
		const body = Buffer.from(JSON.stringify({ eventId: "event-1", sender: "U123", text: "Review the report" }));
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
		const accepted = await routing.accept("work-chat", timestamp, signature, body);
		expect(accepted).toMatchObject({ route: { destination: { kind: "coordinator", id: "pi-coordinator" } } });
		expect(await routing.accept("work-chat", timestamp, signature, body)).toBeUndefined();

		const restored = new InboundRoutingService(join(root, "routing"), connections, () => secret);
		await restored.initialize();
		expect(await restored.accept("work-chat", timestamp, signature, body)).toBeUndefined();
	});

	test("rejects altered messages and senders outside the allowlist", async () => {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const allowed = Buffer.from(JSON.stringify({ eventId: "event-2", sender: "U123", text: "Allowed" }));
		const signature = createHmac("sha256", secret).update(timestamp).update(".").update(allowed).digest("hex");
		const altered = Buffer.from(JSON.stringify({ eventId: "event-2", sender: "U999", text: "Altered" }));
		await expect(routing.accept("work-chat", timestamp, signature, altered)).rejects.toThrow("signature");

		const outside = Buffer.from(JSON.stringify({ eventId: "event-3", sender: "U999", text: "Outside" }));
		const outsideSignature = createHmac("sha256", secret).update(timestamp).update(".").update(outside).digest("hex");
		await expect(routing.accept("work-chat", timestamp, outsideSignature, outside)).rejects.toThrow("not allowed");
	});

	test("requires a messaging connection and removes route delivery state", async () => {
		await connections.save({
			id: "weather-work",
			providerId: "weather",
			accountLabel: "Weather",
			secretRef: "managed:weather/work",
			scopes: ["weather.read"],
			capabilityIds: ["weather.current"],
		});
		await expect(
			routing.saveRoute({
				id: "wrong-capability",
				connectionId: "weather-work",
				destination: { kind: "agent", id: "researcher" },
				allowedSenders: [],
				maxEventsPerMinute: 2,
				enabled: true,
			}),
		).rejects.toThrow("no messaging capability");

		const body = Buffer.from(JSON.stringify({ eventId: "event-delete", sender: "U123", text: "Delete me" }));
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
		await routing.accept("work-chat", timestamp, signature, body);
		expect(await routing.deleteRoute("work-chat")).toBe(true);

		await routing.saveRoute({
			id: "work-chat",
			connectionId: "chat-work",
			destination: { kind: "coordinator", id: "pi-coordinator" },
			allowedSenders: ["U123"],
			maxEventsPerMinute: 2,
			enabled: true,
		});
		expect(await routing.accept("work-chat", timestamp, signature, body)).toBeDefined();
	});
});
