import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRegistry } from "./agent-registry.ts";
import type { AgentRoomRun, AgentRoomService } from "./agent-room-service.ts";
import type { RoutineExecution } from "./agent-routine-scheduler.ts";
import type { CapabilityApprovalEvidence } from "./capability-approval-service.ts";
import type { CapabilityBroker } from "./capability-broker.ts";
import { matchesCapabilityToken } from "./capability-token.ts";
import type { RoutineDefinition, RoutineRegistry } from "./routine-registry.ts";
import type { TeamResources } from "./team-resources.ts";

/** Keeps unattended team execution and its draft authorization tied to a reviewed configuration. */
export class TeamRoutines {
	private readonly rooms: AgentRoomService;
	private readonly agents: AgentRegistry;
	private readonly resources: TeamResources;
	private readonly broker: CapabilityBroker;
	constructor(rooms: AgentRoomService, agents: AgentRegistry, resources: TeamResources, broker: CapabilityBroker) {
		this.rooms = rooms;
		this.agents = agents;
		this.resources = resources;
		this.broker = broker;
	}

	async review(roomId: string, delivery: "report" | "draft") {
		const visited = new Set<string>();
		const configurations: unknown[] = [];
		let canDraft = false;
		const visit = async (id: string): Promise<void> => {
			if (visited.has(id)) return;
			visited.add(id);
			const room = this.rooms.getDefinition(id);
			if (!room?.supervisorAgentId) throw new Error("Choose a team with a supervisor");
			configurations.push(room);
			for (const member of room.members) {
				const agent = await this.agents.get(member.agentId);
				if (!agent) throw new Error(`Team member ${member.agentId} is unavailable`);
				const seed = this.resources.seed(agent, member.toolIds ?? room.toolIds);
				this.broker.validateGrants(seed.definition.capabilities, seed.definition.executor);
				if (seed.definition.delegateAgentIds.length || seed.definition.browserWorkflows.length)
					throw new Error(
						`Review ${agent.name}: delegated agents and recorded browser workflows require separate automation review`,
					);
				if (seed.definition.tools.some((tool) => ["bash", "powershell", "browser_setup"].includes(tool)))
					throw new Error(
						`Review ${agent.name}: host commands and browser configuration require an interactive run`,
					);
				const grants = seed.definition.capabilities.filter((grant) => {
					if (grant.providerId === "google-workspace" && grant.capabilityId === "email.draft") {
						// Report-only runs retain the configured tool but receive no draft authorization.
						canDraft = true;
						return false;
					}
					return true;
				});
				this.broker.validateUnattendedGrants(grants, seed.definition.executor);
				configurations.push(seed.digest);
			}
			for (const child of room.teamIds ?? []) await visit(child);
		};
		await visit(roomId);
		if (delivery === "draft" && !canDraft)
			throw new Error("Assign a configured Gmail draft tool to a team member first");
		const proof = this.rooms.listRuns(roomId).find((run) => run.status === "completed");
		if (!proof) throw new Error("Complete and review a successful team run before scheduling it");
		return {
			configurationDigest: createHash("sha256")
				.update(
					JSON.stringify(configurations, (_key, value: unknown) =>
						value && typeof value === "object" && !Array.isArray(value)
							? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
							: value,
					),
				)
				.digest("hex"),
			proofRunId: proof.id,
			prompt: proof.goal,
			name: this.rooms.getDefinition(roomId)!.name,
		};
	}

	async validate(definition: RoutineDefinition, executing = false): Promise<void> {
		const target = definition.target;
		if (target.kind !== "team" || (!definition.enabled && !executing)) return;
		if (!target.confirmed) throw new Error("Review and confirm this team's schedule before running it");
		const current = await this.review(target.roomId, target.delivery);
		if (current.configurationDigest !== target.configurationDigest)
			throw new Error("Team configuration changed. Review and save its schedule again before running");
	}

	async start(definition: RoutineDefinition): Promise<RoutineExecution> {
		await this.validate(definition, true);
		if (definition.target.kind !== "team") throw new Error("Expected a team schedule");
		const run = await this.rooms.startRoutine(definition.target.roomId, definition.prompt, {
			id: definition.id,
			revision: definition.revision,
			delivery: definition.target.delivery,
		});
		return {
			runId: run.id,
			cancel: async () => {
				await this.rooms.cancel(run.id);
			},
			completion: this.rooms.waitForCompletion(run.id).then((completed) =>
				completed.status === "completed"
					? {}
					: {
							error: completed.error ?? completed.userQuestion ?? `Team run ${completed.status}`,
						},
			),
		};
	}

	async draftEvidence(run: AgentRoomRun, registry: RoutineRegistry): Promise<CapabilityApprovalEvidence | undefined> {
		if (!run.routine || run.routine.delivery !== "draft" || run.status !== "running") return undefined;
		const definition = await registry.get(run.routine.id);
		if (
			!definition ||
			definition.revision !== run.routine.revision ||
			definition.target.kind !== "team" ||
			definition.target.delivery !== "draft"
		)
			return undefined;
		await this.validate(definition, true);
		let root = run;
		const seen = new Set<string>();
		while (root.parentRunId) {
			if (seen.has(root.id)) return undefined;
			seen.add(root.id);
			const parent = this.rooms.getRun(root.parentRunId);
			if (
				!parent ||
				parent.status !== "running" ||
				parent.routine?.id !== definition.id ||
				parent.routine.revision !== definition.revision
			)
				return undefined;
			root = parent;
		}
		if (root.roomId !== definition.target.roomId) return undefined;
		return {
			messageId: `schedule:${definition.id}:${definition.revision}`,
			conversationId: root.definitionSnapshot!.conversationId,
			textDigest: createHash("sha256").update(JSON.stringify(definition)).digest("hex"),
		};
	}
}

export function withTeamScheduleReview(
	next: (request: IncomingMessage, response: ServerResponse) => void,
	token: string,
	teams: TeamRoutines,
) {
	return (request: IncomingMessage, response: ServerResponse): void => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (url.pathname !== "/team-schedules/review") {
			next(request, response);
			return;
		}
		const reply = (status: number, value: unknown) =>
			response
				.writeHead(status, {
					"content-type": "application/json",
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				})
				.end(JSON.stringify(value));
		if (!matchesCapabilityToken(token, url.searchParams.get("token"))) {
			reply(401, { error: "Unauthorized" });
			return;
		}
		if (request.method !== "GET") {
			reply(405, { error: "Method not allowed" });
			return;
		}
		const delivery = url.searchParams.get("delivery");
		if (delivery !== "report" && delivery !== "draft") {
			reply(400, { error: "Choose report or draft delivery" });
			return;
		}
		void teams.review(url.searchParams.get("roomId") ?? "", delivery).then(
			(value) => reply(200, value),
			(error: unknown) => reply(400, { error: error instanceof Error ? error.message : "Could not review team" }),
		);
	};
}
