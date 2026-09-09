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
		"Now have Report Design and Tool Builder build the renderer. Then have Concise Travel Reporting Specialist create one TEST Gmail draft to bradja44@gmail.com. Do not send email.",
		"Please add a report designer. Have it create an HTML template and create a Gmail draft for review.",
		"Give the builder its report tool. After that, our reporting specialist should create one TEST Gmail draft. Do not send email.",
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
			"Have you created the Gmail draft?",
		]) {
			expect(chatDraftApproval([{ ...message, text }])).toBeUndefined();
		}
		expect(chatDraftApproval([{ ...message, role: "agent" }])).toBeUndefined();
		expect(
			chatDraftApproval([message, { ...message, id: "correction", text: "Stop creating the email draft" }]),
		).toBeUndefined();
	});
	test("retains the original user request through a tool approval without accepting delegated text", () => {
		const request = { ...message, text: "Now have the reporter create a Gmail draft after the builder finishes." };
		expect(chatDraftApproval([request, { ...message, id: "approval", text: "Approve tools" }])?.messageId).toBe(
			request.id,
		);
		expect(chatDraftApproval([{ ...request, role: "agent" }])).toBeUndefined();
	});
});
