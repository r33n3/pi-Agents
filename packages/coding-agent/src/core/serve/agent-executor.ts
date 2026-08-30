import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "../agent-session.ts";
import type { AgentDefinition } from "./agent-registry.ts";

export interface AgentExecutionContext {
	runId: string;
	definition: AgentDefinition;
	workspace: string;
	prompt: string;
}

export interface AgentExecutionResult {
	output: string;
	transcript: readonly AgentMessage[];
}

export type AgentExecutionPhase =
	| "initializing"
	| "waiting-for-model"
	| "generating"
	| "running-tool"
	| "writing-results";

export interface AgentExecutionEvent {
	kind: "progress" | "heartbeat";
	phase: AgentExecutionPhase;
	message: string;
	timestamp: number;
}

export type AgentExecutionListener = (event: AgentExecutionEvent) => void;

export interface AgentExecution extends AsyncDisposable {
	readonly result: Promise<AgentExecutionResult>;
	subscribe(listener: AgentExecutionListener): () => void;
	abort(): Promise<void>;
	dispose(): Promise<void>;
}

export interface AgentExecutor extends AsyncDisposable {
	start(context: AgentExecutionContext): Promise<AgentExecution>;
	dispose(): Promise<void>;
}

export type IsolatedSessionFactory = (context: AgentExecutionContext) => Promise<AgentSession>;

/** Runs each agent invocation in a fresh AgentSession with its own workspace and transcript. */
export class AgentSessionExecutor implements AgentExecutor {
	readonly #factory: IsolatedSessionFactory;
	readonly #executions = new Set<SessionExecution>();
	#disposed = false;

	constructor(factory: IsolatedSessionFactory) {
		this.#factory = factory;
	}

	async start(context: AgentExecutionContext): Promise<AgentExecution> {
		if (this.#disposed) throw new Error("Agent executor is disposed");
		const session = await this.#factory(context);
		const execution = new SessionExecution(session, context, () => this.#executions.delete(execution));
		this.#executions.add(execution);
		return execution;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await Promise.all([...this.#executions].map((execution) => execution.dispose()));
		this.#executions.clear();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class SessionExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	readonly #session: AgentSession;
	readonly #listeners = new Set<AgentExecutionListener>();
	readonly #unsubscribe: () => void;
	readonly #onDispose: () => void;
	#disposed = false;

	constructor(session: AgentSession, context: AgentExecutionContext, onDispose: () => void) {
		this.#session = session;
		this.#onDispose = onDispose;
		this.#unsubscribe = session.subscribe((event) =>
			this.#emit({
				kind: "progress",
				phase: sessionEventPhase(event.type),
				message: event.type,
				timestamp: Date.now(),
			}),
		);
		this.result = this.#run(context);
	}

	subscribe(listener: AgentExecutionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {
		await this.#session.abort();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.#session.abort();
		this.#unsubscribe();
		this.#session.dispose();
		this.#listeners.clear();
		this.#onDispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #run(context: AgentExecutionContext): Promise<AgentExecutionResult> {
		const instructions = [
			`You are the locally deployed agent "${context.definition.name}".`,
			`Persona: ${context.definition.persona}`,
			`Mission: ${context.definition.description}`,
			"Operate only through the provided tools. All tool paths are confined to your assigned workspace.",
			`Task: ${context.prompt}`,
		].join("\n\n");
		try {
			await this.#session.prompt(instructions, { source: "rpc" });
			return agentExecutionResultFromMessages(this.#session.messages);
		} finally {
			this.#emit({ kind: "progress", phase: "writing-results", message: "settled", timestamp: Date.now() });
		}
	}

	#emit(event: AgentExecutionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function sessionEventPhase(type: string): AgentExecutionPhase {
	if (type.startsWith("tool_execution_")) return "running-tool";
	if (type.includes("message_update") || type.includes("text_delta") || type.includes("thinking_delta")) {
		return "generating";
	}
	return "waiting-for-model";
}

export function agentExecutionResultFromMessages(messages: readonly AgentMessage[]): AgentExecutionResult {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			throw new Error(message.errorMessage || "Agent model request failed");
		}
		if (message.stopReason === "aborted") {
			throw new Error(message.errorMessage || "Agent model request was aborted");
		}
		return {
			output: message.content
				.filter((entry) => entry.type === "text")
				.map((entry) => entry.text)
				.join("\n"),
			transcript: [...messages],
		};
	}
	throw new Error("Agent model returned no assistant response");
}
