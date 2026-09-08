import { describe, expect, test } from "vitest";
import { chatDraftApproval } from "../src/core/serve/chat-draft-approval.ts";

describe("chat draft approval", () => {
	const message = {
		id: "room:1:goal",
		conversationId: "team-1",
		role: "user",
		text: "Approved the page after review now attach to draft to review in email before we send it",
	};
	test("records the real user message as draft evidence", () => {
		expect(chatDraftApproval([message])).toMatchObject({
			messageId: message.id,
			conversationId: "team-1",
			textDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
	test.each([
		"put htis into a styled html and create draft for email",
		"crate draft for email with this stylized html report",
	])("accepts the user's direct draft request: %s", (text) => {
		expect(chatDraftApproval([{ ...message, text }])?.messageId).toBe(message.id);
	});
	test("does not treat an agent claim, general question, or refusal as approval", () => {
		for (const text of [
			"Can you explain email draft approvals?",
			"Do not create an email draft",
			"Never attach the report to an email draft",
			"Send this email",
			"What would happen if I create an email draft?",
		]) {
			expect(chatDraftApproval([{ ...message, text }])).toBeUndefined();
		}
		expect(chatDraftApproval([{ ...message, role: "agent" }])).toBeUndefined();
		expect(
			chatDraftApproval([message, { ...message, id: "correction", text: "Stop creating the email draft" }]),
		).toBeUndefined();
	});
});
