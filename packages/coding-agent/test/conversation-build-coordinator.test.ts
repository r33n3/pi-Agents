import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentBuildLifecycleService } from "../src/core/serve/agent-build-lifecycle-service.ts";
import type {
	AgentExecution,
	AgentExecutionContext,
	AgentExecutionResult,
	AgentExecutor,
} from "../src/core/serve/agent-executor.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { AgentRunManager } from "../src/core/serve/agent-run-manager.ts";
import { ConversationBuildCoordinator } from "../src/core/serve/conversation-build-coordinator.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CompletedExecution implements AgentExecution {
	readonly result = Promise.resolve<AgentExecutionResult>({
		output: "Missouri Ozarks outdoor brief with grounded weather and trail evidence",
		transcript: [],
	});

	subscribe(): () => void {
		return () => {};
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

class CompletedExecutor implements AgentExecutor {
	start(_context: AgentExecutionContext): Promise<AgentExecution> {
		return Promise.resolve(new CompletedExecution());
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}
}

async function setup(): Promise<{
	root: string;
	registry: AgentRegistry;
	runs: AgentRunManager;
	lifecycle: AgentBuildLifecycleService;
	coordinator: ConversationBuildCoordinator;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-conversation-build-"));
	roots.push(root);
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: join(root, "workspace") });
	const runs = new AgentRunManager(registry, new CompletedExecutor(), join(root, "runs"), 4, {
		resolveCapabilityBindings: (definition) =>
			definition.capabilities.map((grant) => ({
				capabilityId: grant.capabilityId,
				capabilityVersion: grant.capabilityVersion,
				providerId: grant.providerId ?? "weather-provider",
				providerDigest: "reviewed-weather-provider",
				connectionId: grant.connectionId,
			})),
	});
	await runs.initialize();
	const lifecycle = new AgentBuildLifecycleService(join(root, "lifecycle"), registry, runs);
	await lifecycle.initialize();
	const coordinator = new ConversationBuildCoordinator(join(root, "serve"), lifecycle);
	await coordinator.initialize();
	return { root, registry, runs, lifecycle, coordinator };
}

function ozarkDraft(root: string, description = "Create a daily Ozark outdoor brief") {
	return {
		name: "ozark-outdoor-daily-brief",
		objective: description,
		projectRoot: join(root, "ozark"),
		configuration: {
			name: "Ozark Outdoor Daily Brief",
			description,
			persona: "A concise outdoor briefing specialist",
			projectRoot: join(root, "ozark"),
			tools: ["read", "browser"],
			capabilities: [
				{
					capabilityId: "weather.read",
					capabilityVersion: 1,
					providerId: "weather-provider",
					approval: "per-run",
				},
			],
			memory: "none",
			executor: "harness",
			permissionPolicy: "read-only",
			browserAccess: "loopback",
			browserRuntime: "installed-chrome",
			browserProfile: { kind: "named", id: "ozark-research" },
			browserWorkflows: [{ id: "weather-lookup", version: 2 }],
			delegateAgentIds: [],
			exposeA2a: false,
		},
	};
}

