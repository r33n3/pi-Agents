import Type from "typebox";
import { describe, expect, test } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { DirectToolExecution } from "../src/core/serve/direct-tool-execution.ts";

describe("DirectToolExecution", () => {
	test("validates and dispatches the exact backend arguments once, retaining its output", async () => {
		const calls: unknown[] = [];
		const tool: ToolDefinition = {
			name: "backend",
			label: "Backend",
			description: "Backend",
			parameters: Type.Object({ prompt: Type.String(), model: Type.String() }),
			async execute(_id, parameters) {
				calls.push(parameters);
				return { content: [{ type: "text", text: "backend result" }], details: {} };
			},
		};
		expect(() => new DirectToolExecution(tool, "bad", { prompt: "task" }, {} as ExtensionContext)).toThrow();
		expect(calls).toEqual([]);
		const execution = new DirectToolExecution(
			tool,
			"run",
			{ prompt: "exact task", model: "chosen-model" },
			{} as ExtensionContext,
		);
		expect(await execution.result).toMatchObject({
			output: "backend result",
			transcript: [{ toolName: "backend", toolCallId: "run" }],
		});
		expect(calls).toEqual([{ prompt: "exact task", model: "chosen-model" }]);
		await execution.dispose();
	});

	test("passes cancellation to the backend and does not report an aborted result as success", async () => {
		let observed: AbortSignal | undefined;
		const tool: ToolDefinition = {
			name: "backend",
			label: "Backend",
			description: "Backend",
			parameters: Type.Object({}),
			async execute(_id, _parameters, signal) {
				observed = signal;
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { content: [{ type: "text", text: "cancelled" }], details: {} };
			},
		};
		const execution = new DirectToolExecution(tool, "run", {}, {} as ExtensionContext);
		await Promise.resolve();
		await execution.abort();
		expect(observed?.aborted).toBe(true);
		await expect(execution.result).rejects.toThrow();
	});
});
