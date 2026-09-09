type RoomRunStatus = "running" | "completed" | "needs-user" | "bounded" | "failed" | "cancelled";

export interface RoomComposerPresentation {
	label: "Continue team" | "Send to team" | "Stop team" | "Stopping team";
	isStopping: boolean;
	disabled: boolean;
}

export function roomComposerPresentation(
	status: RoomRunStatus | undefined,
	stopping = false,
): RoomComposerPresentation {
	if (status === "running") {
		return {
			label: stopping ? "Stopping team" : "Stop team",
			isStopping: true,
			disabled: stopping,
		};
	}
	return {
		label: status === "needs-user" ? "Continue team" : "Send to team",
		isStopping: false,
		disabled: false,
	};
}

export function roomNeedsUserNotice(
	question: string | undefined,
	members: readonly { agentId: string; name?: string }[] = [],
): string {
	let retained = (question ?? "").replace(/^Host evidence: [^\r\n]*(?:\r?\n|$)/gm, "").trim();
	for (const member of members) {
		retained = retained.split(`${member.agentId}: `).join(member.name ? `${member.name}: ` : "");
	}
	return (
		retained ||
		"The team paused without providing a specific question. Ask the supervisor to explain the blocker or provide a new direction. The request and completed work are retained."
	);
}

/** Limit termination preserves useful evidence and must not look like a failed member task. */
export function roomRunPresentation(status: RoomRunStatus): {
	label: string;
	activityStatus: string;
	noticeClassName: string;
} {
	return {
		label: status === "needs-user" ? "needs user" : status === "bounded" ? "limit reached" : status,
		activityStatus: status === "needs-user" ? "waiting_for_input" : status,
		noticeClassName: status === "bounded" || status === "cancelled" ? "muted" : "run-error",
	};
}
