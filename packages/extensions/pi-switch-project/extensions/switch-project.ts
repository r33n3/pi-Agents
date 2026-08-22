/**
 * `/cd <path>` — switch pi to a different project directory.
 *
 * pi has no live in-place cwd switch: SessionManager.getCwd() has no setter, and
 * AgentSessionRuntime.cwd is fixed at process startup and read by every session
 * operation (newSession/fork/switchSession). That's a real architectural choice
 * (cwd threads through trust store, session storage paths, AGENTS.md discovery),
 * not a missing convenience. This command doesn't fight that; it automates
 * the workaround that already works: relaunch pi in the target directory and
 * resume this same session there via --session <id>. Resuming a session whose
 * stored cwd doesn't match the process cwd is a path pi's own interactive mode
 * already handles (see handleResumeSession's MissingSessionCwdError recovery).
 */

import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SESSION_FLAGS_WITH_VALUE = new Set(["--session", "--session-id", "--fork", "--session-dir"]);
const SESSION_FLAGS_BOOLEAN = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);

export function stripSessionArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (SESSION_FLAGS_WITH_VALUE.has(arg)) {
			i++; // also skip its value
			continue;
		}
		if (SESSION_FLAGS_BOOLEAN.has(arg)) {
			continue;
		}
		out.push(arg);
	}
	return out;
}

/** Strip one layer of matching surrounding quotes, e.g. from a pasted `"C:\path with spaces"`. */
export function unquote(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cd", {
		description: "Switch pi to a different project directory, resuming this conversation there",
		handler: async (args, ctx) => {
			const target = unquote(args);
			if (!target) {
				ctx.ui.notify("Usage: /cd <path>", "error");
				return;
			}

			const resolved = resolvePath(ctx.cwd, target);
			if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
				ctx.ui.notify(`Not a directory: ${resolved}`, "error");
				return;
			}

			// SessionManager computes this.sessionFile (a path) as soon as the session object
			// exists, well before anything is actually written — the file itself is only
			// created lazily on the session's first appended entry. getSessionFile() being
			// truthy therefore does NOT mean there's anything on disk yet to resume; check
			// existence explicitly or a very-early /cd (before any entry) hands --session an
			// id with no file behind it, and the relaunched pi exits with "No session found".
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionIsPersisted = sessionFile !== undefined && existsSync(sessionFile);
			const relaunchArgs = [...process.execArgv, ...stripSessionArgs(process.argv.slice(1))];

			if (sessionIsPersisted) {
				relaunchArgs.push("--session", ctx.sessionManager.getSessionId());
			} else {
				ctx.ui.notify(
					"No persisted session for this conversation — /cd will open a fresh session in the new directory instead of resuming.",
					"warning",
				);
			}

			if (process.platform === "win32") {
				// On Windows, `detached: true` does NOT give the child its own console — it only
				// affects process-group/signal behavior. With stdio "inherit" the child shares the
				// parent's console, so once this process exits, the owning shell (PowerShell) just
				// regains its prompt — even if the child is technically still alive, it has no
				// visible/attached console left to run its TUI in. `cmd /c start` explicitly opens
				// a new, independent console window, which is the standard fix for this on Windows.
				ctx.ui.notify(`Switching to ${resolved} in a new window...`, "info");
				// "cmd /k" instead of running node directly: keeps the new window open after the
				// launched process exits (whether that's a normal interactive exit or a startup
				// crash) instead of the window flashing shut the instant node exits — needed both
				// so a crash is actually visible and so exiting the session normally drops you into
				// a plain prompt in the new directory instead of just closing.
				spawn("cmd.exe", ["/c", "start", "", "/D", resolved, "cmd", "/k", process.argv[0], ...relaunchArgs], {
					cwd: resolved,
					env: process.env,
					detached: true,
					stdio: "ignore",
					windowsHide: false,
				}).unref();
			} else {
				ctx.ui.notify(`Switching to ${resolved}...`, "info");
				const child = spawn(process.argv[0], relaunchArgs, {
					cwd: resolved,
					env: process.env,
					stdio: "inherit",
					detached: true,
				});
				child.unref();
			}

			ctx.shutdown();
		},
	});
}
