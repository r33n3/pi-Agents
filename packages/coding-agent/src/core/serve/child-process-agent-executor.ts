import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ModelRef } from "@earendil-works/pi-protocol";
import { killProcessTree } from "../../utils/shell.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionListener,
	AgentExecutionResult,
	AgentExecutor,
} from "./agent-executor.ts";
import type { AgentWorkerRequest, AgentWorkerResponse } from "./agent-worker-protocol.ts";

export interface ChildProcessAgentExecutorOptions {
	agentDir: string;
	serveRoot: string;
	capabilityToolNames: (context: AgentExecutionContext) => string[];
	timeoutMs?: number;
	workerPath?: string;
	defaultModel?: ModelRef;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const ABORT_GRACE_MS = 2_000;

/** Runs every invocation in an OS process so model or tool work cannot block the serve control plane. */
export class ChildProcessAgentExecutor implements AgentExecutor {
	readonly #options: ChildProcessAgentExecutorOptions;
	readonly #executions = new Set<ChildProcessExecution>();
	#disposed = false;

	constructor(options: ChildProcessAgentExecutorOptions) {
		this.#options = options;
	}

	async start(context: AgentExecutionContext): Promise<AgentExecution> {
		if (this.#disposed) throw new Error("Agent executor is disposed");
		const workerPath = this.#options.workerPath ?? defaultWorkerPath();
		const effectiveContext =
			context.definition.model || !this.#options.defaultModel
				? context
				: { ...context, definition: { ...context.definition, model: this.#options.defaultModel } };
		const execution = new ChildProcessExecution(
			workerPath,
			{
				type: "start",
				context: effectiveContext,
				agentDir: this.#options.agentDir,
				serveRoot: this.#options.serveRoot,
				capabilityToolNames: this.#options.capabilityToolNames(effectiveContext),
			},
			this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			() => this.#executions.delete(execution),
		);
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

class ChildProcessExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	readonly #child: ChildProcess;
	readonly #listeners = new Set<AgentExecutionListener>();
	readonly #onDispose: () => void;
	readonly #timeout: NodeJS.Timeout;
	#resolve: (result: AgentExecutionResult) => void = () => {};
	#reject: (error: Error) => void = () => {};
	#settled = false;
	#disposed = false;
	#stderr = "";

	constructor(workerPath: string, start: AgentWorkerRequest, timeoutMs: number, onDispose: () => void) {
		this.#onDispose = onDispose;
		this.result = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.#child = fork(workerPath, [], {
			cwd: start.type === "start" ? start.context.workspace : undefined,
			env: process.env,
			execArgv: process.execArgv,
			serialization: "advanced",
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		this.#child.stderr?.setEncoding("utf8");
		this.#child.stderr?.on("data", (chunk: string) => {
			this.#stderr = `${this.#stderr}${chunk}`.slice(-8192);
		});
		this.#child.on("message", (value: unknown) => this.#handleMessage(value));
		this.#child.once("error", (error) => this.#fail(error));
		this.#child.once("exit", (code, signal) => {
			if (this.#settled) return;
			const detail = this.#stderr.trim();
			this.#fail(
				new Error(
					`Agent worker exited before returning a result (${signal ?? `code ${code ?? "unknown"}`})${detail ? `: ${detail}` : ""}`,
				),
			);
		});
		this.#timeout = setTimeout(() => {
			this.#fail(new Error(`Agent worker timed out after ${timeoutMs}ms`));
			this.#terminate();
		}, timeoutMs);
		this.#child.send(start);
	}

	subscribe(listener: AgentExecutionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async abort(): Promise<void> {
		if (this.#settled) return;
		this.#child.send({ type: "abort" } satisfies AgentWorkerRequest);
		await Promise.race([
			this.result.then(
				() => undefined,
				() => undefined,
			),
			new Promise<void>((resolve) => setTimeout(resolve, ABORT_GRACE_MS)),
		]);
		if (!this.#settled) this.#terminate();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#timeout);
		if (!this.#settled) await this.abort();
		if (!this.#settled) this.#fail(new Error("Agent worker was disposed"));
		this.#listeners.clear();
		this.#onDispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#handleMessage(value: unknown): void {
		if (!isWorkerResponse(value)) return;
		if (value.type === "event") {
			for (const listener of this.#listeners) listener(value.message);
			return;
		}
		if (value.type === "error") {
			this.#fail(new Error(value.error));
			return;
		}
		if (this.#settled) return;
		this.#settled = true;
		clearTimeout(this.#timeout);
		this.#resolve({ output: value.output, transcript: value.transcript });
	}

	#fail(error: Error): void {
		if (this.#settled) return;
		this.#settled = true;
		clearTimeout(this.#timeout);
		this.#reject(error);
	}

	#terminate(): void {
		const pid = this.#child.pid;
		if (pid !== undefined) killProcessTree(pid);
	}
}

function defaultWorkerPath(): string {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return fileURLToPath(new URL(`./agent-worker.${extension}`, import.meta.url));
}

function isWorkerResponse(value: unknown): value is AgentWorkerResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return type === "event" || type === "result" || type === "error";
}
