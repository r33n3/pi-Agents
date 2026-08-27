/**
 * Delegate a task to your local Claude Code CLI over ACP (Agent Client Protocol).
 *
 * Spawns `@agentclientprotocol/claude-agent-acp` (which wraps the Claude Agent SDK and
 * reuses the `claude` CLI's existing login) as a child process, speaks ACP over
 * its stdio, and keeps one session alive per project directory so follow-up
 * calls with the same model continue the same Claude Code conversation instead of starting cold.
 *
 * All permission requests (file edits, bash commands, etc.) are auto-approved —
 * this is an unattended delegation tool, not a supervised one.
 */

import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as acp from "@agentclientprotocol/sdk";

const require = createRequire(import.meta.url);

const STDERR_TAIL_LIMIT = 4000;

interface SessionHandle {
	connection: InstanceType<typeof acp.ClientSideConnection>;
	sessionId: string;
	proc: ChildProcess;
	onChunk?: (text: string) => void;
	stderrTail: string;
}

type ClaudeAuthenticationMode = "subscription" | "api-key";

const sessions = new Map<string, Promise<SessionHandle>>();

function resolveAgentEntry(): string {
	return require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
}

function pickPermissionOption(options: acp.RequestPermissionRequest["options"]): string {
	const allowOnce = options.find((o) => o.kind === "allow_once");
	if (allowOnce) return allowOnce.optionId;
	const anyAllow = options.find((o) => o.kind.startsWith("allow"));
	if (anyAllow) return anyAllow.optionId;
	return options[0].optionId;
}

class AutoApproveClient implements acp.Client {
	constructor(private handle: { onChunk?: (text: string) => void }) {}

	async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		return {
			outcome: {
				outcome: "selected",
				optionId: pickPermissionOption(params.options),
			},
		};
	}

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const update = params.update;
		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			this.handle.onChunk?.(update.content.text);
		}
	}

	async writeTextFile(): Promise<acp.WriteTextFileResponse> {
		throw new Error("claude-code-acp extension: client-side fs writes are not enabled; Claude Code uses its own tools");
	}

	async readTextFile(): Promise<acp.ReadTextFileResponse> {
		throw new Error("claude-code-acp extension: client-side fs reads are not enabled; Claude Code uses its own tools");
	}
}

