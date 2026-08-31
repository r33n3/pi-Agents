import type { LookupAddress, LookupAllOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { ReadableStream } from "node:stream/web";
import type * as Undici from "undici";
import { fetch, Response } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchPublicText, lookupPublicAddress } from "../src/core/serve/public-web-fetch.ts";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const lookupAll = lookup as (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;
vi.mock("undici", async (importOriginal) => {
	const original = await importOriginal<typeof Undici>();
	return { ...original, fetch: vi.fn() };
});

afterEach(() => {
	vi.resetAllMocks();
	vi.useRealTimers();
});

describe("bounded public web reads", () => {
	test("retains the final source URL and decodes split UTF-8 chunks", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/page" } }));
		async function* body() {
			yield new Uint8Array([0xe2]);
			yield new Uint8Array([0x82, 0xac]);
		}
		vi.mocked(fetch).mockResolvedValueOnce(new Response(body(), { headers: { "content-type": "text/plain" } }));
		await expect(fetchPublicText("https://example.com/start")).resolves.toMatchObject({
			url: "https://example.com/page",
			text: "€",
		});
	});

	test("stops oversized streamed bodies before consuming all chunks", async () => {
		let produced = 0;
		const cancelled = vi.fn();
		const body = new ReadableStream({
			pull(controller) {
				produced++;
				controller.enqueue(new Uint8Array(512_000));
			},
			cancel: cancelled,
		});
		vi.mocked(fetch).mockResolvedValueOnce(new Response(body));
		await expect(fetchPublicText("https://example.com/")).rejects.toThrow("exceeds 2 MB");
		expect(produced).toBeLessThanOrEqual(5);
		expect(cancelled).toHaveBeenCalledOnce();
	});

	test("rejects declared oversize and closes unused bodies", async () => {
		const cancelled = vi.fn();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-length": "3000000" } }),
		);
		await expect(fetchPublicText("https://example.com/")).rejects.toThrow("exceeds 2 MB");
		expect(cancelled).toHaveBeenCalledOnce();
	});

	test.each(["http://127.0.0.1/", "http://169.254.169.254/", "https://user:password@example.com/"])(
		"rejects unsafe initial URL %s",
		async (url) => {
			await expect(fetchPublicText(url)).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	test("rejects a redirect to private addresses and cancels its body", async () => {
		const cancelled = vi.fn();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(new ReadableStream({ cancel: cancelled }), {
				status: 302,
				headers: { location: "http://192.168.0.1/" },
			}),
		);
		await expect(fetchPublicText("https://example.com/")).rejects.toThrow("does not allow");
		expect(fetch).toHaveBeenCalledOnce();
		expect(cancelled).toHaveBeenCalledOnce();
	});

	test("bounds redirect loops", async () => {
		vi.mocked(fetch).mockImplementation(
			async () => new Response(null, { status: 302, headers: { location: "/again" } }),
		);
		await expect(fetchPublicText("https://example.com/")).rejects.toThrow("five redirects");
		expect(fetch).toHaveBeenCalledTimes(6);
	});

	test("times out a stalled body and cancels its reader", async () => {
		vi.useFakeTimers();
		const cancelled = vi.fn();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				new ReadableStream({
					pull() {
						return new Promise(() => {});
					},
					cancel: cancelled,
				}),
			),
		);
		const result = expect(fetchPublicText("https://example.com/")).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(30_000);
		await result;
		expect(cancelled).toHaveBeenCalledOnce();
	});

	test("honors user cancellation while awaiting headers", async () => {
		const abort = new AbortController();
		vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
		const result = expect(fetchPublicText("https://example.com/", abort.signal)).rejects.toThrow("User stopped");
		abort.abort(new Error("User stopped"));
		await result;
	});

	test("rejects a private DNS answer at the actual socket lookup", async () => {
		vi.mocked(lookupAll).mockResolvedValue([
			{ address: "8.8.8.8", family: 4 },
			{ address: "127.0.0.1", family: 4 },
		]);
		await new Promise<void>((resolve) =>
			lookupPublicAddress("example.com", { all: true }, (error) => {
				expect(error?.message).toContain("does not allow");
				resolve();
			}),
		);
	});

	test("passes only validated DNS answers directly to the socket", async () => {
		vi.mocked(lookupAll).mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
		await new Promise<void>((resolve) =>
			lookupPublicAddress("example.com", { all: true }, (error, addresses) => {
				expect(error).toBeNull();
				expect(addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
				resolve();
			}),
		);
	});
});
