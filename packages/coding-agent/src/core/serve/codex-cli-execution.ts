import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentExecution,
	AgentExecutionEvent,
	AgentExecutionListener,
	AgentExecutionResult,
} from "./agent-executor.ts";

const STDERR_LIMIT = 16_000;

/** Runs one Codex CLI task using the CLI's own ChatGPT subscription authentication. */
export class CodexCliExecution implements AgentExecution {
	readonly result: Promise<AgentExecutionResult>;
	readonly #listeners = new Set<AgentExecutionListener>();
	readonly #process: ChildProcess;
	#settled = false;
	#disposed = false;
	#heartbeat: NodeJS.Timeout;

	constructor(input: { cwd: string; prompt: string; model: string }) {
		const command = resolveCodexCommand();
		const environment = { ...process.env };
		// Codex supports both ChatGPT and API-key authentication. This execution profile is
		// explicitly subscription-backed, so an inherited API key must never change billing.
		delete environment.OPENAI_API_KEY;
		delete environment.OPENAI_ORG_ID;
		const args = [
			...command.prefix,
			"exec",
			"--json",
			"--ephemeral",
			"--skip-git-repo-check",
			"--sandbox",
			"workspace-write",
			"--cd",
			input.cwd,
			"--model",
			input.model,
			input.prompt,
		];
		this.#process = spawn(command.executable, args, {
			cwd: input.cwd,
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#heartbeat = setInterval(() => {
			this.#emit({
				kind: "heartbeat",
				phase: "generating",
				message: "Codex CLI is running",
				timestamp: Date.now(),
			});
		}, 5_000);
		this.#heartbeat.unref();
		this.result = this.#collectResult();
	}

	subscribe(listener: AgentExecutionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	abort(): Promise<void> {
		if (!this.#settled) this.#process.kill();
		return Promise.resolve();
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		await this.abort();
		clearInterval(this.#heartbeat);
		this.#listeners.clear();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	async #collectResult(): Promise<AgentExecutionResult> {
		let stdout = "";
		let stderr = "";
		let lastMessage = "";
		this.#process.stdout?.setEncoding("utf8");
		this.#process.stderr?.setEncoding("utf8");
		this.#process.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			for (const line of stdout.split(/\r?\n/).slice(0, -1)) {
				const event = parseCodexEvent(line);
				if (event.message) lastMessage = event.message;
				if (event.type) {
					this.#emit({
						kind: "progress",
						phase: event.type.includes("command") ? "running-tool" : "generating",
						message: event.type,
						timestamp: Date.now(),
					});
				}
			}
			const newline = stdout.lastIndexOf("\n");
			if (newline >= 0) stdout = stdout.slice(newline + 1);
		});
		this.#process.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_LIMIT);
		});
		try {
			const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
				this.#process.once("error", reject);
				this.#process.once("exit", (code, signal) => resolve({ code, signal }));
			});
			if (stdout.trim()) {
				const event = parseCodexEvent(stdout.trim());
				if (event.message) lastMessage = event.message;
			}
			if (exit.code !== 0) {
				const detail = stderr.trim() || `Codex CLI exited with ${exit.signal ?? `code ${exit.code}`}`;
				throw new Error(detail);
			}
			if (!lastMessage) throw new Error("Codex CLI completed without an agent response");
			return { output: lastMessage, transcript: [] satisfies AgentMessage[] };
		} finally {
			this.#settled = true;
			clearInterval(this.#heartbeat);
		}
	}

	#emit(event: AgentExecutionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

export function isCodexCliAvailable(): boolean {
	try {
		resolveCodexCommand();
		return true;
	} catch {
		return false;
	}
}

export function isCodexSubscriptionAvailable(): boolean {
	try {
		const command = resolveCodexCommand();
		const environment = { ...process.env };
		delete environment.OPENAI_API_KEY;
		delete environment.OPENAI_ORG_ID;
		const result = spawnSync(command.executable, [...command.prefix, "login", "status"], {
			env: environment,
			encoding: "utf8",
			timeout: 5_000,
			windowsHide: true,
		});
		return result.status === 0 && /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`);
	} catch {
		return false;
	}
}

function resolveCodexCommand(): { executable: string; prefix: string[] } {
	if (process.platform !== "win32") return { executable: "codex", prefix: [] };
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
		if (existsSync(entry)) return { executable: process.execPath, prefix: [entry] };
	}
	throw new Error("Codex CLI is not installed or is not available on PATH");
}

function parseCodexEvent(line: string): { type?: string; message?: string } {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
		const event = value as Record<string, unknown>;
		const item =
			typeof event.item === "object" && event.item !== null && !Array.isArray(event.item)
				? (event.item as Record<string, unknown>)
				: undefined;
		return {
			type: typeof event.type === "string" ? event.type : undefined,
			message: item?.type === "agent_message" && typeof item.text === "string" ? item.text : undefined,
		};
	} catch {
		return {};
	}
}
