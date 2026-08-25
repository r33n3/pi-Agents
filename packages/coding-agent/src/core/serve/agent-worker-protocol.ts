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

export type AgentWorkerHostAction =
	| { family: "filesystem.read"; path: string }
	| { family: "filesystem.list"; path: string }
	| { family: "filesystem.write"; path: string; content: string };

export type AgentWorkerHostActionResult =
	| { family: "filesystem.read"; content: string }
	| { family: "filesystem.list"; entries: Array<{ kind: "directory" | "file"; name: string }> }
	| { family: "filesystem.write"; bytesWritten: number };

export interface AgentWorkerHostActionResponseMessage {
	type: "host-action-response";
	requestId: string;
	result?: AgentWorkerHostActionResult;
	error?: { code: string; message: string };
}

export type AgentWorkerRequest =
	| AgentWorkerStartMessage
	| AgentWorkerAbortMessage
	| AgentWorkerHostActionResponseMessage;

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

export interface AgentWorkerHostActionRequestMessage {
	type: "host-action-request";
	requestId: string;
	action: AgentWorkerHostAction;
}

export type AgentWorkerResponse =
	| AgentWorkerEventMessage
	| AgentWorkerResultMessage
	| AgentWorkerErrorMessage
	| AgentWorkerHostActionRequestMessage;
