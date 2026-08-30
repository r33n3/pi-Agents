import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { WtkAgentFactoryClient } from "../src/core/serve/wtk-agent-factory-client.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("uses only the allowlisted loopback WTK control surface and loads a bounded bundle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-wtk-factory-"));
	roots.push(root);
	const packageRoot = join(root, ".wtk", "packages", "research-team", "targets", "pi-agents");
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "bundle.json"), JSON.stringify({ schemaVersion: "pi.agents.bundle.v1" }), "utf8");
	const requests: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = [];
	const fakeFetch: typeof fetch = async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		const headers = new Headers(init?.headers);
		requests.push({
			method: init?.method ?? "GET",
			path: url.pathname,
			authorization: headers.get("authorization"),
			...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
		});
		if (url.pathname === "/healthz") return Response.json({ ok: true });
		if (url.pathname === "/api/goal-intake/start") {
			return Response.json(
				{ operation: { id: "op-1", kind: "goal-intake-turn", status: "queued" } },
				{ status: 202 },
			);
		}
		if (url.pathname === "/api/operations/op-1") {
			return Response.json({
				operation: {
					id: "op-1",
					kind: "goal-intake-turn",
					status: "succeeded",
					result: { done: false, prompt: "Which workspace?" },
				},
			});
		}
		if (url.pathname === "/api/executions/op-1/control") {
			return Response.json({ operation: { id: "op-1", kind: "goal-intake-turn", status: "running" } });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	};
	const client = new WtkAgentFactoryClient({
		origin: "http://127.0.0.1:7878",
		root,
		accessToken: "test-token",
		fetch: fakeFetch,
	});

	assert.deepEqual(await client.status(), {
		configured: true,
		available: true,
		message: "Canonical WTK builder is ready",
	});
	assert.equal((await client.startIntake("Build a research team")).operation.id, "op-1");
	assert.equal((await client.operation("op-1")).status, "succeeded");
	assert.equal((await client.controlOperation("op-1", "resume", "Use the stricter fixture")).status, "running");
	assert.deepEqual(await client.loadBundle("research-team"), { schemaVersion: "pi.agents.bundle.v1" });
	assert.deepEqual(
		requests.map((request) => request.path),
		["/healthz", "/api/goal-intake/start", "/api/operations/op-1", "/api/executions/op-1/control"],
	);
	assert.ok(requests.every((request) => request.authorization === "Bearer test-token"));
	assert.deepEqual(requests[1]!.body, {
		input: "Build a research team",
		experience: "conversation",
		defer: true,
	});
	assert.deepEqual(requests[3]!.body, { action: "resume", message: "Use the stricter fixture" });
});

test("rejects remote control origins and package traversal", async () => {
	assert.throws(() => new WtkAgentFactoryClient({ origin: "https://example.com", root: "C:\\wtk" }), /loopback/);
	const root = await mkdtemp(join(tmpdir(), "pi-wtk-factory-invalid-"));
	roots.push(root);
	const client = new WtkAgentFactoryClient({ origin: "http://localhost:7878", root, fetch: fetch });
	await assert.rejects(client.loadBundle("../escape"), /pkgId/);
});
