import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { Agent, fetch } from "undici";
import { BrowserPolicy } from "./browser-policy.ts";

const policy = new BrowserPolicy("public-web");
const MAX_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

// Validate the DNS answers actually used by the socket, not a separate preflight lookup.
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
	lookup(hostname, { all: true, verbatim: true, family: options.family }).then(
		(addresses) => {
			try {
				if (addresses.length === 0) throw new Error(`Provider host ${hostname} has no addresses`);
				for (const { address, family } of addresses) {
					policy.assertNavigation(`http://${family === 6 ? `[${address}]` : address}/`);
				}
				callback(null, options.all ? addresses : addresses[0]!.address, addresses[0]!.family);
			} catch (error) {
				callback(error instanceof Error ? error : new Error(String(error)), "");
			}
		},
		(error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ""),
	);
};

const dispatcher = new Agent({ connect: { lookup: lookupPublicAddress, timeout: REQUEST_TIMEOUT_MS } });

export interface PublicWebResponse {
	url: string;
	contentType: string;
	text: string;
	fetchedAt: string;
}

/** A credential-free public HTTP read, bounded across redirects, headers, and decoded body bytes. */
export async function fetchPublicText(
	urlText: string,
	signal?: AbortSignal,
	headers: Record<string, string> = {},
): Promise<PublicWebResponse> {
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new Error("Provider request timed out after 30 seconds")),
		REQUEST_TIMEOUT_MS,
	);
	const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
	try {
		let url = urlText;
		for (let redirects = 0; redirects <= 5; redirects++) {
			requestSignal.throwIfAborted();
			const target = policy.assertNavigation(url);
			if (target.username || target.password) throw new Error("Public provider URLs must not contain credentials");
			const response = await abortable(
				fetch(target, {
					dispatcher,
					redirect: "manual",
					signal: requestSignal,
					headers: { "user-agent": "pi-agents-local/1.0", ...headers },
				}),
				requestSignal,
			);
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				void response.body?.cancel().catch(() => {});
				const location = response.headers.get("location");
				if (!location) throw new Error("Provider redirect did not include a location");
				url = new URL(location, target).href;
				continue;
			}
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				throw new Error(`Provider request failed with HTTP ${response.status}`);
			}
			if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
				void response.body?.cancel().catch(() => {});
				throw new Error("Provider response exceeds 2 MB");
			}
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let bytes = 0;
			let text = "";
			try {
				while (reader) {
					const chunk = await abortable(reader.read(), requestSignal);
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (bytes > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds 2 MB");
					text += decoder.decode(chunk.value, { stream: true });
				}
				text += decoder.decode();
			} finally {
				void reader?.cancel().catch(() => {});
				reader?.releaseLock();
			}
			return {
				url: target.href,
				contentType: response.headers.get("content-type") ?? "",
				text,
				fetchedAt: new Date().toISOString(),
			};
		}
		throw new Error("Provider request exceeded five redirects");
	} finally {
		clearTimeout(timer);
		timeout.abort();
	}
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
		if (signal.aborted) abort();
	});
}
