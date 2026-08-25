import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type BrowserAccess = "disabled" | "loopback" | "public-web" | "private-network";

type IpAddressClass = "loopback" | "private-network" | "special-use" | "public-web";

interface IpSubnet {
	address: string;
	prefix: number;
	type: "ipv4" | "ipv6";
}

const LOOPBACK_ADDRESSES = blockList([
	{ address: "127.0.0.0", prefix: 8, type: "ipv4" },
	{ address: "::1", prefix: 128, type: "ipv6" },
]);

const PRIVATE_NETWORK_ADDRESSES = blockList([
	{ address: "10.0.0.0", prefix: 8, type: "ipv4" },
	{ address: "169.254.0.0", prefix: 16, type: "ipv4" },
	{ address: "172.16.0.0", prefix: 12, type: "ipv4" },
	{ address: "192.168.0.0", prefix: 16, type: "ipv4" },
	{ address: "fc00::", prefix: 7, type: "ipv6" },
	{ address: "fe80::", prefix: 10, type: "ipv6" },
]);

// IANA special-purpose registries plus multicast and deprecated IPv6 site-local space.
// These destinations are never safe public-web targets, even when a host OS can route them.
const SPECIAL_USE_ADDRESSES = blockList([
	{ address: "0.0.0.0", prefix: 8, type: "ipv4" },
	{ address: "100.64.0.0", prefix: 10, type: "ipv4" },
	{ address: "192.0.0.0", prefix: 24, type: "ipv4" },
	{ address: "192.0.2.0", prefix: 24, type: "ipv4" },
	{ address: "192.31.196.0", prefix: 24, type: "ipv4" },
	{ address: "192.52.193.0", prefix: 24, type: "ipv4" },
	{ address: "192.88.99.0", prefix: 24, type: "ipv4" },
	{ address: "192.175.48.0", prefix: 24, type: "ipv4" },
	{ address: "198.18.0.0", prefix: 15, type: "ipv4" },
	{ address: "198.51.100.0", prefix: 24, type: "ipv4" },
	{ address: "203.0.113.0", prefix: 24, type: "ipv4" },
	{ address: "224.0.0.0", prefix: 4, type: "ipv4" },
	{ address: "240.0.0.0", prefix: 4, type: "ipv4" },
	{ address: "::", prefix: 128, type: "ipv6" },
	{ address: "64:ff9b::", prefix: 96, type: "ipv6" },
	{ address: "64:ff9b:1::", prefix: 48, type: "ipv6" },
	{ address: "100::", prefix: 64, type: "ipv6" },
	{ address: "100:0:0:1::", prefix: 64, type: "ipv6" },
	{ address: "2001::", prefix: 23, type: "ipv6" },
	{ address: "2001:db8::", prefix: 32, type: "ipv6" },
	{ address: "2002::", prefix: 16, type: "ipv6" },
	{ address: "2620:4f:8000::", prefix: 48, type: "ipv6" },
	{ address: "3fff::", prefix: 20, type: "ipv6" },
	{ address: "5f00::", prefix: 16, type: "ipv6" },
	{ address: "fec0::", prefix: 10, type: "ipv6" },
	{ address: "ff00::", prefix: 8, type: "ipv6" },
]);

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
		if (this.#access === "public-web") {
			const addressClass = classifyIpAddress(url.hostname);
			if (addressClass === undefined || addressClass === "public-web") return url;
		}
		if (this.#access === "loopback" && isLoopbackHost(url.hostname)) return url;
		if (
			this.#access === "private-network" &&
			(isLoopbackHost(url.hostname) || classifyIpAddress(url.hostname) === "private-network")
		) {
			return url;
		}
		throw new Error(`Browser policy ${this.#access} does not allow ${url.hostname}`);
	}

	/** Resolves every hostname before navigation so policy is not bypassed by private DNS answers. */
	async assertResolvedNavigation(urlText: string): Promise<URL> {
		const url = this.assertNavigation(urlText);
		const literalAddress = url.hostname.replace(/^\[|\]$/g, "");
		if (isIP(literalAddress) !== 0) {
			if (!isResolvedAddressAllowed(literalAddress, this.#access)) {
				throw new Error(`Browser policy ${this.#access} does not allow resolved address ${literalAddress}`);
			}
			return url;
		}
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

/** Selects the narrowest browser access class implied by an absolute HTTP(S) URL. */
export function browserAccessForUrl(urlText: string): Exclude<BrowserAccess, "disabled"> {
	let url: URL;
	try {
		url = new URL(urlText);
	} catch {
		throw new Error("Browser navigation requires an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Browser navigation only supports http and https URLs");
	}
	if (isLoopbackHost(url.hostname)) return "loopback";
	const addressClass = classifyIpAddress(url.hostname);
	if (addressClass === "private-network") return "private-network";
	if (addressClass === "special-use") {
		throw new Error(`Browser target ${url.hostname} is special-use and is not permitted`);
	}
	return "public-web";
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
	if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true;
	return classifyIpAddress(normalized) === "loopback";
}

function isResolvedAddressAllowed(address: string, access: BrowserAccess): boolean {
	if (access === "disabled") return false;
	const addressClass = classifyIpAddress(address);
	if (addressClass === undefined) return false;
	if (access === "loopback") return addressClass === "loopback";
	if (access === "private-network") return addressClass === "loopback" || addressClass === "private-network";
	return addressClass === "public-web";
}

function classifyIpAddress(address: string): IpAddressClass | undefined {
	let normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
	const version = isIP(normalized);
	if (version === 0) return undefined;
	if (version === 6) {
		normalized = new URL(`http://[${normalized}]/`).hostname.slice(1, -1);
		if (normalized.startsWith("::ffff:")) return "special-use";
	}
	const type = version === 4 ? "ipv4" : "ipv6";
	if (LOOPBACK_ADDRESSES.check(normalized, type)) return "loopback";
	if (PRIVATE_NETWORK_ADDRESSES.check(normalized, type)) return "private-network";
	if (SPECIAL_USE_ADDRESSES.check(normalized, type)) return "special-use";
	return "public-web";
}

function blockList(subnets: readonly IpSubnet[]): BlockList {
	const result = new BlockList();
	for (const subnet of subnets) result.addSubnet(subnet.address, subnet.prefix, subnet.type);
	return result;
}
