import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";
import { createAgentRegistryTools } from "../src/core/serve/agent-registry-tools.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function registry(): Promise<{ root: string; registry: AgentRegistry }> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-"));
	roots.push(root);
	const registry = new AgentRegistry(root);
	await registry.initialize();
	return { root, registry };
}

describe("AgentRegistry", () => {
	test("persists normalized definitions and creates their workspace", async () => {
		const { root, registry: agents } = await registry();
		const projectRoot = join(root, "projects", "research");
		const saved = await agents.save({
			name: "Research Agent",
			personaId: "careful-researcher",
			description: "Researches a bounded question",
			tools: ["read"],
			memory: "notes",
			persona: "Careful researcher",
			projectRoot,
			executor: "harness",
			permissionPolicy: "workspace-write",
			schedules: [],
		});

		expect(saved).toMatchObject({
			id: "research-agent",
			revision: 1,
			personaId: "careful-researcher",
			projectRoot,
			workspace: projectRoot,
		});
		expect(await agents.list()).toEqual([saved]);
		expect(JSON.parse(await readFile(join(root, "definitions", "research-agent.json"), "utf8"))).toEqual(saved);
		expect(agents.workspacePath(saved)).toBe(projectRoot);
	});

	test("updates an existing definition atomically", async () => {
		const { registry: agents } = await registry();
		const base = {
			id: "writer",
			name: "Writer",
			description: "Writes",
			tools: [],
			memory: "none" as const,
			persona: "Concise",
			executor: "session" as const,
			permissionPolicy: "read-only" as const,
			schedules: [],
		};
		await agents.save(base);
		await agents.save({ ...base, description: "Writes concise reports" });

		expect(await agents.get("writer")).toMatchObject({ revision: 2, description: "Writes concise reports" });
	});

	test("requires canonical model identifiers from the active catalog", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-"));
		roots.push(root);
		const agents = new AgentRegistry(root, {
			modelCatalog: () => [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
		});
		const input = {
			id: "frontend-designer",
			name: "Frontend Designer",
			description: "Designs interfaces",
			tools: [],
			memory: "none" as const,
			persona: "Design carefully",
			executor: "session" as const,
			permissionPolicy: "read-only" as const,
			schedules: [],
		};

		await expect(agents.save({ ...input, model: { provider: "openai", id: "GPT5.6 Luna" } })).rejects.toThrow(
			"Use openai/gpt-5.6-luna (GPT-5.6 Luna)",
		);
		await expect(agents.save({ ...input, model: { provider: "openai", id: "gpt-5.6-luna" } })).resolves.toMatchObject(
			{ model: { provider: "openai", id: "gpt-5.6-luna" } },
		);
		await expect(
			agents.save({ ...input, id: "unknown-model", model: { provider: "openai", id: "not-real" } }),
		).rejects.toThrow("Select a model from the active Pi model catalog");
	});

	test("requires an explicit policy when an agent enables browser tools", async () => {
		const { registry: agents } = await registry();
		const input = {
			id: "browser-agent",
			name: "Browser Agent",
			description: "Uses a managed browser",
			tools: ["browser"],
			memory: "none" as const,
			persona: "Browser-aware",
			executor: "session" as const,
			permissionPolicy: "read-only" as const,
			schedules: [],
		};
		await expect(agents.save(input)).rejects.toThrow("browser tool and browser access policy");
		await expect(
			agents.save({
				...input,
				browser: { access: "public-web", profile: { kind: "named", id: "research" } },
			}),
		).resolves.toMatchObject({ browser: { access: "public-web", profile: { kind: "named", id: "research" } } });
	});

	test("pins assigned browser workflows to an active validated version", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-workflow-grant-"));
		roots.push(root);
		const agents = new AgentRegistry(root, {
			browserWorkflowCatalog: (id, version) => id === "review-page" && version === 2,
		});
		const input = {
			id: "browser-reviewer",
			name: "Browser reviewer",
			description: "Reviews a validated page flow",
			tools: ["browser"],
			memory: "none" as const,
			persona: "Review carefully",
			executor: "session" as const,
			permissionPolicy: "read-only" as const,
			schedules: [],
			browser: { access: "loopback" as const, profile: { kind: "ephemeral" as const } },
		};
		await expect(agents.save({ ...input, browserWorkflows: [{ id: "review-page", version: 1 }] })).rejects.toThrow(
			"version 1 is not active",
		);
		await expect(
			agents.save({ ...input, browserWorkflows: [{ id: "review-page", version: 2 }] }),
		).resolves.toMatchObject({ browserWorkflows: [{ id: "review-page", version: 2 }] });
	});

	test("keeps browser tool and access policy paired when Pi deploys an agent", async () => {
		const { root, registry: agents } = await registry();
		const deploy = createAgentRegistryTools(agents)[0]!;
		const base = {
			id: "browser-agent",
			name: "Browser Agent",
			description: "Reviews local pages",
			persona: "Review pages carefully",
			projectRoot: join(root, "browser-project"),
		};
		await deploy.execute(
			"deploy-browser",
			{ ...base, tools: ["read", "browser"] },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await agents.get("browser-agent")).toMatchObject({
			tools: ["read", "browser"],
			browser: { access: "loopback" },
		});

		await deploy.execute(
			"disable-browser",
			{ ...base, browserAccess: "disabled" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await agents.get("browser-agent")).toMatchObject({
			tools: ["read"],
			browser: { access: "disabled" },
		});
	});

	test("allows an explicit local project folder", async () => {
		const { registry: agents } = await registry();
		const projectRoot = await mkdtemp(join(tmpdir(), "pi-agent-project-"));
		roots.push(projectRoot);
		await expect(
			agents.save({
				id: "escape",
				name: "Outside project",
				description: "Works in a selected project",
				tools: [],
				memory: "none",
				persona: "None",
				projectRoot,
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
			}),
		).resolves.toMatchObject({ projectRoot });
	});

	test("rejects a filesystem root as an agent project", async () => {
		const { registry: agents } = await registry();
		await expect(
			agents.save({
				id: "root-project",
				name: "Root project",
				description: "Too broad",
				tools: [],
				memory: "none",
				persona: "None",
				projectRoot: parse(tmpdir()).root,
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
			}),
		).rejects.toThrow("must not be a filesystem root");
	});

	test("includes existing Pi Markdown agents without duplicating their definitions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-agent-registry-"));
		roots.push(root);
		const catalogDirectory = join(root, "agents");
		const personaDirectory = join(root, "personas");
		const workspace = join(root, "project");
		await mkdir(catalogDirectory, { recursive: true });
		await mkdir(join(personaDirectory, "skeptical-engineer"), { recursive: true });
		await writeFile(join(personaDirectory, "skeptical-engineer", "icon.webp"), "icon-bytes");
		await writeFile(
			join(catalogDirectory, "researcher.md"),
			"---\nname: researcher\ndescription: Researches code\nmodel: ollama/qwen3.8:latest\ntools: read,grep,find\nmemory: none\n---\n\nReport findings with evidence.\n\n<!-- persona:start name=skeptical-engineer -->\nPersona\n<!-- persona:end -->\n",
		);
		const agents = new AgentRegistry(join(root, "serve"), {
			catalogDirectory,
			personaDirectory,
			defaultWorkspace: workspace,
		});

		const researcher = await agents.get("researcher");
		expect(researcher).toMatchObject({
			id: "researcher",
			source: "pi-agent",
			personaId: "skeptical-engineer",
			model: { provider: "ollama", id: "qwen3.8:latest" },
			tools: ["read", "grep", "find"],
			permissionPolicy: "read-only",
		});
		expect(await agents.list()).toEqual([researcher]);
		expect(agents.workspacePath(researcher!)).toBe(workspace);
		expect(new TextDecoder().decode(await agents.readIcon("researcher"))).toBe("icon-bytes");
		await expect(
			agents.save({
				id: "researcher",
				name: "Researcher",
				description: "Duplicate",
				tools: [],
				memory: "none",
				persona: "Duplicate",
				executor: "session",
				permissionPolicy: "read-only",
				schedules: [],
			}),
		).rejects.toThrow("managed by the Pi Markdown agent catalog");
	});
});
