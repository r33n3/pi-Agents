import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, streamSimple } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
};
const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	for (const body of bodies.splice(0)) {
		try {
			body.close();
		} catch {
			/* Already closed or errored. */
		}
	}
	await vi.advanceTimersByTimeAsync(0);
	vi.useRealTimers();
});

function transport(requestId = "req_test") {
	let body!: ReadableStreamDefaultController<Uint8Array>;
	let signal: AbortSignal | null | undefined;
	const response = new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				body = controller;
				bodies.push(controller);
			},
		}),
		{ headers: { "content-type": "text/event-stream", "x-request-id": requestId } },
	);
	// Deliberately ignores cancellation: the adapter must still finish promptly.
	const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
		signal = init?.signal;
		return response;
	});
	return {
		fetch,
		body,
		get signal() {
			return signal;
		},
		send(event: object) {
			body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
		},
	};
}

describe("OpenAI Responses stream health", () => {
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
		"rejects invalid deadlines before dispatch without triggering retries: %s",
		async (timeoutMs) => {
			const http = transport();
			const result = await stream(model, context, { apiKey: "test", fetch: http.fetch, timeoutMs }).result();
			expect(result.errorMessage).toContain("Invalid Responses request deadline");
			expect(http.fetch).not.toHaveBeenCalled();
			expect(isRetryableAssistantError(result)).toBe(false);
		},
	);

	it("times out a partial tool call, aborts transport, and leaves retry to the caller", async () => {
		const http = transport();
		const response = stream(model, context, { apiKey: "test", fetch: http.fetch, timeoutMs: 1000 });
		const events: AssistantMessageEvent[] = [];
		const consume = (async () => {
			for await (const event of response) events.push(event);
		})();
		http.send({
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				id: "fc_test",
				call_id: "call_test",
				name: "configure_agent",
				arguments: "",
			},
		});
		http.send({ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"name":"research' });
		await vi.advanceTimersByTimeAsync(1001);
		const result = await response.result();
		await consume;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("idle timeout: no events for 1000ms");
		expect(result.errorMessage).toContain("events=2; last=response.function_call_arguments.delta");
		expect(result.errorMessage).toContain("request=req_test");
		expect(result.errorMessage).not.toContain("research");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(http.signal?.aborted).toBe(true);
		expect(http.fetch).toHaveBeenCalledTimes(1);
		expect(events.some((event) => event.type === "toolcall_end" || event.type === "done")).toBe(false);
		expect(result.content[0]).not.toHaveProperty("partialJson");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("resets idleness for each event and completes at a terminal event without waiting for EOF", async () => {
		const http = transport();
		const response = streamSimple(model, context, { apiKey: "test", fetch: http.fetch, timeoutMs: 1000 });
		await vi.advanceTimersByTimeAsync(0);
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(700);
			http.send({ type: "response.in_progress", response: { id: "resp_test" } });
			await vi.advanceTimersByTimeAsync(0);
		}
		http.send({ type: "response.completed", response: { id: "resp_test", status: "completed" } });
		await vi.advanceTimersByTimeAsync(0);
		expect((await response.result()).stopReason).toBe("stop");
		expect(http.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("uses a five-minute default and bounds silence before the first event", async () => {
		const http = transport();
		const response = stream(model, context, { apiKey: "test", fetch: http.fetch });
		await vi.advanceTimersByTimeAsync(300001);
		expect((await response.result()).errorMessage).toContain("idle timeout: no events for 300000ms");
		expect(http.signal?.aborted).toBe(true);
	});

	it.each([
		{
			type: "response.incomplete",
			response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
			expected: "length",
		},
		{
			type: "response.failed",
			response: { status: "failed", error: { code: "invalid_request", message: "Invalid tool schema" } },
			expected: "error",
		},
	])("preserves $type semantics without waiting for EOF", async ({ type, response: terminalResponse, expected }) => {
		const http = transport();
		const response = stream(model, context, { apiKey: "test", fetch: http.fetch, timeoutMs: 1000 });
		http.send({ type, response: { id: "resp_test", ...terminalResponse } });
		const result = await response.result();
		expect(result.stopReason).toBe(expected);
		expect(isRetryableAssistantError(result)).toBe(false);
		expect(http.signal?.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, 1000])(
		"honors user cancellation with timeoutMs=%s even when the transport ignores it",
		async (timeoutMs) => {
			const http = transport();
			const controller = new AbortController();
			const response = stream(model, context, {
				apiKey: "test",
				fetch: http.fetch,
				signal: controller.signal,
				timeoutMs,
			});
			await vi.advanceTimersByTimeAsync(0);
			if (timeoutMs === 0) {
				await vi.advanceTimersByTimeAsync(600000);
				expect(http.signal?.aborted).toBe(false);
			}
			controller.abort();
			const result = await response.result();
			expect(result.stopReason).toBe("aborted");
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(http.signal?.aborted).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("reports nested transport codes without exposing cause objects or unsafe request identifiers", async () => {
		const http = transport("https://secret.invalid/?token=private");
		const response = stream(model, context, { apiKey: "test", fetch: http.fetch, timeoutMs: 1000 });
		await vi.advanceTimersByTimeAsync(0);
		http.body.error(
			new TypeError("terminated", {
				cause: {
					code: "UND_ERR_SOCKET",
					headers: { authorization: "Bearer private" },
					cause: { code: "ECONNRESET", body: "private" },
				},
			}),
		);
		const result = await response.result();
		expect(result.errorMessage).toContain("OpenAI Responses stream interrupted: terminated");
		expect(result.errorMessage).toContain("transport=UND_ERR_SOCKET,ECONNRESET");
		expect(result.errorMessage).not.toContain("private");
		expect(result.errorMessage).not.toContain("request=");
		expect(isRetryableAssistantError(result)).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
