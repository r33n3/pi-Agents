import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GovernedActionOutcomeUnknownError, GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";

describe("GovernedActionService", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-governed-action-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("records authorization before resolving credentials and dispatching", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const order: string[] = [];
		const result = await service.execute({
			family: "provider.call",
			target: { providerId: "google-workspace", token: "never-a-target" },
			canonicalize: (target) => ({ providerId: target.providerId }),
			authorize: () => {
				order.push("authorize");
				return { decision: "allow", reason: "active grant", grant: "email.read" };
			},
			resolveCredentials: async () => {
				order.push("credentials");
				return "secret";
			},
			dispatch: async ({ credentials }) => {
				order.push("dispatch");
				expect((await audit.read()).map((event) => event.kind)).toEqual(["decision"]);
				return credentials === "secret" ? "ok" : "bad";
			},
		});
		expect(order).toEqual(["authorize", "credentials", "dispatch"]);
		expect(result).toMatchObject({ status: "succeeded", value: "ok" });
		expect((await audit.read()).map((event) => event.kind)).toEqual(["decision", "outcome"]);
	});

	test("denial never resolves credentials or dispatches", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const resolveCredentials = vi.fn();
		const dispatch = vi.fn();
		const result = await service.execute({
			family: "browser.navigate",
			target: "http://192.168.0.10/private",
			canonicalize: (url) => ({ url }),
			authorize: () => ({ decision: "deny", reason: "LAN access is not granted" }),
			resolveCredentials,
			dispatch,
		});
		expect(result).toMatchObject({ status: "denied", reason: "LAN access is not granted" });
		expect(resolveCredentials).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		expect(await audit.read()).toHaveLength(1);
	});

	test("authorization evaluation failures are recorded as denials", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const dispatch = vi.fn();
		const result = await service.execute({
			family: "files.write",
			target: "outside.txt",
			canonicalize: (path) => ({ path }),
			authorize: () => {
				throw new Error("malformed policy token=secret");
			},
			dispatch,
		});
		expect(result).toMatchObject({ status: "denied", reason: "Authorization evaluation failed closed" });
		expect(dispatch).not.toHaveBeenCalled();
		expect(await audit.read()).toEqual([
			expect.objectContaining({ kind: "decision", decision: "deny", policy: "invalid" }),
		]);
	});

	test("decision persistence failure prevents the external effect", async () => {
		const blocked = join(root, "blocked");
		await writeFile(blocked, "file", "utf8");
		const service = new GovernedActionService(new ServeAuditStore(blocked));
		const dispatch = vi.fn();
		await expect(
			service.execute({
				family: "shell.execute",
				target: "echo safe",
				canonicalize: (command) => ({ command }),
				authorize: () => ({ decision: "allow", reason: "fixture" }),
				dispatch,
			}),
		).rejects.toBeInstanceOf(Error);
		expect(dispatch).not.toHaveBeenCalled();
	});

	test("dispatch failures receive a correlated safe outcome", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const failure = Object.assign(new Error("dependency failed token=secret"), { code: "ECONNRESET" });
		await expect(
			service.execute({
				family: "mcp.call",
				target: { server: "example", tool: "lookup" },
				canonicalize: (target) => target,
				authorize: () => ({ decision: "allow", reason: "granted" }),
				dispatch: async () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		const events = await audit.read();
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({ kind: "outcome", outcome: "failed", error: { classification: "dependency" } });
		expect(JSON.stringify(events)).not.toContain("secret");
	});

	test("records cancellation when authority ends while authorization is pending", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const dispatch = vi.fn();
		let live = true;
		await expect(
			service.execute({
				family: "provider.call",
				target: { operation: "send" },
				canonicalize: (target) => target,
				authority: {
					owner: { kind: "agent-run", id: "run-1" },
					assertLive: () => {
						if (!live) throw new Error("Run run-1 is no longer active");
					},
				},
				authorize: async () => {
					live = false;
					return { decision: "allow", reason: "approved" };
				},
				dispatch,
			}),
		).rejects.toThrow("no longer active");
		expect(dispatch).not.toHaveBeenCalled();
		expect(await audit.read()).toEqual([
			expect.objectContaining({ kind: "decision", decision: "allow" }),
			expect.objectContaining({ kind: "outcome", outcome: "cancelled" }),
		]);
	});

	test("rechecks authority after credential resolution and before dispatch", async () => {
		const audit = new ServeAuditStore(root);
		const service = new GovernedActionService(audit);
		const dispatch = vi.fn();
		let live = true;
		await expect(
			service.execute({
				family: "provider.call",
				target: { operation: "send" },
				canonicalize: (target) => target,
				authority: {
					owner: { kind: "agent-run", id: "run-1" },
					assertLive: () => {
						if (!live) throw new Error("Run run-1 is no longer active");
					},
				},
				authorize: () => ({ decision: "allow", reason: "approved" }),
				resolveCredentials: async () => {
					live = false;
					return "secret";
				},
				dispatch,
			}),
		).rejects.toThrow("no longer active");
		expect(dispatch).not.toHaveBeenCalled();
		expect(await audit.read()).toEqual([
			expect.objectContaining({ kind: "decision", decision: "allow" }),
			expect.objectContaining({ kind: "outcome", outcome: "cancelled" }),
		]);
	});

	test("reports outcome_unknown without retrying when post-effect audit fails", async () => {
		const audit = new ServeAuditStore(root);
		const appendOutcome = vi.spyOn(audit, "appendOutcome").mockImplementationOnce(async () => {
			throw new Error("disk unavailable");
		});
		const service = new GovernedActionService(audit);
		const dispatch = vi.fn(async () => "sent");
		await expect(
			service.execute({
				family: "provider.call",
				target: { operation: "send" },
				canonicalize: (target) => target,
				authorize: () => ({ decision: "allow", reason: "approved" }),
				dispatch,
			}),
		).rejects.toBeInstanceOf(GovernedActionOutcomeUnknownError);
		expect(dispatch).toHaveBeenCalledTimes(1);
		appendOutcome.mockRestore();
	});
});
