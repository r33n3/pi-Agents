import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { bashExecutionToText } from "@earendil-works/pi-agent-core";
import type {
	AssistantTranscriptItem,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	ToolTranscriptItem,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	type PiSessionRuntimeEvent,
	type PromptInput,
	type SteerInput,
	sanitizeProtocolDetails,
	toProtocolJsonValue,
} from "@earendil-works/pi-server";
import type { AgentSession } from "../agent-session.ts";
import type { LiveSessionDelegate } from "./live-session-runtime.ts";

/** Maps the active AgentSession into the protocol surface used by `pi --serve`. */
export class AgentSessionServeDelegate implements LiveSessionDelegate {
	private readonly session: AgentSession;
	private readonly createdAt: number;
	private readonly onDispose: (() => void) | undefined;
	private readonly itemIds = new WeakMap<object, string>();
	private readonly runningTools = new Map<string, ToolTranscriptItem>();
	private revision = 0;

	constructor(session: AgentSession, createdAt = Date.now(), onDispose?: () => void) {
		this.session = session;
		this.createdAt = createdAt;
		this.onDispose = onDispose;
	}

	snapshot(): SessionSnapshot {
		const model = this.requireModel();
		return {
			id: this.session.sessionId,
			name: this.session.sessionName,
			cwd: this.session.sessionManager.getCwd(),
			createdAt: this.createdAt,
			updatedAt: Date.now(),
			phase: this.getPhase(),
			model,
			thinkingLevel: this.session.thinkingLevel,
			attached: true,
			locked: !this.session.isIdle,
			revision: this.revision,
			transcript: [
				...this.session.messages.flatMap((message) => this.toTranscriptItem(message)),
				...this.runningTools.values(),
			],
			queuedSteer: this.session.getSteeringMessages().map((text) => ({
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			})),
			queuedSteerCount: this.session.pendingMessageCount,
		};
	}

	getPhase(): SessionPhase {
		if (this.session.retryAttempt > 0) return "retry";
		if (this.session.isCompacting) return "compaction";
		return this.session.isIdle ? "idle" : "turn";
	}

	prompt(input: PromptInput): Promise<void> {
		return runSupervisedSessionPrompt(this.session, () => this.session.prompt(input.text));
	}

	steer(input: SteerInput): Promise<void> {
		return this.session.steer(input.text);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	async setModel(model: ModelRef): Promise<void> {
		const resolved = this.session.modelRuntime.getModel(model.provider, model.id);
		if (!resolved) throw new Error(`Unknown model: ${model.provider}/${model.id}`);
		await this.session.setModel(resolved);
	}

	setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		this.session.setThinkingLevel(thinkingLevel);
		return Promise.resolve();
	}

