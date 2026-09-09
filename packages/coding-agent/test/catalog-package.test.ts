import { createServer } from "node:http";
import { afterEach, expect, test } from "vitest";
import type { AgentDefinition } from "../src/core/serve/agent-registry.ts";
import type { AgentRoomDefinition } from "../src/core/serve/agent-room-service.ts";
import { prepareCatalogPackage } from "../src/core/serve/catalog-package.ts";
import { withCatalogPublication } from "../src/core/serve/catalog-publication-http.ts";

const agent: AgentDefinition = {
	id: "private-agent-id",
	revision: 9,
	source: "managed",
	name: "Reporter",
	description: "Report research",
	persona: "Use a reviewed template.",
	tools: ["read"],
	capabilities: [
		{
			capabilityId: "email.draft",
			capabilityVersion: 1,
			connectionId: "private-account",
			providerId: "private-provider",
		},
	],
	memory: "notes",
	executor: "harness",
	permissionPolicy: "read-only",
	projectRoot: "C:/private-workspace",
	workspace: ".",
	schedules: [{ id: "private-schedule", prompt: "Send to private-recipient", intervalMinutes: 60, enabled: true }],
	browserWorkflows: [],
	delegateAgentIds: [],
	a2a: { enabled: true },
	model: { provider: "private-model-account", id: "private-model" },
};
const team: AgentRoomDefinition = {
	version: 1,
	id: "private-team-id",
	name: "Reporting team",
	purpose: "Produce research reports",
	members: [{ agentId: agent.id, role: "Reporter" }],
	supervisorAgentId: agent.id,
	memoryStrategy: "team",
	sharedNotes: "private-trip-facts",
	conversationId: "private-history",
	createdAt: 1,
	updatedAt: 2,
	limits: {
		maxRounds: 2,
		maxMessages: 20,
		maxConcurrency: 1,
		maxDurationMs: 5000,
		maxTotalTokens: 10000,
		maxCostUsd: 1,
	},
};

test("exports reusable configuration while omitting private runtime state and account bindings", () => {
	const result = prepareCatalogPackage([agent], team, [], "1.0.0");
	const json = JSON.stringify(result.package);
	expect(json).not.toContain("private-");
	expect(result.package.members[0]).toMatchObject({ instructions: agent.persona, id: "member-1" });
	expect(result.package.tools[1]?.capabilities).toEqual([{ id: "email.draft", version: 1, approval: undefined }]);
	expect(result.package.team?.supervisorMemberId).toBe("member-1");
	expect(result.digest).toBe(prepareCatalogPackage([agent], team, [], "1.0.0").digest);
	expect(result.digest).not.toBe(prepareCatalogPackage([agent], team, [], "1.0.1").digest);
});

test("explicit empty team grants do not acquire agent tools or account capabilities", () => {
	const result = prepareCatalogPackage([agent], { ...team, toolIds: [] }, [], "1.0.0");
	expect(result.package.members[0]?.toolRequirements).toEqual([]);
	expect(result.package.tools).toEqual([]);
});

test("team tool projection excludes account labels, bindings and browser profiles", () => {
	const result = prepareCatalogPackage(
		[agent],
		{ ...team, toolIds: ["private-tool"] },
		[
			{
				id: "private-tool",
				name: "Email (private@example.com)",
				description: "private-description",
				tools: ["email_draft"],
				capabilities: agent.capabilities,
			},
		],
		"1.0.0",
	);
	expect(JSON.stringify(result.package)).not.toContain("private");
	expect(result.package.tools[0]?.requiresConfiguration).toBe(true);
});

test("reports missing dependencies and rejects invalid versions and missing members", () => {
	expect(
		prepareCatalogPackage([agent], { ...team, toolIds: ["missing"], teamIds: ["child"] }, [], "1.0.0").issues,
	).toHaveLength(2);
	expect(() => prepareCatalogPackage([agent], undefined, [], "../bad")).toThrow("version");
	expect(() => prepareCatalogPackage([{ ...agent, id: "other" }], team, [], "1.0.0")).toThrow("member");
});

test("different account assignments stay separate destination binding slots", () => {
	const options = ["account-a", "account-b"].map((id) => ({
		id,
		name: id,
		description: "Account",
		tools: ["email_draft"],
		capabilities: agent.capabilities,
	}));
	const result = prepareCatalogPackage(
		[agent],
		{ ...team, toolIds: options.map((entry) => entry.id) },
		options,
		"1.0.0",
	);
	expect(result.package.tools).toHaveLength(2);
	expect(result.package.members[0]?.toolRequirements).toEqual(["tool-1", "tool-2"]);
	expect(JSON.stringify(result.package)).not.toContain("account-");
});

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

test("HTTP review is authenticated, read-only and never claims a remote publish", async () => {
	const server = createServer(
		withCatalogPublication(
			(_, response) => response.writeHead(404).end(),
			"secret",
			{ list: async () => [agent], get: async (id) => (id === agent.id ? agent : undefined) },
			{
				listDefinitions: () => [team],
				getDefinition: (id) => (id === team.id ? team : undefined),
				listTools: () => [],
			},
		),
	);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	const url = `http://127.0.0.1:${address.port}/catalog-publication`;
	expect((await fetch(url)).status).toBe(401);
	expect((await fetch(`${url}?token=secret`, { method: "POST" })).status).toBe(405);
	expect((await fetch(`${url}?token=secret&kind=agent&id=missing`)).status).toBe(404);
	const result = await fetch(`${url}?token=secret&kind=team&id=${team.id}`);
	expect(result.headers.get("cache-control")).toBe("no-store");
	expect(await result.json()).toMatchObject({ package: { kind: "team", name: team.name } });
});
