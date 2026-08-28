import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type { AgentWorkerRequest, AgentWorkerResultArtifact } from "../../src/core/serve/agent-worker-protocol.ts";

process.on("message", (message: AgentWorkerRequest) => {
	if (message.type !== "start") return;
	setCapabilityOverrides({ trueColor: false });
	void writeResult(message.resultPath);
});

async function writeResult(resultPath: string): Promise<void> {
	const artifact: AgentWorkerResultArtifact = {
		status: "succeeded",
		output: "workspace imports resolved",
		transcript: [],
	};
	await mkdir(dirname(resultPath), { recursive: true });
	await writeFile(resultPath, JSON.stringify(artifact), "utf8");
	process.send?.({ type: "result" });
	process.disconnect?.();
}
