import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { PlaywrightBrowserDriver } from "../core/serve/playwright-browser-driver.ts";

/** Handles standalone browser installation commands without starting a Pi session. */
export async function runBrowserCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "browser") return false;
	const command = args[1];
	if (command === "status" && args.length === 2) {
		const status = new PlaywrightBrowserDriver().installationStatus();
		process.stdout.write(
			`${JSON.stringify({ browser: "chromium", installed: status.installed, executablePath: status.executablePath })}\n`,
		);
		return true;
	}
	if (command === "install" && args.length === 3 && args[2] === "chromium") {
		const require = createRequire(import.meta.url);
		const cliPath = join(dirname(require.resolve("playwright/package.json")), "cli.js");
		process.exitCode = await run(process.execPath, [cliPath, "install", "chromium"]);
		return true;
	}
	process.stderr.write("Usage: pi browser status | pi browser install chromium\n");
	process.exitCode = 1;
	return true;
}

function run(command: string, args: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}
