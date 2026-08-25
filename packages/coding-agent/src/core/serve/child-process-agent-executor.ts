import { type ChildProcess, fork } from "node:child_process";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelRef } from "@earendil-works/pi-protocol";
import { killProcessTree } from "../../utils/shell.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionListener,
	AgentExecutionResult,
	AgentExecutor,
} from "./agent-executor.ts";
import type {
	AgentWorkerHostAction,
	AgentWorkerHostActionRequestMessage,
	AgentWorkerHostActionResult,
	AgentWorkerRequest,
	AgentWorkerResponse,
	AgentWorkerResultArtifact,
} from "./agent-worker-protocol.ts";
import { GovernedActionCancelledError, type GovernedActionService } from "./governed-action-service.ts";
import { MAX_SCOPED_AGENT_FILE_BYTES, resolveCanonicalWorkspacePath } from "./scoped-agent-tools.ts";

export interface AgentHostFileSystem {
	read(path: string, signal: AbortSignal): Promise<string>;
	list(path: string, signal: AbortSignal): Promise<Array<{ kind: "directory" | "file"; name: string }>>;
	write(path: string, content: string, signal: AbortSignal): Promise<number>;
}

export interface ChildProcessAgentExecutorOptions {
	agentDir: string;
	serveRoot: string;
	capabilityToolNames: (context: AgentExecutionContext) => string[];
	timeoutMs?: number;
	workerPath?: string;
	defaultModel?: ModelRef;
	environment?: NodeJS.ProcessEnv;
	governedActions?: GovernedActionService;
	hostFileSystem?: AgentHostFileSystem;
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
		const modeledContext =
			context.definition.model || !this.#options.defaultModel
				? context
				: { ...context, definition: { ...context.definition, model: this.#options.defaultModel } };
		const effectiveContext = { ...modeledContext, workspace: resolve(modeledContext.workspace) };
		const capabilityToolNames = this.#options.capabilityToolNames(effectiveContext);
		const resultPath = resolve(
			this.#options.serveRoot,
			"runs",
			effectiveContext.definition.id,
			effectiveContext.runId,
			"worker-result.json",
		);
		const execution = new ChildProcessExecution(
			workerPath,
			{
				type: "start",
				context: effectiveContext,
				agentDir: this.#options.agentDir,
				serveRoot: this.#options.serveRoot,
				resultPath,
				capabilityToolNames,
			},
			resultPath,
			this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			workerEnvironment(this.#options.environment ?? process.env, capabilityToolNames),
			effectiveContext,
			this.#options.governedActions,
			this.#options.hostFileSystem ?? localHostFileSystem,
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
	readonly #resultPath: string;
	readonly #timeout: NodeJS.Timeout;
	readonly #exit: Promise<void>;
	readonly #context: AgentExecutionContext;
	readonly #governedActions: GovernedActionService | undefined;
	readonly #hostFileSystem: AgentHostFileSystem;
	readonly #pendingHostActions = new Map<string, AbortController>();
	#resolveExit: () => void = () => {};
	#resolve: (result: AgentExecutionResult) => void = () => {};
	#reject: (error: Error) => void = () => {};
	#settled = false;
	#exited = false;
	#disposed = false;
	#abortPromise: Promise<void> | undefined;
	#stderr = "";

	constructor(
		workerPath: string,
		start: AgentWorkerRequest,
		resultPath: string,
		timeoutMs: number,
		environment: NodeJS.ProcessEnv,
		context: AgentExecutionContext,
		governedActions: GovernedActionService | undefined,
		hostFileSystem: AgentHostFileSystem,
		onDispose: () => void,
	) {
		this.#onDispose = onDispose;
		this.#resultPath = resultPath;
		this.#context = context;
		this.#governedActions = governedActions;
		this.#hostFileSystem = hostFileSystem;
		this.result = new Promise((resolve, reject) => {
			this.#resolve = resolve;
			this.#reject = reject;
		});
		this.#exit = new Promise((resolve) => {
			this.#resolveExit = resolve;
		});
		this.#child = fork(workerPath, [], {
			cwd: start.type === "start" ? start.context.workspace : undefined,
			env: environment,
			execArgv: process.execArgv,
			detached: process.platform !== "win32",
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
			this.#exited = true;
			this.#abortPendingHostActions();
			this.#resolveExit();
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
		this.#child.send(start, (error) => {
			if (error) {
				this.#fail(error);
				this.#terminate();
			}
		});
	}

