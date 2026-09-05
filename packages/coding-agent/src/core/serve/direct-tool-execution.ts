import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import type { AgentExecution, AgentExecutionListener, AgentExecutionResult } from "./agent-executor.ts";

/** Calls the selected backend once, without an inference turn to choose or rewrite the call. */
export class DirectToolExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	readonly #controller = new AbortController();
	readonly #listeners = new Set<AgentExecutionListener>();

	constructor(tool: ToolDefinition, callId: string, parameters: Record<string, unknown>, context: ExtensionContext) {
		const validated: unknown = validateToolArguments(tool, {
			type: "toolCall",
			id: callId,
			name: tool.name,
			arguments: parameters,
		});
		this.result = Promise.resolve().then(async () => {
			this.#controller.signal.throwIfAborted();
			const result = await tool.execute(
				callId,
				validated,
				this.#controller.signal,
				() => {
					for (const listener of this.#listeners)
						listener({ kind: "progress", phase: "running-tool", message: tool.name, timestamp: Date.now() });
				},
				context,
			);
			this.#controller.signal.throwIfAborted();
			const output = result.content
				.filter((entry) => entry.type === "text")
				.map((entry) => entry.text)
				.join("\n");
			if (!output.trim()) throw new Error(`${tool.name} returned no reviewable result`);
			return {
				output,
				transcript: [
					{
						role: "toolResult",
						toolCallId: callId,
						toolName: tool.name,
						content: result.content,
						isError: false,
						timestamp: Date.now(),
					},
				],
			};
		});
		// The manager may still be persisting admission when a backend fails immediately.
		void this.result.catch(() => {});
	}

	subscribe(listener: AgentExecutionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {
		this.#controller.abort();
		await this.result.catch(() => {});
	}

	async dispose(): Promise<void> {
		await this.abort();
		this.#listeners.clear();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}
