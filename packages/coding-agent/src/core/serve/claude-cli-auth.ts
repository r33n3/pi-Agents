import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Reports whether Claude Code has a subscription login that works without an API key. */
export function isClaudeSubscriptionAvailable(): boolean {
	try {
		const environment = { ...process.env };
		delete environment.ANTHROPIC_API_KEY;
		delete environment.CLAUDECODE;
		const command = resolveClaudeCommand();
		const result = spawnSync(command.executable, [...command.prefix, "auth", "status"], {
			env: environment,
			encoding: "utf8",
			timeout: 5_000,
			windowsHide: true,
		});
		if (result.status !== 0) return false;
		return parseClaudeSubscriptionStatus(result.stdout);
	} catch {
		return false;
	}
}

export function parseClaudeSubscriptionStatus(output: string): boolean {
	try {
		const value: unknown = JSON.parse(output);
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			(value as Record<string, unknown>).loggedIn === true &&
			(value as Record<string, unknown>).authMethod !== "api_key"
		);
	} catch {
		return false;
	}
}

export function resolveClaudeCommand(): { executable: string; prefix: string[] } {
	if (process.platform !== "win32") return { executable: "claude", prefix: [] };
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const executable = join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
		if (existsSync(executable)) return { executable, prefix: [] };
	}
	throw new Error("Claude Code is not installed or is not available on PATH");
}
