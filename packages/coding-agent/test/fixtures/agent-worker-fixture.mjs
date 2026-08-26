import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let timer;
let activePrompt;
let requestCounter = 0;
const pendingHostActions = new Map();
const pendingCapabilityTools = new Map();

process.on("message", (message) => {
	if (message?.type === "capability-tool-response") {
		const pending = pendingCapabilityTools.get(message.requestId);
		if (!pending) return;
		pendingCapabilityTools.delete(message.requestId);
		if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
		else pending.resolve(message.result);
		return;
	}
	if (message?.type === "host-action-response") {
		const pending = pendingHostActions.get(message.requestId);
		if (!pending) return;
		pendingHostActions.delete(message.requestId);
		if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
		else pending.resolve(message.result);
		return;
	}
	if (message?.type === "abort") {
		if (activePrompt === "ignore-abort") return;
		clearTimeout(timer);
		for (const pending of pendingHostActions.values()) pending.reject(new Error("aborted"));
		pendingHostActions.clear();
		process.send?.({ type: "error", error: "aborted" });
		process.disconnect?.();
		return;
	}
	if (message?.type !== "start") return;
	activePrompt = message.context.prompt;
	process.send?.({ type: "event", message: "started" });
	if (["filesystem", "escape", "host-action-slow", "host-action-crash"].includes(activePrompt)) {
		void runHostActionScenario(message);
		return;
	}
	if (activePrompt === "capability") {
		void runCapabilityScenario(message);
		return;
	}
	timer = setTimeout(async () => {
		const output =
			message.context.prompt === "inspect"
				? JSON.stringify({
						cwd: process.cwd(),
						allowed: process.env.PI_TEST_ALLOWED,
						provider: process.env.OPENAI_API_KEY,
						googleAccess: process.env.GOOGLE_OAUTH_ACCESS_TOKEN,
						firecrawlKey: process.env.FIRECRAWL_API_KEY,
						firecrawlUrl: process.env.FIRECRAWL_BASE_URL,
						searxngUrl: process.env.SEARXNG_BASE_URL,
						modelCredentialReceived: typeof message.modelApiKey === "string" && message.modelApiKey.length > 0,
						secret: process.env.PI_TEST_UNRELATED_SECRET,
						pid: process.pid,
					})
				: message.context.prompt;
		const transcript =
			message.context.prompt === "large"
				? [{ role: "assistant", content: [{ type: "text", text: "x".repeat(2_000_000) }] }]
				: [];
		await mkdir(dirname(message.resultPath), { recursive: true });
		await writeFile(message.resultPath, JSON.stringify({ output, transcript }));
		process.send?.({ type: "result" });
		process.disconnect?.();
	}, ["slow", "ignore-abort"].includes(message.context.prompt) ? 5_000 : message.context.prompt === "medium" ? 500 : 10);
});

async function runHostActionScenario(message) {
	if (activePrompt === "host-action-crash") {
		process.send?.(
			{
				type: "host-action-request",
				requestId: `request-${++requestCounter}`,
				action: { family: "filesystem.read", path: "slow.txt" },
			},
			() => process.exit(7),
		);
		return;
	}
	let output;
	try {
		if (activePrompt === "filesystem") {
			output = await Promise.all([
				requestHostAction({ family: "filesystem.read", path: "input.txt" }),
				requestHostAction({ family: "filesystem.list", path: "." }),
				requestHostAction({ family: "filesystem.write", path: "nested/output.txt", content: "written by worker" }),
			]);
		} else if (activePrompt === "escape") {
			output = await requestHostAction({ family: "filesystem.write", path: "../escaped.txt", content: "escape" });
		} else {
			output = await requestHostAction({ family: "filesystem.read", path: "slow.txt" });
		}
	} catch (error) {
		output = { error: error instanceof Error ? error.message : String(error), code: error?.code };
	}
	await mkdir(dirname(message.resultPath), { recursive: true });
	await writeFile(message.resultPath, JSON.stringify({ output: JSON.stringify(output), transcript: [] }));
	process.send?.({ type: "result" });
	process.disconnect?.();
}

async function runCapabilityScenario(message) {
	const tool = message.capabilityTools.find((entry) => entry.name === "test_capability");
	const result = await requestCapabilityTool(tool.name, { value: "worker input" });
	await mkdir(dirname(message.resultPath), { recursive: true });
	await writeFile(message.resultPath, JSON.stringify({ output: JSON.stringify(result), transcript: [] }));
	process.send?.({ type: "result" });
	process.disconnect?.();
}

function requestCapabilityTool(toolName, input) {
	const requestId = `capability-${++requestCounter}`;
	return new Promise((resolve, reject) => {
		pendingCapabilityTools.set(requestId, { resolve, reject });
		process.send?.({ type: "capability-tool-request", requestId, toolName, input }, (error) => {
			if (!error) return;
			pendingCapabilityTools.delete(requestId);
			reject(error);
		});
	});
}

function requestHostAction(action) {
	const requestId = `request-${++requestCounter}`;
	return new Promise((resolve, reject) => {
		pendingHostActions.set(requestId, { resolve, reject });
		process.send?.({ type: "host-action-request", requestId, action }, (error) => {
			if (!error) return;
			pendingHostActions.delete(requestId);
			reject(error);
		});
	});
}