	subscribe(listener: (event: PiSessionRuntimeEvent) => void): () => void {
		return this.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				this.runningTools.set(event.toolCallId, {
					id: event.toolCallId,
					role: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: toProtocolJsonValue(event.args),
					content: [],
					status: "running",
					isError: false,
					timestamp: Date.now(),
				});
			} else if (event.type === "tool_execution_update") {
				const current = this.runningTools.get(event.toolCallId);
				const details = this.toolResultDetails(event.partialResult);
				this.runningTools.set(event.toolCallId, {
					id: current?.id ?? event.toolCallId,
					role: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					input: toProtocolJsonValue(event.args),
					content: this.toolResultContent(event.partialResult),
					...(details === undefined ? {} : { details }),
					status: "running",
					isError: false,
					timestamp: current?.timestamp ?? Date.now(),
				});
			} else if (event.type === "tool_execution_end") {
				this.runningTools.delete(event.toolCallId);
			}
			this.revision++;
			listener({ type: "snapshot" });
		});
	}

	dispose(): Promise<void> {
		this.onDispose?.();
		return Promise.resolve();
	}

	private requireModel(): ModelRef {
		const model = this.session.model;
		if (!model) throw new Error("Cannot serve a session without a selected model");
		return { provider: model.provider, id: model.id };
	}

	private toTranscriptItem(message: AgentMessage): TranscriptItem[] {
		switch (message.role) {
			case "user":
				return [
					{
						id: this.idFor(message),
						role: "user",
						content: this.userContent(message.content),
						timestamp: message.timestamp,
					},
				];
			case "assistant":
				return [this.assistantItem(message)];
			case "toolResult": {
				const details = sanitizeProtocolDetails(message.details);
				const common = {
					id: this.idFor(message),
					role: "tool" as const,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					input: this.toolInput(message.toolCallId),
					content: message.content,
					...(details === undefined ? {} : { details }),
					usage: message.usage,
					timestamp: message.timestamp,
				};
				return [
					message.isError
						? { ...common, status: "error" as const, isError: true as const }
						: { ...common, status: "complete" as const, isError: false as const },
				];
			}
			case "bashExecution":
				return [
					{
						id: this.idFor(message),
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(message) }],
						timestamp: message.timestamp,
					},
				];
			case "custom":
				return message.display
					? [
							{
								id: this.idFor(message),
								role: "user",
								content: this.userContent(message.content),
								timestamp: message.timestamp,
							},
						]
					: [];
			case "branchSummary":
			case "compactionSummary":
				return [
					{
						id: this.idFor(message),
						role: "user",
						content: [{ type: "text", text: message.summary }],
						timestamp: message.timestamp,
					},
				];
		}
	}

	private toolInput(toolCallId: string): ToolTranscriptItem["input"] {
		for (let index = this.session.messages.length - 1; index >= 0; index--) {
			const message = this.session.messages[index];
			if (message?.role !== "assistant") continue;
			const call = message.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
			if (call?.type === "toolCall") return toProtocolJsonValue(call.arguments);
		}
		return {};
	}

	private toolResultContent(value: unknown): ToolTranscriptItem["content"] {
		if (typeof value !== "object" || value === null || !("content" in value) || !Array.isArray(value.content)) {
			return [];
		}
		const content: ToolTranscriptItem["content"] = [];
		for (const part of value.content) {
			if (typeof part !== "object" || part === null || !("type" in part)) continue;
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				content.push({ type: "text", text: part.text });
				continue;
			}
			if (
				part.type === "image" &&
				"data" in part &&
				typeof part.data === "string" &&
				"mimeType" in part &&
				typeof part.mimeType === "string"
			) {
				content.push({ type: "image", data: part.data, mimeType: part.mimeType });
			}
		}
		return content;
	}

	private toolResultDetails(value: unknown): ToolTranscriptItem["details"] {
		if (typeof value !== "object" || value === null || !("details" in value)) return undefined;
		return sanitizeProtocolDetails(value.details);
	}

	private assistantItem(message: Extract<AgentMessage, { role: "assistant" }>): AssistantTranscriptItem {
		const content = message.content.map((part) => {
			if (part.type === "text") return { type: "text" as const, text: part.text };
			if (part.type === "thinking") return { type: "thinking" as const, thinking: part.thinking };
			return { type: "toolCall" as const, toolCallId: part.id, toolName: part.name, input: part.arguments };
		});
		const common = {
			id: this.idFor(message),
			role: "assistant" as const,
			content,
			model: { provider: message.provider, id: message.model },
			responseModel: message.responseModel,
			usage: message.usage,
			timestamp: message.timestamp,
		};
		if (message.stopReason === "error")
			return { ...common, status: "error", stopReason: "error", errorMessage: message.errorMessage };
		if (message.stopReason === "aborted")
			return { ...common, status: "aborted", stopReason: "aborted", errorMessage: message.errorMessage };
		if (message.stopReason === "length") return { ...common, status: "complete", stopReason: "length" };
		return { ...common, status: "complete", stopReason: message.stopReason === "toolUse" ? "toolUse" : "stop" };
	}

	private userContent(
		content: Extract<AgentMessage, { role: "user" | "custom" }>["content"],
	): UserTranscriptItem["content"] {
		return typeof content === "string" ? [{ type: "text", text: content }] : content;
	}

	private idFor(message: object): string {
		let id = this.itemIds.get(message);
		if (!id) {
			id = randomUUID();
			this.itemIds.set(message, id);
		}
		return id;
	}
}

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

export async function runSupervisedSessionPrompt(
	session: AgentSession,
	prompt: () => Promise<void>,
	idleTimeoutMs = DEFAULT_SESSION_IDLE_TIMEOUT_MS,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	let rejectStalled: (error: Error) => void = () => {};
	const stalled = new Promise<never>((_resolve, reject) => {
		rejectStalled = reject;
	});
	const resetWatchdog = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void session.abort().catch(() => undefined);
			rejectStalled(new Error(`Pi session made no progress for ${idleTimeoutMs}ms`));
		}, idleTimeoutMs);
		timer.unref();
	};
	const unsubscribe = session.subscribe(resetWatchdog);
	resetWatchdog();
	try {
		await Promise.race([prompt(), stalled]);
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}
