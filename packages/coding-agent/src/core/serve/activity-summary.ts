import type { AgentRoomRun } from "./agent-room-service.ts";
import type { AgentTask } from "./agent-task-service.ts";

/** Display-only records. Full evidence remains on the task/run detail endpoints. */
export function taskActivitySummary(task: AgentTask) {
	return {
		summary: true,
		id: task.id,
		conversationId: task.conversationId,
		agentId: task.agentId,
		status: task.status,
		prompt: task.prompt.slice(0, 240),
		createdAt: task.createdAt,
		phase: task.phase,
		progressMessage: task.progressMessage,
		lastActivityAt: task.lastActivityAt,
		attemptIds: task.attemptIds,
		artifactIds: task.artifactIds,
		roomRunId: task.contract.room?.runId,
		usage: task.usage,
		error: task.error?.slice(0, 240),
	};
}

export function roomActivitySummary(run: AgentRoomRun) {
	const { definitionSnapshot: _definition, ...summary } = run;
	return summary;
}