describe("ConversationBuildCoordinator", () => {
	test("persists an Ozark draft, visible assumptions, and a material scope question across restart", async () => {
		const { root, lifecycle, coordinator } = await setup();
		const initial = await coordinator.applyIntent({
			sessionId: "session-ozark",
			mode: "create",
			sourceMessageId: "message-1",
			draft: ozarkDraft(root),
			assumptions: [
				{
					topic: "delivery",
					value: "Agent inbox only",
					rationale: "No external destination was requested",
				},
			],
			clarifications: [
				{
					topic: "ozark-geography",
					materialTopic: "scope",
					question: "Do you mean the Missouri Ozarks, the city of Ozark, Missouri, or another region?",
					reason: "The answer changes forecast and outdoor sources",
					blockingActions: ["run-proof", "publish"],
				},
			],
		});

		expect(initial.readiness).toMatchObject({ ready: false });
		await expect(
			coordinator.prepareAction({
				buildId: initial.build.id,
				sessionId: "session-ozark",
				action: "run-proof",
				payload: { prompt: "Create today's brief" },
				preview: "Test candidate",
			}),
		).rejects.toThrow("Missouri Ozarks");

		const restored = new ConversationBuildCoordinator(join(root, "serve"), lifecycle);
		await restored.initialize();
		const view = await restored.inspect(initial.build.id);
		expect(view.link).toMatchObject({
			sessionId: "session-ozark",
			assumptions: [expect.objectContaining({ value: "Agent inbox only", status: "active" })],
			clarifications: [expect.objectContaining({ materialTopic: "scope", status: "open" })],
		});
	});

	test("tests an unpublished candidate and binds confirmation to its exact revision and payload", async () => {
		const { root, registry, runs, lifecycle, coordinator } = await setup();
		let view = await coordinator.applyIntent({
			sessionId: "session-ozark",
			mode: "create",
			draft: ozarkDraft(root),
		});
		const proof = await lifecycle.startProof(view.build.id, "Create today's Missouri Ozarks brief");
		await runs.waitForCompletion(proof.proof!.runId);
		await lifecycle.get(view.build.id);
		view = await coordinator.inspect(view.build.id);
		expect(view.build.stage).toBe("proof-ready");
		expect(await registry.list()).toEqual([]);
		await lifecycle.reviewProof(view.build.id, true);
		view = await coordinator.inspect(view.build.id);
		const payload = { buildId: view.build.id, action: "publish" };
		const proposal = await coordinator.prepareAction({
			buildId: view.build.id,
			sessionId: "session-ozark",
			action: "publish",
			payload,
			preview: "Publish Ozark Outdoor Daily Brief revision 1",
		});

		await expect(
			coordinator.authorizeAction({
				proposalId: proposal.id,
				buildId: view.build.id,
				sessionId: "session-ozark",
				action: "publish",
				payload: { ...payload, action: "schedule" },
			}),
		).rejects.toThrow("exact payload");
		await coordinator.authorizeAction({
			proposalId: proposal.id,
			buildId: view.build.id,
			sessionId: "session-ozark",
			action: "publish",
			payload,
		});
		const published = await lifecycle.publishDraft(view.build.id);
		await coordinator.completeAction(proposal.id, published);

		expect(await registry.get("ozark-outdoor-daily-brief")).toMatchObject({
			revision: 1,
			capabilities: [expect.objectContaining({ capabilityId: "weather.read", approval: "per-run" })],
			browser: { runtime: "installed-chrome", profile: { kind: "named", id: "ozark-research" } },
			browserWorkflows: [{ id: "weather-lookup", version: 2 }],
		});
		expect((await coordinator.inspect(view.build.id)).proposals[0]).toMatchObject({ state: "completed" });
	});

	test("rejects stale draft patches and expires a reviewed proposal after a newer revision", async () => {
		const { root, runs, lifecycle, coordinator } = await setup();
		let view = await coordinator.applyIntent({
			sessionId: "session-ozark",
			mode: "create",
			draft: ozarkDraft(root),
		});
		const proof = await lifecycle.startProof(view.build.id, "Create today's Missouri Ozarks brief");
		await runs.waitForCompletion(proof.proof!.runId);
		await lifecycle.get(view.build.id);
		view = await coordinator.inspect(view.build.id);
		await lifecycle.reviewProof(view.build.id, true);
		view = await coordinator.inspect(view.build.id);
		const payload = { buildId: view.build.id, action: "publish" };
		const proposal = await coordinator.prepareAction({
			buildId: view.build.id,
			sessionId: "session-ozark",
			action: "publish",
			payload,
			preview: "Publish revision 1",
		});
		const revised = await coordinator.applyIntent({
			sessionId: "session-ozark",
			mode: "create",
			buildId: view.build.id,
			expectedBuildRevision: view.build.revision,
			draft: ozarkDraft(root, "Create a shorter daily Missouri Ozarks outdoor brief"),
		});
		expect(revised.proposals[0]).toMatchObject({ id: proposal.id, state: "expired" });
		await expect(
			coordinator.applyIntent({
				sessionId: "session-ozark",
				mode: "create",
				buildId: view.build.id,
				expectedBuildRevision: view.build.revision,
				draft: ozarkDraft(root, "Overwrite the newer draft"),
			}),
		).rejects.toThrow("changed from revision");
	});
});
