import type { AgentMessage, AgentToolResult, ToolExecutionMode } from "@earendil-works/pi-agent-core";
import type { AgentExecutionContext, AgentExecutionPhase } from "./agent-executor.ts";

export interface AgentWorkerCapabilityTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: ToolExecutionMode;
}

export interface AgentWorkerStartMessage {
	type: "start";
	context: AgentExecutionContext;
	agentDir: string;
	serveRoot: string;
	resultPath: string;
	capabilityToolNames: string[];
	capabilityTools: AgentWorkerCapabilityTool[];
	/** Ephemeral provider credential resolved by the parent runtime; never persisted by the worker. */
	modelApiKey?: string;
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

export interface AgentWorkerCapabilityToolResponseMessage {
	type: "capability-tool-response";
	requestId: string;
	result?: AgentToolResult<unknown>;
	error?: { code: string; message: string };
}

export type AgentWorkerRequest =
	| AgentWorkerStartMessage
	| AgentWorkerAbortMessage
	| AgentWorkerHostActionResponseMessage
	| AgentWorkerCapabilityToolResponseMessage;

export interface AgentWorkerEventMessage {
	type: "event";
	phase: AgentExecutionPhase;
	message: string;
	timestamp: number;
}

export interface AgentWorkerHeartbeatMessage {
	type: "heartbeat";
	phase: AgentExecutionPhase;
	timestamp: number;
}

export interface AgentWorkerResultMessage {
	type: "result";
}

export type AgentWorkerResultArtifact =
	| { status: "succeeded"; output: string; transcript: AgentMessage[] }
	| { status: "failed"; error: string };

export interface AgentWorkerErrorMessage {
	type: "error";
	error: string;
}

export interface AgentWorkerHostActionRequestMessage {
	type: "host-action-request";
	requestId: string;
	action: AgentWorkerHostAction;
}

export interface AgentWorkerCapabilityToolRequestMessage {
	type: "capability-tool-request";
	requestId: string;
	toolName: string;
	input: unknown;
}

export type AgentWorkerResponse =
	| AgentWorkerEventMessage
	| AgentWorkerHeartbeatMessage
	| AgentWorkerResultMessage
	| AgentWorkerErrorMessage
	| AgentWorkerHostActionRequestMessage
	| AgentWorkerCapabilityToolRequestMessage;
