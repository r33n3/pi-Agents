interface BrowserCrypto {
	randomUUID?: () => string;
	getRandomValues(bytes: Uint8Array): Uint8Array;
}

/** Creates an opaque browser identifier without requiring a secure context. */
export function createBrowserId(source: BrowserCrypto = crypto): string {
	if (typeof source.randomUUID === "function") return source.randomUUID();
	const bytes = source.getRandomValues(new Uint8Array(16));
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