	subscribe(listener: AgentExecutionListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	abort(): Promise<void> {
		this.#abortPromise ??= this.#stop(true);
		return this.#abortPromise;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#timeout);
		if (!this.#exited) await (this.#settled ? this.#stop(false) : this.abort());
		if (!this.#settled) this.#fail(new Error("Agent worker was disposed"));
		this.#abortPendingHostActions();
		this.#listeners.clear();
		this.#onDispose();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	#handleMessage(value: unknown): void {
		if (!isWorkerResponse(value)) return;
		if (value.type === "host-action-request") {
			let request: AgentWorkerHostActionRequestMessage;
			try {
				request = parseHostActionRequest(value);
			} catch (error) {
				this.#fail(error instanceof Error ? error : new Error(String(error)));
				this.#terminate();
				return;
			}
			void this.#handleHostAction(request);
			return;
		}
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
		this.#abortPendingHostActions();
		clearTimeout(this.#timeout);
		void readWorkerResult(this.#resultPath).then(this.#resolve, this.#reject);
	}

	#fail(error: Error): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#abortPendingHostActions();
		clearTimeout(this.#timeout);
		void unlink(this.#resultPath).catch(() => {});
		this.#reject(error);
	}

	#terminate(): void {
		const pid = this.#child.pid;
		if (pid !== undefined) killProcessTree(pid);
	}

	async #stop(requestAbort: boolean): Promise<void> {
		if (this.#exited) return;
		this.#abortPendingHostActions();
		if (requestAbort && !this.#settled && this.#child.connected) {
			await new Promise<void>((resolve) => {
				this.#child.send({ type: "abort" } satisfies AgentWorkerRequest, () => resolve());
			});
		}
		await Promise.race([this.#exit, delay(ABORT_GRACE_MS)]);
		if (!this.#exited) {
			this.#terminate();
			await Promise.race([this.#exit, delay(ABORT_GRACE_MS)]);
		}
		if (!this.#exited) this.#child.kill("SIGKILL");
		if (requestAbort && !this.#settled) this.#fail(new Error("Agent worker was aborted"));
	}

	async #handleHostAction(request: AgentWorkerHostActionRequestMessage): Promise<void> {
		if (this.#settled || this.#exited) return;
		if (this.#pendingHostActions.has(request.requestId)) {
			this.#sendHostActionError(
				request.requestId,
				"ERR_DUPLICATE_REQUEST",
				"Host action request id is already active",
			);
			return;
		}
		const controller = new AbortController();
		this.#pendingHostActions.set(request.requestId, controller);
		try {
			if (!this.#governedActions)
				throw hostActionError("ERR_HOST_ACTION_UNAVAILABLE", "Host action gateway is unavailable");
			const result = await this.#executeHostAction(request.action, controller.signal);
			if (!controller.signal.aborted && !this.#settled && !this.#exited) {
				this.#sendToChild({ type: "host-action-response", requestId: request.requestId, result });
			}
		} catch (error) {
			if (!controller.signal.aborted && !this.#settled && !this.#exited) {
				const safe = safeHostActionError(error);
				this.#sendHostActionError(request.requestId, safe.code, safe.message);
			}
		} finally {
			this.#pendingHostActions.delete(request.requestId);
		}
	}

	async #executeHostAction(action: AgentWorkerHostAction, signal: AbortSignal): Promise<AgentWorkerHostActionResult> {
		if (!this.#governedActions)
			throw hostActionError("ERR_HOST_ACTION_UNAVAILABLE", "Host action gateway is unavailable");
		const requiredTool = action.family.slice("filesystem.".length);
		let canonicalPath: string | undefined;
		const governed = await this.#governedActions.execute({
			family: action.family,
			target: action,
			identities: {
				actorId: `agent:${this.#context.definition.id}`,
				agentId: this.#context.definition.id,
				attemptId: this.#context.runId,
				computerId: `local-worker:${this.#context.runId}`,
			},
			canonicalize: ({ path }) => ({
				workspace: resolve(this.#context.workspace),
				path:
					relative(resolve(this.#context.workspace), resolve(this.#context.workspace, path)).replace(/\\/g, "/") ||
					".",
			}),
			authorize: async () => {
				if (!this.#context.definition.tools.includes(requiredTool)) {
					return {
						decision: "deny" as const,
						reason: `Agent is not granted the ${requiredTool} tool`,
						grant: "missing",
					};
				}
				if (requiredTool === "write" && this.#context.definition.permissionPolicy !== "workspace-write") {
					return { decision: "deny" as const, reason: "Agent workspace is read-only", policy: "read-only" };
				}
				if (signal.aborted) {
					return { decision: "deny" as const, reason: "Agent worker is stopping", policy: "cancelled" };
				}
				try {
					canonicalPath = await resolveCanonicalWorkspacePath(
						this.#context.workspace,
						action.path,
						requiredTool === "write" ? "write" : "existing",
					);
				} catch {
					return {
						decision: "deny" as const,
						reason: "Requested path is outside the agent workspace",
						policy: "workspace-boundary",
					};
				}
				return {
					decision: "allow" as const,
					reason: "Agent grant and workspace policy allow this action",
					grant: requiredTool,
				};
			},
			dispatch: async () => {
				if (!canonicalPath) throw new Error("Authorized host action has no canonical path");
				throwIfAborted(signal);
				try {
					if (action.family === "filesystem.read") {
						return { family: action.family, content: await this.#hostFileSystem.read(canonicalPath, signal) };
					}
					if (action.family === "filesystem.list") {
						return { family: action.family, entries: await this.#hostFileSystem.list(canonicalPath, signal) };
					}
					return {
						family: action.family,
						bytesWritten: await this.#hostFileSystem.write(canonicalPath, action.content, signal),
					};
				} catch (error) {
					if (signal.aborted || isAbortError(error))
						throw new GovernedActionCancelledError("Agent worker stopped");
					throw error;
				}
			},
		});
		if (governed.status === "denied") {
			throw hostActionError("ERR_GOVERNED_ACTION_DENIED", governed.reason);
		}
		return governed.value;
	}

	#abortPendingHostActions(): void {
		for (const controller of this.#pendingHostActions.values()) controller.abort();
	}

	#sendHostActionError(requestId: string, code: string, message: string): void {
		this.#sendToChild({ type: "host-action-response", requestId, error: { code, message } });
	}

	#sendToChild(message: AgentWorkerRequest): void {
		if (!this.#child.connected || this.#exited) return;
		this.#child.send(message, () => undefined);
	}
}

const localHostFileSystem: AgentHostFileSystem = {
	async read(path, signal) {
		const content = await readFile(path, { signal });
		if (content.byteLength > MAX_SCOPED_AGENT_FILE_BYTES) {
			throw hostActionError("ERR_FILE_TOO_LARGE", "Workspace file exceeds the 1 MiB read limit");
		}
		return content.toString("utf8");
	},
	async list(path, signal) {
		throwIfAborted(signal);
		const entries = await readdir(path, { withFileTypes: true });
		throwIfAborted(signal);
		return entries
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((entry) => ({ kind: entry.isDirectory() ? "directory" : "file", name: entry.name }));
	},
	async write(path, content, signal) {
		if (Buffer.byteLength(content, "utf8") > MAX_SCOPED_AGENT_FILE_BYTES) {
			throw hostActionError("ERR_FILE_TOO_LARGE", "Workspace file exceeds the 1 MiB write limit");
		}
		throwIfAborted(signal);
		await mkdir(dirname(path), { recursive: true });
		throwIfAborted(signal);
		await writeFile(path, content, { encoding: "utf8", signal });
		return Buffer.byteLength(content, "utf8");
	},
};

const RUNTIME_ENVIRONMENT_NAMES = [
	"APPDATA",
	"COMSPEC",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"PATH",
	"PATHEXT",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PI_OFFLINE",
	"PI_SKIP_VERSION_CHECK",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

const CAPABILITY_ENVIRONMENT_NAMES: Readonly<Record<string, readonly string[]>> = {
	searxng_search: ["SEARXNG_BASE_URL"],
	firecrawl_search: ["FIRECRAWL_BASE_URL"],
	firecrawl_scrape: ["FIRECRAWL_BASE_URL"],
	firecrawl_crawl: ["FIRECRAWL_BASE_URL"],
};

function workerEnvironment(source: NodeJS.ProcessEnv, capabilityToolNames: readonly string[]): NodeJS.ProcessEnv {
	const names = new Set<string>(RUNTIME_ENVIRONMENT_NAMES);
	for (const toolName of capabilityToolNames) {
		for (const name of CAPABILITY_ENVIRONMENT_NAMES[toolName] ?? []) names.add(name);
	}
	const environment: NodeJS.ProcessEnv = {};
	for (const name of names) {
		const entry = environmentEntry(source, name);
		if (entry) environment[entry[0]] = entry[1];
	}
	return environment;
}

function environmentEntry(source: NodeJS.ProcessEnv, name: string): [string, string] | undefined {
	const key =
		process.platform === "win32"
			? Object.keys(source).find((entry) => entry.toUpperCase() === name.toUpperCase())
			: name;
	if (!key) return undefined;
	const value = source[key];
	return value === undefined ? undefined : [key, value];
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readWorkerResult(path: string): Promise<AgentExecutionResult> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("Agent worker result artifact is invalid");
		}
		const artifact = value as Partial<AgentWorkerResultArtifact>;
		if (typeof artifact.output !== "string" || !Array.isArray(artifact.transcript)) {
			throw new Error("Agent worker result artifact is invalid");
		}
		return { output: artifact.output, transcript: artifact.transcript as AgentMessage[] };
	} finally {
		await unlink(path).catch(() => {});
	}
}

function defaultWorkerPath(): string {
	const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
	return fileURLToPath(new URL(`./agent-worker.${extension}`, import.meta.url));
}

function isWorkerResponse(value: unknown): value is AgentWorkerResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const type = (value as { type?: unknown }).type;
	return type === "event" || type === "result" || type === "error" || type === "host-action-request";
}

function parseHostActionRequest(value: AgentWorkerResponse): AgentWorkerHostActionRequestMessage {
	if (value.type !== "host-action-request") throw new Error("Worker message is not a host action request");
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.requestId)) {
		throw new Error("Agent worker host action request id is invalid");
	}
	const action = value.action;
	if (typeof action !== "object" || action === null || Array.isArray(action)) {
		throw new Error("Agent worker host action is invalid");
	}
	if (
		typeof action.path !== "string" ||
		action.path.length < 1 ||
		action.path.length > 32 * 1024 ||
		action.path.includes("\0")
	) {
		throw new Error("Agent worker host action path is invalid");
	}
	if (action.family === "filesystem.read" || action.family === "filesystem.list") {
		return { type: value.type, requestId: value.requestId, action: { family: action.family, path: action.path } };
	}
	if (action.family !== "filesystem.write" || typeof action.content !== "string") {
		throw new Error("Agent worker host action family is invalid");
	}
	if (Buffer.byteLength(action.content, "utf8") > MAX_SCOPED_AGENT_FILE_BYTES) {
		throw new Error("Agent worker host action content exceeds the 1 MiB limit");
	}
	return {
		type: value.type,
		requestId: value.requestId,
		action: { family: action.family, path: action.path, content: action.content },
	};
}

function hostActionError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function safeHostActionError(error: unknown): { code: string; message: string } {
	if (error instanceof Error && "code" in error && typeof error.code === "string") {
		const messages: Record<string, string> = {
			ENOENT: "Workspace path was not found",
			EACCES: "Workspace path is not accessible",
			EPERM: "Workspace action is not permitted",
			EISDIR: "Workspace path is a directory",
			ENOTDIR: "Workspace path is not a directory",
			ERR_FILE_TOO_LARGE: error.message,
			ERR_GOVERNED_ACTION_DENIED: error.message,
			ERR_HOST_ACTION_UNAVAILABLE: error.message,
		};
		return { code: error.code, message: messages[error.code] ?? "Host filesystem action failed" };
	}
	return { code: "ERR_HOST_ACTION_FAILED", message: "Host filesystem action failed" };
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new GovernedActionCancelledError("Agent worker stopped");
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ABORT_ERR";
}
