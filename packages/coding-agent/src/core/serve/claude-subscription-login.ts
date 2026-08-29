import { type ChildProcess, spawn } from "node:child_process";
import { isClaudeSubscriptionAvailable, resolveClaudeCommand } from "./claude-cli-auth.ts";
import { scopedSubprocessEnvironment } from "./scoped-subprocess-environment.ts";

const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const OUTPUT_LIMIT = 8_000;

export interface ClaudeSubscriptionLoginStatus {
	status: "idle" | "running" | "succeeded" | "failed";
	authenticated: boolean;
	authorizationUrl?: string;
	error?: string;
}

interface ClaudeSubscriptionLoginOptions {
	command?: { executable: string; prefix: string[] };
	isAuthenticated?: () => boolean;
	timeoutMs?: number;
}

/** Owns the one interactive Claude subscription login allowed by a serve host. */
export class ClaudeSubscriptionLogin implements AsyncDisposable {
	readonly #command: { executable: string; prefix: string[] } | undefined;
	readonly #isAuthenticated: () => boolean;
	readonly #timeoutMs: number;
	#process: ChildProcess | undefined;
	#timeout: NodeJS.Timeout | undefined;
	#output = "";
	#status: ClaudeSubscriptionLoginStatus;

	constructor(options: ClaudeSubscriptionLoginOptions = {}) {
		try {
			this.#command = options.command ?? resolveClaudeCommand();
		} catch {
			this.#command = undefined;
		}
		this.#isAuthenticated = options.isAuthenticated ?? isClaudeSubscriptionAvailable;
		this.#timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
		const authenticated = this.#isAuthenticated();
		this.#status = { status: authenticated ? "succeeded" : "idle", authenticated };
	}

	getStatus(): ClaudeSubscriptionLoginStatus {
		if (this.#status.status !== "running") {
			const authenticated = this.#isAuthenticated();
			if (authenticated)
				this.#status = { ...this.#status, status: "succeeded", authenticated: true, error: undefined };
		}
		return { ...this.#status };
	}

	start(): ClaudeSubscriptionLoginStatus {
		if (this.#process) return this.getStatus();
		if (!this.#command) {
			this.#status = { status: "failed", authenticated: false, error: "Claude Code is not installed" };
			return this.getStatus();
		}
		if (this.#isAuthenticated()) {
			this.#status = { status: "succeeded", authenticated: true };
			return this.getStatus();
		}
		const environment = scopedSubprocessEnvironment();
		delete environment.ANTHROPIC_API_KEY;
		delete environment.CLAUDECODE;
		this.#output = "";
		this.#status = { status: "running", authenticated: false };
		const child = spawn(this.#command.executable, [...this.#command.prefix, "auth", "login", "--claudeai"], {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#process = child;
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => this.#capture(chunk));
		child.stderr?.on("data", (chunk: string) => this.#capture(chunk));
		child.once("error", (error) => {
			if (this.#process === child) this.#finish(false, error.message);
		});
		child.once("exit", (code, signal) => {
			if (this.#process !== child) return;
			const authenticated = this.#isAuthenticated();
			this.#finish(
				authenticated,
				authenticated
					? undefined
					: cleanOutput(this.#output) || `Claude login exited with ${signal ?? `code ${code}`}`,
			);
		});
		this.#timeout = setTimeout(() => {
			child.kill();
			this.#finish(false, "Claude subscription login timed out");
		}, this.#timeoutMs);
		this.#timeout.unref();
		return this.getStatus();
	}

	abort(): ClaudeSubscriptionLoginStatus {
		this.#process?.kill();
		this.#finish(false, "Claude subscription login was cancelled");
		return this.getStatus();
	}

	dispose(): Promise<void> {
		this.#process?.kill();
		this.#finish(false, "Claude subscription login was stopped");
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#capture(chunk: string): void {
		this.#output = (this.#output + chunk).slice(-OUTPUT_LIMIT);
		const authorizationUrl = this.#output.match(/https:\/\/[^\s"'<>]+/)?.[0];
		if (authorizationUrl) this.#status = { ...this.#status, authorizationUrl };
	}

	#finish(authenticated: boolean, error?: string): void {
		const authorizationUrl = this.#status.authorizationUrl;
		if (this.#timeout) clearTimeout(this.#timeout);
		this.#timeout = undefined;
		this.#process = undefined;
		this.#status = authenticated
			? { status: "succeeded", authenticated: true, authorizationUrl }
			: { status: "failed", authenticated: false, authorizationUrl, error };
	}
}

function cleanOutput(output: string): string | undefined {
	const cleaned = output
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/https:\/\/[^\s"'<>]+/g, "authorization link")
		.trim();
	return cleaned ? cleaned.slice(-1_000) : undefined;
}
