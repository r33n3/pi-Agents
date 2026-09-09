import { createHash } from "node:crypto";
import type { AgentDefinition } from "./agent-registry.ts";
import type { AgentRoomDefinition } from "./agent-room-service.ts";
import type { CatalogPackage, CatalogPackageReview } from "./catalog-package-contract.ts";
import { teamMemberProfile } from "./team-member-profile.ts";
import type { TeamToolOption } from "./team-resources.ts";

/** Explicit projection: never serialize a live agent, team, connection, or run wholesale. */
export function prepareCatalogPackage(
	agents: readonly AgentDefinition[],
	team: AgentRoomDefinition | undefined,
	catalog: readonly TeamToolOption[],
	version: string,
): CatalogPackageReview {
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version.length > 32)
		throw new Error("Enter a version such as 1.0.0");
	if (!agents.length || (!team && agents.length !== 1)) throw new Error("Select one saved agent or team");
	const issues = new Set<string>();
	const tools: CatalogPackage["tools"] = [];
	const slots = new Map<string, string>();
	const toolSlot = (id: string, fallback?: AgentDefinition): string => {
		const entry = catalog.find((item) => item.id === id);
		const requirements = {
			tools: entry?.tools ?? (fallback ? [id] : []),
			capabilities: (entry?.capabilities ?? []).map((grant) => ({
				id: grant.capabilityId,
				version: grant.capabilityVersion,
				approval: grant.approval,
			})),
			requiresConfiguration: Boolean(!entry || entry.capabilities.length || entry.browser || entry.workflow),
		};
		if (!entry && !fallback) issues.add("An assigned team tool is missing from the environment catalog.");
		if (entry?.browser || entry?.workflow)
			issues.add("Browser profiles, site preferences, and recorded workflows require a destination binding.");
		if (requirements.tools.some((name) => /^(saved_|data_tool|report_tool)/.test(name)))
			issues.add(
				"Reusable tool implementations and templates must be packaged separately; this package contains requirements only.",
			);
		// Distinct local bindings remain distinct configuration slots, without exporting their IDs.
		const existing = slots.get(id);
		if (existing) return existing;
		const slot = `tool-${tools.length + 1}`;
		slots.set(id, slot);
		tools.push({ id: slot, ...requirements });
		return slot;
	};
	const sourceMembers = team?.members ?? [{ agentId: agents[0]!.id, role: "Agent" }];
	const members = sourceMembers.map((member, index) => {
		const agent = agents.find((candidate) => candidate.id === member.agentId);
		if (!agent) throw new Error("A team member no longer exists; update the team before exporting");
		const profile = teamMemberProfile(agent, member, team?.toolIds);
		if (!profile.description.trim() || !profile.instructions.trim())
			issues.add(`${profile.name}: add a purpose and instructions before publishing.`);
		if (agent.delegateAgentIds.length) issues.add("Agent delegation dependencies require a catalog mapping.");
		if (agent.browser || agent.browserWorkflows.length)
			issues.add("Browser profiles, site preferences, and recorded workflows require a destination binding.");
		const inheritsAgent = profile.toolSource === "agent";
		const toolRequirements = profile.assignedToolIds.map((id) => toolSlot(id, inheritsAgent ? agent : undefined));
		// Standalone capability grants are separate from raw tools. Account IDs never travel.
		if (inheritsAgent)
			for (const grant of agent.capabilities) {
				const slot = `tool-${tools.length + 1}`;
				tools.push({
					id: slot,
					tools: [],
					capabilities: [{ id: grant.capabilityId, version: grant.capabilityVersion, approval: grant.approval }],
					requiresConfiguration: true,
				});
				toolRequirements.push(slot);
			}
		const assignedTools = tools.filter((tool) => toolRequirements.includes(tool.id)).flatMap((tool) => tool.tools);
		return {
			id: `member-${index + 1}`,
			name: profile.name,
			description: profile.description,
			role: profile.role,
			instructions: profile.instructions,
			teamInstructions: profile.teamInstructions,
			toolRequirements,
			memory: agent.memory,
			executor: agent.executor,
			permissionPolicy: inheritsAgent
				? agent.permissionPolicy
				: assignedTools.some((tool) => ["write", "edit", "bash", "powershell"].includes(tool))
					? ("workspace-write" as const)
					: ("read-only" as const),
		};
	});
	if (team?.teamIds?.length)
		issues.add("Child teams must be published and mapped before this coordinator can be published.");
	const supervisorIndex = sourceMembers.findIndex((member) => member.agentId === team?.supervisorAgentId);
	if (team?.supervisorAgentId && supervisorIndex < 0)
		issues.add("The supervisor must be a saved member of this team.");
	const memoryPolicy = team?.chatState?.memoryPolicy;
	const pkg: CatalogPackage = {
		schemaVersion: "pi.catalog-package.v1",
		version,
		kind: team ? "team" : "agent",
		name: team?.name ?? agents[0]!.name,
		description: team?.purpose ?? agents[0]!.description,
		members,
		tools,
		...(team
			? {
					team: {
						supervisorMemberId: supervisorIndex < 0 ? undefined : `member-${supervisorIndex + 1}`,
						allowRecruitment: team.allowRecruitment ?? false,
						memoryStrategy: team.memoryStrategy ?? "recent",
						memoryPolicy: memoryPolicy
							? { retain: memoryPolicy.retain, observationTtlHours: memoryPolicy.observationTtlHours }
							: undefined,
						limits: {
							maxRounds: team.limits.maxRounds,
							maxMessages: team.limits.maxMessages,
							maxConcurrency: team.limits.maxConcurrency,
							maxDurationMs: team.limits.maxDurationMs,
							maxTotalTokens: team.limits.maxTotalTokens,
							maxCostUsd: team.limits.maxCostUsd,
						},
						toolRequirements: team.toolIds?.map((id) => toolSlot(id)),
					},
				}
			: {}),
	};
	if (!pkg.description.trim()) issues.add("Add a reusable purpose before publishing.");
	return {
		package: pkg,
		digest: createHash("sha256").update(JSON.stringify(pkg)).digest("hex"),
		issues: [...issues],
		excluded: [
			"Credentials and account bindings",
			"Conversation history and learned memory",
			"Trip facts and shared notes",
			"Schedules, recipients, and sending approvals",
			"Workspace paths and model accounts",
		],
	};
}
