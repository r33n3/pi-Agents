import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentExecutionContext } from "./agent-executor.ts";

export interface AgentWorkerStartMessage {
	type: "start";
	context: AgentExecutionContext;
	agentDir: string;
	serveRoot: string;
	resultPath: string;
	capabilityToolNames: string[];
}

export interface AgentWorkerAbortMessage {
	type: "abort";
}

export type AgentWorkerRequest = AgentWorkerStartMessage | AgentWorkerAbortMessage;

export interface AgentWorkerEventMessage {
	type: "event";
	message: string;
}

export interface AgentWorkerResultMessage {
	type: "result";
}

export interface AgentWorkerResultArtifact {
	output: string;
	transcript: AgentMessage[];
}

export interface AgentWorkerErrorMessage {
	type: "error";
	error: string;
}

export type AgentWorkerResponse = AgentWorkerEventMessage | AgentWorkerResultMessage | AgentWorkerErrorMessage;
