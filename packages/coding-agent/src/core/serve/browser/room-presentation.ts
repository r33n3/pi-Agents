type RoomRunStatus = "running" | "completed" | "needs-user" | "bounded" | "failed" | "cancelled";

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
