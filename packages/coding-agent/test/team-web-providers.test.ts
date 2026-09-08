import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CapabilityBroker } from "../src/core/serve/capability-broker.ts";
import { CapabilityProviderRegistry } from "../src/core/serve/capability-provider-registry.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";

test("private search and scrape providers become team tools only after configuration and approval", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-team-web-"));
	const registry = new CapabilityProviderRegistry();
	const credentials = new ProviderEnvironmentStore(root, (id) => registry.provider(id)?.authentication, {
		platform: "linux",
		passphrase: "test-only-private-service-vault",
		environment: {},
	});
	try {
		await credentials.initialize();
		const broker = new CapabilityBroker(join(root, "broker"), {
			activeToolNames: () => ["searxng_search", "firecrawl_search", "firecrawl_scrape", "firecrawl_crawl"],
			environmentValue: (name) => credentials.environmentValue(name),
		});
		await broker.initialize();
		const resources = new TeamResources(broker);
		expect(resources.list().some((entry) => entry.id.includes("firecrawl"))).toBe(false);
		await broker.reviewProvider("pi-firecrawl", true);
		await expect(broker.enableProvider("pi-firecrawl", true)).rejects.toThrow("requires configuration");
		expect((await credentials.status("pi-firecrawl")).configured).toBe(false);
		await credentials.configure("pi-firecrawl", { values: { FIRECRAWL_BASE_URL: "http://127.0.0.1:3002" } });
		expect((await credentials.status("pi-firecrawl")).configured).toBe(true);
		await broker.enableProvider("pi-firecrawl", true);
		await credentials.configure("pi-searxng", { values: { SEARXNG_BASE_URL: "http://127.0.0.1:8888" } });
		await broker.reviewProvider("pi-searxng", true);
		await broker.enableProvider("pi-searxng", true);
		const selected = resources.validate(["pi-searxng:web.search", "pi-firecrawl:web.scrape"]);
		const grants = selected.flatMap((entry) => entry.capabilities);
		expect(broker.resolveToolNames(grants, "harness")).toEqual(["searxng_search", "firecrawl_scrape"]);
		expect(resources.list().some((entry) => entry.id === "pi-firecrawl:web.crawl")).toBe(false);
		await credentials.configure("pi-firecrawl", { clear: ["FIRECRAWL_BASE_URL"] });
		expect((await credentials.status("pi-firecrawl")).configured).toBe(false);
		expect(resources.list().some((entry) => entry.id.includes("firecrawl"))).toBe(false);
		await credentials.configure("pi-firecrawl", { values: { FIRECRAWL_API_KEY: "test-only-cloud-key" } });
		expect((await credentials.status("pi-firecrawl")).configured).toBe(true);
		await broker.disableProvider("pi-searxng", true);
		expect(() => resources.validate(["pi-searxng:web.search"])).toThrow("unavailable");
	} finally {
		await credentials.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
