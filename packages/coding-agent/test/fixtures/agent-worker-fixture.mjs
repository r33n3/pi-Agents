import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let timer;

process.on("message", (message) => {
	if (message?.type === "abort") {
		if (process.env.PI_TEST_IGNORE_AGENT_ABORT === "1") return;
		clearTimeout(timer);
		process.send?.({ type: "error", error: "aborted" });
		process.disconnect?.();
		return;
	}
	if (message?.type !== "start") return;
	process.send?.({ type: "event", message: "started" });
	timer = setTimeout(async () => {
		const transcript =
			message.context.prompt === "large"
				? [{ role: "assistant", content: [{ type: "text", text: "x".repeat(2_000_000) }] }]
				: [];
		await mkdir(dirname(message.resultPath), { recursive: true });
		await writeFile(message.resultPath, JSON.stringify({ output: message.context.prompt, transcript }));
		process.send?.({ type: "result" });
		process.disconnect?.();
	}, message.context.prompt === "slow" ? 5_000 : 10);
});
