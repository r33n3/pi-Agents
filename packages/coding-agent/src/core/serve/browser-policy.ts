import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type BrowserAccess = "disabled" | "loopback" | "public-web" | "private-network";

/** Validates the browser navigation policy before a driver receives a URL. */
export class BrowserPolicy {
	readonly #access: BrowserAccess;

	constructor(access: BrowserAccess) {
		this.#access = access;
	}

	get access(): BrowserAccess {
		return this.#access;
	}

	assertNavigation(urlText: string): URL {
		if (this.#access === "disabled") throw new Error("Browser access is disabled for this owner");
		let url: URL;
		try {
			url = new URL(urlText);
		} catch {
			throw new Error("Browser navigation requires an absolute URL");
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("Browser navigation only supports http and https URLs");
		}
		if (this.#access === "public-web") return url;
		if (this.#access === "loopback" && isLoopbackHost(url.hostname)) return url;
		if (this.#access === "private-network" && (isLoopbackHost(url.hostname) || isPrivateAddress(url.hostname))) {
			return url;
		}
		throw new Error(`Browser policy ${this.#access} does not allow ${url.hostname}`);
	}

	/** Resolves every hostname before navigation so policy is not bypassed by private DNS answers. */
	async assertResolvedNavigation(urlText: string): Promise<URL> {
		const url = this.assertNavigation(urlText);
		if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) return url;
		const addresses = await lookup(url.hostname, { all: true, verbatim: true });
		if (addresses.length === 0) throw new Error(`Browser could not resolve ${url.hostname}`);
		for (const { address } of addresses) {
			if (!isResolvedAddressAllowed(address, this.#access)) {
				throw new Error(`Browser policy ${this.#access} does not allow resolved address ${address}`);
			}
		}
		return url;
	}
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
	if (isIP(normalized) !== 4) return false;
	const [first] = normalized.split(".");
	return first === "127";
}

function isPrivateAddress(host: string): boolean {
	const normalized = host.replace(/^\[|\]$/g, "");
	if (isIP(normalized) !== 4) return false;
	const octets = normalized.split(".").map(Number);
	const [first, second] = octets;
	return (
		first === 10 ||
		(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 169 && second === 254)
	);
}

function isResolvedAddressAllowed(address: string, access: BrowserAccess): boolean {
	if (access === "disabled") return false;
	if (access === "loopback") return isLoopbackHost(address);
	if (access === "private-network")
		return isLoopbackHost(address) || isPrivateAddress(address) || isPrivateIpv6(address);
	return !isLoopbackHost(address) && !isPrivateAddress(address) && !isPrivateIpv6(address);
}

function isPrivateIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
