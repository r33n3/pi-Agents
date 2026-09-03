import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	CapabilityApprovalService,
	createCapabilityApprovalActionBinding,
} from "../src/core/serve/capability-approval-service.ts";

describe("CapabilityApprovalService", () => {
	let root: string;
	let approvals: CapabilityApprovalService;
	const owner = { kind: "agent-run" as const, id: "run-1" };
	const binding = createCapabilityApprovalActionBinding(
		{ capabilityId: "email.send", input: { subject: "Subject", text: "Body" } },
		"Send email to person@example.com",
	);
	const request = {
		capabilityId: "email.send",
		providerId: "gmail",
		connectionId: "gmail-work",
		action: "send",
		target: "person@example.com",
		owner,
		binding,
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-capability-approvals-"));
		approvals = new CapabilityApprovalService(root);
		await approvals.initialize();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("requires explicit approval and an exact action and owner binding", async () => {
		await expect(approvals.issue(request, false)).rejects.toThrow("explicit confirmation");
		await expect(
			approvals.issue(
				{
					capabilityId: request.capabilityId,
					providerId: request.providerId,
					connectionId: request.connectionId,
					action: request.action,
					target: request.target,
				},
				true,
			),
		).rejects.toThrow("approval owner");

		const receipt = await approvals.issue(request, true);
		await expect(
			approvals.begin(receipt.id, {
				...request,
				binding: createCapabilityApprovalActionBinding(
					{ capabilityId: "email.send", input: { subject: "Changed", text: "Body" } },
					binding.preview,
				),
			}),
		).rejects.toThrow("does not match exact action");
		await expect(approvals.begin(receipt.id, { ...request, owner: { ...owner, id: "run-2" } })).rejects.toThrow(
			"does not match owner",
		);
		expect(await approvals.begin(receipt.id, request)).toMatchObject({
			kind: "execute",
			receipt: { state: "started" },
		});
	});

	test("canonicalizes object keys while rejecting non-JSON action values", () => {
		expect(createCapabilityApprovalActionBinding({ b: 2, a: 1 }, "preview").digest).toBe(
			createCapabilityApprovalActionBinding({ a: 1, b: 2 }, "preview").digest,
		);
		expect(() => createCapabilityApprovalActionBinding({ value: undefined }, "preview")).toThrow("undefined");
	});

	test("preserves one idempotency key and exact completed replay across restart", async () => {
		const receipt = await approvals.issue(request, true);
		const first = await approvals.begin(receipt.id, request);
		expect(first.kind).toBe("execute");
		await expect(approvals.begin(receipt.id, request)).rejects.toThrow("already in progress");
		await approvals.complete(receipt.id, { providerMessageId: "message-1" });

		const restored = new CapabilityApprovalService(root);
		await restored.initialize();
		const replay = await restored.begin(receipt.id, request);
		expect(replay).toMatchObject({
			kind: "replay",
			receipt: { idempotencyKey: receipt.idempotencyKey },
			result: { providerMessageId: "message-1" },
		});
	});

	test("cancels approved receipts and records revocation on started receipts", async () => {
		const approved = await approvals.issue(request, true);
		const started = await approvals.issue(request, true);
		await approvals.begin(started.id, request);

		expect(await approvals.revoke({ owner }, "Run was aborted")).toBe(2);
		expect(approvals.list()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: approved.id, state: "cancelled", revocationReason: "Run was aborted" }),
				expect.objectContaining({ id: started.id, state: "started", revocationReason: "Run was aborted" }),
			]),
		);
		await expect(approvals.begin(approved.id, request)).rejects.toThrow("revoked");
		expect(await approvals.complete(started.id, { providerMessageId: "message-1" })).toMatchObject({
			state: "completed",
			revocationReason: "Run was aborted",
		});
	});

	test("migrates version 1 receipts to history and rewrites on the next mutation", async () => {
		const timestamp = new Date().toISOString();
		await writeFile(
			join(root, "approvals.json"),
			JSON.stringify({
				version: 1,
				receipts: {
					approved: {
						id: "approved",
						idempotencyKey: "key-approved",
						capabilityId: "email.send",
						providerId: "gmail",
						connectionId: "gmail-work",
						action: "send",
						target: "person@example.com",
						approvedAt: timestamp,
						expiresAt: timestamp,
						state: "approved",
					},
					started: {
						id: "started",
						idempotencyKey: "key-started",
						capabilityId: "email.send",
						providerId: "gmail",
						connectionId: "gmail-work",
						action: "send",
						target: "person@example.com",
						approvedAt: timestamp,
						expiresAt: timestamp,
						state: "started",
					},
				},
			}),
			"utf8",
		);
		const restored = new CapabilityApprovalService(root);
		await restored.initialize();
		expect(restored.list()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "approved", legacy: true, state: "cancelled" }),
				expect.objectContaining({ id: "started", legacy: true, state: "failed" }),
			]),
		);
		await expect(restored.begin("approved", request)).rejects.toThrow("cannot authorize execution or replay");
		await restored.issue(request, true);
		expect(JSON.parse(await readFile(join(root, "approvals.json"), "utf8"))).toMatchObject({ version: 2 });
	});
});
