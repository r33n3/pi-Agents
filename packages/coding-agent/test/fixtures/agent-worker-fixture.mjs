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
	timer = setTimeout(() => {
		process.send?.({ type: "result", output: message.context.prompt, transcript: [] });
		process.disconnect?.();
	}, message.context.prompt === "slow" ? 5_000 : 10);
});
