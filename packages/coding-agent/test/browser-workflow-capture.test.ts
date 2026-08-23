import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserWorkflowCaptureStore } from "../src/core/serve/browser-workflow-capture.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function page(url = "http://127.0.0.1:4173/") {
	return {
		url,
		title: "Fixture",
		elements: [{ role: "textbox", name: "Password", label: "Password", inputType: "password" }],
	};
}

describe("BrowserWorkflowCaptureStore", () => {
	test("persists semantic actions without typed values", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-capture-"));
		roots.push(root);
		const store = new BrowserWorkflowCaptureStore(root);
		await store.initialize();
		const capture = await store.start({
			profile: { kind: "ephemeral" },
			sessionId: "session-1",
			owner: { kind: "pi-session", id: "pi-1" },
			viewport: { width: 1440, height: 960, deviceScaleFactor: 1 },
			initial: page(),
		});
		await store.record("session-1", {
			action: {
				kind: "type",
				textLength: 12,
				target: page().elements[0],
				sensitive: true,
			},
			before: page(),
			after: page("http://127.0.0.1:4173/account"),
		});
		const stopped = await store.stop("session-1");
		expect(stopped).toMatchObject({ id: capture.id, status: "stopped" });
		expect(stopped.steps[0]?.action).toEqual({
			kind: "type",
			textLength: 12,
			target: { role: "textbox", name: "Password", label: "Password", inputType: "password" },
			sensitive: true,
		});
		expect(JSON.stringify(stopped)).not.toContain("secret-value");

		const restarted = new BrowserWorkflowCaptureStore(root);
		await restarted.initialize();
		expect(restarted.get(capture.id)).toEqual(stopped);
	});

	test("coalesces adjacent scroll input and recovers active captures as interrupted", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-browser-capture-"));
		roots.push(root);
		const store = new BrowserWorkflowCaptureStore(root);
		await store.initialize();
		const capture = await store.start({
			profile: { kind: "ephemeral" },
			sessionId: "session-2",
			owner: { kind: "agent-run", id: "run-1" },
			viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
			initial: page(),
		});
		await store.record("session-2", {
			action: { kind: "scroll", deltaX: 0, deltaY: 80 },
			before: page(),
			after: page(),
		});
		await store.record("session-2", {
			action: { kind: "scroll", deltaX: 0, deltaY: 120 },
			before: page(),
			after: page(),
		});
		expect(store.get(capture.id)?.steps).toHaveLength(1);
		expect(store.get(capture.id)?.steps[0]?.action).toEqual({ kind: "scroll", deltaX: 0, deltaY: 200 });

		const restarted = new BrowserWorkflowCaptureStore(root);
		await restarted.initialize();
		expect(restarted.get(capture.id)?.status).toBe("interrupted");
		expect(restarted.getForSession("session-2")).toBeUndefined();
	});
});
