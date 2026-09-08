import { createHash } from "node:crypto";
import type { CapabilityApprovalEvidence } from "./capability-approval-service.ts";

export interface DraftApprovalMessage {
	id: string;
	conversationId: string;
	role: string;
	text?: string;
}

/** Conservative draft-only intent recognition over host-selected user messages.
 * Callers must select the current request, excluding history and delegated prompts.
 * Ambiguous requests remain blocked. This never authorizes sending or a schedule.
 */
export function chatDraftApproval(messages: DraftApprovalMessage[]): CapabilityApprovalEvidence | undefined {
	const users = messages.filter((message) => message.role === "user" && message.text);
	for (const message of users) {
		if (/\b(?:cancel|stop|revoke|withdraw|don't|do not|never)\b[^.!?\n]*\b(?:draft|attach)\b/i.test(message.text!))
			return undefined;
	}
	const message = [...users].reverse().find((entry) => {
		const text = entry.text!.trim();
		return (
			!/[`<>]/.test(text) &&
			/\b(?:create|crate|prepare|save|attach|embed|add)\b/i.test(text) &&
			/\b(?:draft|drafts)\b/i.test(text) &&
			/\b(?:email|gmail|attach)\b/i.test(text) &&
			/^(?:please\s+)?(?:create|crate\s+(?:a\s+)?draft\b|put\b[^.!?\n]{0,256}\band\s+(?:create|prepare|save)\s+(?:a\s+)?draft\b|prepare|save|attach|embed|add|approved?\b|can\s+(?:you|the\s+report\s+agent)\b|have\s+the\b)/i.test(
				text,
			)
		);
	});
	return message
		? {
				messageId: message.id,
				conversationId: message.conversationId,
				textDigest: createHash("sha256").update(message.text!).digest("hex"),
			}
		: undefined;
}
