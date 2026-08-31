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

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SESSION_FLAGS_WITH_VALUE = new Set(["--session", "--session-id", "--fork", "--session-dir"]);
const SESSION_FLAGS_BOOLEAN = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);

export function stripSessionArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ([...SESSION_FLAGS_WITH_VALUE].some((flag) => arg.startsWith(`${flag}=`))) continue;
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

/** Data never becomes PowerShell syntax; native arguments use Windows argv quoting, not cmd escaping. */
export function windowsProjectScript(executable: string, args: string[], cwd: string): string {
	for (const value of [executable, cwd, ...args]) {
		if (value.includes("\0")) throw new Error("Project launch values must not contain NUL characters");
	}
	const argumentsText = args.map((arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`).join(" ");
	const payload = Buffer.from(JSON.stringify({ executable, argumentsText, cwd }), "utf8").toString("base64");
	return [
		"$ErrorActionPreference = 'Stop'",
		`$launch = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
		"Set-Location -LiteralPath $launch.cwd",
		"$start = New-Object System.Diagnostics.ProcessStartInfo",
		"$start.FileName = $launch.executable",
		"$start.Arguments = $launch.argumentsText",
		"$start.WorkingDirectory = $launch.cwd",
		"$start.UseShellExecute = $false",
		"$child = [System.Diagnostics.Process]::Start($start)",
		"$child.WaitForExit()",
		"if ($child.ExitCode -ne 0) { Write-Warning ('Pi exited with code ' + $child.ExitCode) }",
	].join("\n");
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
				ctx.ui.notify(`Switching to ${resolved} in a new window...`, "info");
				// A hidden launcher opens the requested interactive window. NoExit preserves a
				// usable prompt and startup diagnostics after Pi exits, without a cmd /k layer.
				const encoded = Buffer.from(
					windowsProjectScript(process.execPath, relaunchArgs, resolved),
					"utf16le",
				).toString("base64");
				const launcher =
					"$ErrorActionPreference = 'Stop'\n" +
					`Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoLogo -NoProfile -NoExit -EncodedCommand ${encoded}' -WindowStyle Normal`;
				try {
					await new Promise<void>((resolve, reject) => {
						const child = spawn(
							"powershell.exe",
							["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")],
							{ cwd: resolved, env: process.env, stdio: "ignore", windowsHide: true },
						);
						child.once("error", reject);
						child.once("exit", (code) =>
							code === 0 ? resolve() : reject(new Error(`Project launcher exited with code ${code}`)),
						);
					});
				} catch (error) {
					ctx.ui.notify(
						`Could not open the new project: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					return;
				}
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
