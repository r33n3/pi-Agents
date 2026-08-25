import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";

describe("ServeAuditStore", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-serve-audit-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("durably appends redacted decisions and outcomes and recovers them after restart", async () => {
		const ids = ["correlation-1", "decision-1", "outcome-1"];
		const store = new ServeAuditStore(root, {
			now: () => new Date("2026-08-25T15:00:00.000Z"),
			generateId: () => ids.shift() ?? "unexpected-id",
		});
		const decision = await store.appendDecision({
			identities: {
				actorId: "operator-1",
				sessionId: "session-1",
				agentId: "agent-1",
				taskId: "task-1",
				attemptId: "attempt-1",
				computerId: "computer-1",
			},
			action: {
				family: "browser.navigate",
				target: {
					url: "https://user:password@example.test/page?z=last&access_token=url-secret&key=key-secret&code=code-secret&a=first",
					headers: {
						authorization: "Bearer header-secret",
						cookie: "session=cookie-secret",
						accept: "application/json",
					},
					credentials: { password: "password-secret", api_key: "api-secret" },
				},
			},
			decision: "allow",
			reason: "Target passed browser policy with token=reason-secret",
			policy: "browser-policy-v1",
			grant: "browser.public-web",
			approval: "approval-1",
		});
		expect(decision).toMatchObject({
			id: "decision-1",
			correlationId: "correlation-1",
			timestamp: "2026-08-25T15:00:00.000Z",
			kind: "decision",
			decision: "allow",
		});
		expect(decision.action.target).toEqual({
			credentials: "[REDACTED]",
			headers: {
				accept: "application/json",
				authorization: "[REDACTED]",
				cookie: "[REDACTED]",
			},
			url: "https://redacted:redacted@example.test/page?a=first&access_token=redacted&code=redacted&key=redacted&z=last",
		});

		const outcome = await store.appendOutcome({
			correlationId: decision.correlationId,
			identities: { agentId: "agent-1", attemptId: "attempt-1" },
			action: decision.action,
			outcome: "failed",
			durationMs: 73,
			error: {
				classification: "dependency",
				code: "HTTP_502",
				message:
					"Bearer error-secret token=assignment-secret from https://api.example.test/fail?api_key=query-secret",
			},
		});
		expect(outcome.error?.message).not.toContain("error-secret");
		expect(outcome.error?.message).not.toContain("query-secret");

		const persisted = await readFile(join(root, "serve-audit.jsonl"), "utf8");
		expect(persisted.trim().split("\n")).toHaveLength(2);
		for (const secret of [
			"reason-secret",
			"password-secret",
			"api-secret",
			"header-secret",
			"cookie-secret",
			"url-secret",
			"key-secret",
			"code-secret",
			"error-secret",
			"assignment-secret",
			"query-secret",
		]) {
			expect(persisted).not.toContain(secret);
		}

		const restarted = new ServeAuditStore(root);
		const [firstRead, secondRead] = await Promise.all([restarted.read(), restarted.read()]);
		expect(firstRead).toEqual([decision, outcome]);
		expect(secondRead).toEqual(firstRead);
	});

	test("serializes concurrent appends without losing events", async () => {
		let nextId = 0;
		const store = new ServeAuditStore(root, { generateId: () => `generated-${++nextId}` });
		const decisions = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.appendDecision({
					action: { family: "files.read", target: { path: `file-${index}.txt` } },
					decision: "allow",
					reason: "Workspace read grant",
				}),
			),
		);
		await Promise.all(
			decisions.map((decision) =>
				store.appendOutcome({
					correlationId: decision.correlationId,
					action: decision.action,
					outcome: "succeeded",
					durationMs: 1,
				}),
			),
		);
		const events = await store.read();
		expect(events).toHaveLength(40);
		expect(new Set(events.map((event) => event.id))).toHaveLength(40);
		expect((await readFile(join(root, "serve-audit.jsonl"), "utf8")).trim().split("\n")).toHaveLength(40);
	});

	test("rejects malformed, oversized, and inconsistent events", async () => {
		const store = new ServeAuditStore(root);
		await expect(
			store.appendDecision({
				action: { family: "Browser Navigate", target: {} },
				decision: "allow",
				reason: "invalid family",
			}),
		).rejects.toThrow("action family");
		await expect(
			store.appendDecision({
				action: { family: "browser.navigate", target: { value: "x".repeat(33 * 1024) } },
				decision: "allow",
				reason: "oversized",
			}),
		).rejects.toThrow("target string");
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		await expect(
			store.appendDecision({
				action: { family: "files.write", target: cyclic },
				decision: "deny",
				reason: "cycle",
			}),
		).rejects.toThrow("cycles");
		await expect(
			store.appendOutcome({
				correlationId: "missing",
				action: { family: "files.read", target: {} },
				outcome: "succeeded",
				durationMs: 1,
			}),
		).rejects.toThrow("has no decision");
		const decision = await store.appendDecision({
			action: { family: "files.read", target: {} },
			decision: "allow",
			reason: "valid",
		});
		await expect(
			store.appendOutcome({
				correlationId: decision.correlationId,
				action: decision.action,
				outcome: "failed",
				durationMs: 1,
			}),
		).rejects.toThrow("require a safe error");
		await expect(
			store.appendOutcome({
				correlationId: decision.correlationId,
				action: { family: "files.read", target: { path: "different.txt" } },
				outcome: "succeeded",
				durationMs: 1,
			}),
		).rejects.toThrow("does not match its decision action");
	});

	test("fails closed on a corrupted persisted ledger", async () => {
		await writeFile(join(root, "serve-audit.jsonl"), "{not-json}\n", "utf8");
		const store = new ServeAuditStore(root);
		await expect(store.read()).rejects.toThrow("not valid JSON");
	});

	test("fails closed on unknown persisted fields", async () => {
		await writeFile(
			join(root, "serve-audit.jsonl"),
			`${JSON.stringify({
				version: 1,
				id: "event-1",
				correlationId: "correlation-1",
				timestamp: "2026-08-25T15:00:00.000Z",
				kind: "decision",
				action: { family: "files.read", target: {} },
				decision: "allow",
				reason: "fixture",
				unexpected: true,
			})}\n`,
			"utf8",
		);
		await expect(new ServeAuditStore(root).read()).rejects.toThrow("unknown field");
	});

	test("surfaces decision persistence failures to callers", async () => {
		const blocked = join(root, "blocked");
		await writeFile(blocked, "not a directory", "utf8");
		const store = new ServeAuditStore(blocked);
		await expect(
			store.appendDecision({
				action: { family: "shell.execute", target: { command: "echo safe" } },
				decision: "allow",
				reason: "fixture",
			}),
		).rejects.toBeInstanceOf(Error);
	});
});