async function createSession(cwd: string, model: string, authentication: ClaudeAuthenticationMode): Promise<SessionHandle> {
	if (!existsSync(cwd)) {
		throw new Error(`claude_code: cwd does not exist: ${cwd}`);
	}

	const agentEntry = resolveAgentEntry();
	// pi may itself be launched from inside a Claude Code terminal/session, in which case
	// CLAUDECODE=1 is inherited from the parent shell. That's a false positive here: pi is
	// not a Claude Code runtime, so the SDK's nested-session guard must not see that var.
	const env = { ...process.env };
	delete env.CLAUDECODE;
	if (authentication === "subscription") {
		// Claude Code supports subscription and API-key authentication. Keep the
		// subscription profile deterministic even when the parent Pi shell has an API key.
		delete env.ANTHROPIC_API_KEY;
		delete env.ANTHROPIC_AUTH_TOKEN;
		delete env.ANTHROPIC_BASE_URL;
		delete env.ANTHROPIC_CUSTOM_HEADERS;
		delete env.CLAUDE_CODE_USE_BEDROCK;
		delete env.CLAUDE_CODE_USE_VERTEX;
	}
	// Default delegated sessions to Sonnet 5 (bare id, no "[1m]" — the 1M context window
	// isn't needed for typical delegated tasks) at medium thinking. 8192 is the "medium"
	// token budget pi itself uses across providers (see packages/ai/src/api/*.ts). Only
	// applied when the caller's own shell hasn't already set these.
	env.ANTHROPIC_MODEL = model;
	if (!env.MAX_THINKING_TOKENS) env.MAX_THINKING_TOKENS = "8192";
	const proc = spawn(process.execPath, [agentEntry], {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const handle: SessionHandle = { connection: undefined as any, sessionId: "", proc, stderrTail: "" };

	// child_process 'error' (bad cwd, exe missing, permission denied, ...) is an EventEmitter
	// event, not a thrown/rejected value. With no listener it becomes an uncaught exception
	// that crashes pi's whole process, not just this tool call — so this listener must always
	// be attached, and errorPromise must be pre-caught so it's never "unhandled" regardless of
	// whether the startup race below or a later runtime failure is what fires it.
	let lastSpawnError: Error | undefined;
	const errorPromise = new Promise<never>((_, reject) => {
		proc.on("error", (err) => {
			lastSpawnError = err;
			reject(err);
		});
	});
	errorPromise.catch(() => {});

	// claude-agent-acp logs its own diagnostics (including "Unexpected case" warnings for
	// SDK message subtypes it doesn't recognize yet) straight to stderr. Those are noise on
	// the happy path, so capture a tail instead of passing them through to pi's terminal —
	// surfaced only if the session actually fails.
	proc.stderr?.on("data", (chunk: Buffer) => {
		handle.stderrTail = (handle.stderrTail + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
	});

	const input = Writable.toWeb(proc.stdin!);
	const output = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
	const stream = acp.ndJsonStream(input, output);
	const client = new AutoApproveClient(handle);
	const connection = new acp.ClientSideConnection(() => client, stream);
	handle.connection = connection;

	const sessionKey = `${cwd}\0${model}\0${authentication}`;
	proc.on("exit", () => {
		sessions.delete(sessionKey);
	});

	try {
		await Promise.race([
			(async () => {
				await connection.initialize({
					protocolVersion: acp.PROTOCOL_VERSION,
					clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
				});
				const session = await connection.newSession({ cwd, mcpServers: [] });
				handle.sessionId = session.sessionId;
			})(),
			errorPromise,
		]);
	} catch (err) {
		proc.kill();
		const effectiveErr = lastSpawnError ?? err;
		const stderrNote = handle.stderrTail.trim() ? `\n\nclaude-agent-acp stderr (tail):\n${handle.stderrTail}` : "";
		throw effectiveErr instanceof Error
			? new Error(`${effectiveErr.message}${stderrNote}`, { cause: effectiveErr })
			: new Error(`${String(effectiveErr)}${stderrNote}`);
	}

	return handle;
}

function getSession(cwd: string, model: string, authentication: ClaudeAuthenticationMode): Promise<SessionHandle> {
	const sessionKey = `${cwd}\0${model}\0${authentication}`;
	let pending = sessions.get(sessionKey);
	if (!pending) {
		pending = createSession(cwd, model, authentication).catch((err) => {
			sessions.delete(sessionKey);
			throw err;
		});
		sessions.set(sessionKey, pending);
	}
	return pending;
}

const claudeCodeTool = defineTool({
	name: "claude_code",
	label: "Claude Code (ACP)",
	description:
		"Delegate a task to your local Claude Code CLI via ACP for a specific project directory. " +
		"Claude Code works the task through with its own tools (read/write/edit/bash) and reports back " +
		"when done. All of its actions are auto-approved with no per-action confirmation — only use this " +
		"for tasks you're comfortable letting Claude Code carry out unattended. Sessions persist per " +
		"project directory and model, so matching follow-up calls continue the prior conversation.",
	executionMode: "sequential",
	parameters: Type.Object({
		prompt: Type.String({ description: "The task or instruction to hand off to Claude Code" }),
		cwd: Type.Optional(
			Type.String({ description: "Project directory for Claude Code to work in (defaults to pi's current working directory)" }),
		),
		model: Type.Optional(
			Type.String({ description: "Claude model id for this ACP session (defaults to claude-sonnet-5)" }),
		),
		authentication: Type.Optional(
			Type.Union([Type.Literal("subscription"), Type.Literal("api-key")], {
				description:
					"Authentication profile. Subscription removes ANTHROPIC_API_KEY before launching Claude Code; api-key inherits it.",
			}),
		),
	}),

	async execute(_toolCallId, params, _signal, onUpdate, ctx) {
		const cwd = params.cwd ? resolvePath(ctx.cwd, params.cwd) : ctx.cwd;
		const model = (params.model ?? "claude-sonnet-5").replace(/^anthropic\//, "");
		const authentication = params.authentication ?? "subscription";
		const handle = await getSession(cwd, model, authentication);

		let buffer = "";
		handle.onChunk = (text) => {
			buffer += text;
			onUpdate?.({ content: [{ type: "text", text: buffer }], details: {} });
		};

		try {
			const result = await handle.connection.prompt({
				sessionId: handle.sessionId,
				prompt: [{ type: "text", text: params.prompt }],
			});

			return {
				content: [{ type: "text", text: buffer || "(Claude Code produced no text output)" }],
				details: { stopReason: result.stopReason, cwd, model, authentication },
			};
		} catch (err) {
			const stderrNote = handle.stderrTail.trim() ? `\n\nclaude-agent-acp stderr (tail):\n${handle.stderrTail}` : "";
			throw err instanceof Error
				? new Error(`${err.message}${stderrNote}`, { cause: err })
				: new Error(`${String(err)}${stderrNote}`);
		} finally {
			handle.onChunk = undefined;
			// In one-shot modes there's no future turn to reuse this session for, and the
			// kept-alive child process (open stdio pipes) would otherwise block pi's own
			// process from exiting once the prompt is done.
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				sessions.delete(`${cwd}\0${model}\0${authentication}`);
				handle.proc.kill();
			}
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(claudeCodeTool);

	pi.on("session_shutdown", async () => {
		for (const pending of sessions.values()) {
			try {
				const handle = await pending;
				handle.proc.kill();
			} catch {
				// already failed to start; nothing to clean up
			}
		}
		sessions.clear();
	});
}
