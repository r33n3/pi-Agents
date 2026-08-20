import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { bashExecutionToText } from "@earendil-works/pi-agent-core";
import type {
	AssistantTranscriptItem,
	ModelRef,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
	UserTranscriptItem,
} from "@earendil-works/pi-protocol";
import type { PiSessionRuntimeEvent, PromptInput, SteerInput } from "@earendil-works/pi-server";
import type { AgentSession } from "../agent-session.ts";
import type { LiveSessionDelegate } from "./live-session-runtime.ts";

/** Maps the active AgentSession into the protocol surface used by `pi --serve`. */
export class AgentSessionServeDelegate implements LiveSessionDelegate {
	private readonly session: AgentSession;
	private readonly createdAt: number;
	private readonly onDispose: (() => void) | undefined;
	private readonly itemIds = new WeakMap<object, string>();
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
			transcript: this.session.messages.flatMap((message) => this.toTranscriptItem(message)),
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
		return this.session.prompt(input.text);
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
		return this.session.subscribe(() => {
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
				const common = {
					id: this.idFor(message),
					role: "tool" as const,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					input: {},
					content: message.content,
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
