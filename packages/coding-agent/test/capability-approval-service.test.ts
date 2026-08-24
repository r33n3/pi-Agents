import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CapabilityApprovalService } from "../src/core/serve/capability-approval-service.ts";

describe("CapabilityApprovalService", () => {
	let root: string;
	let approvals: CapabilityApprovalService;
	const request = {
		capabilityId: "email.send",
		providerId: "gmail",
		connectionId: "gmail-work",
		action: "send email",
		target: "person@example.com",
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-capability-approvals-"));
		approvals = new CapabilityApprovalService(root);
		await approvals.initialize();
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("requires explicit approval and binds the visible target", async () => {
		await expect(approvals.issue(request, false)).rejects.toThrow("explicit confirmation");
		const receipt = await approvals.issue(request, true);
		await expect(approvals.begin(receipt.id, { ...request, target: "other@example.com" })).rejects.toThrow(
			"does not match target",
		);
		expect(await approvals.begin(receipt.id, request)).toMatchObject({
			state: "started",
		});
	});

	test("preserves one idempotency key and outcome across restart and retries", async () => {
		const receipt = await approvals.issue(request, true);
		const first = await approvals.begin(receipt.id, request);
		const retry = await approvals.begin(receipt.id, request);
		expect(retry.idempotencyKey).toBe(first.idempotencyKey);
		await approvals.complete(receipt.id, { providerMessageId: "message-1" });

		const restored = new CapabilityApprovalService(root);
		await restored.initialize();
		const replay = await restored.begin(receipt.id, request);
		expect(replay).toMatchObject({
			state: "completed",
			idempotencyKey: first.idempotencyKey,
			result: { providerMessageId: "message-1" },
		});
	});
});
