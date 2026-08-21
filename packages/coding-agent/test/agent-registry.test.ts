import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AgentRegistry } from "../src/core/serve/agent-registry.ts";

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
		const saved = await agents.save({
			name: "Research Agent",
			description: "Researches a bounded question",
			tools: ["read"],
			memory: "notes",
			persona: "Careful researcher",
			executor: "harness",
			permissionPolicy: "workspace-write",
			schedules: [],
		});

		expect(saved).toMatchObject({ id: "research-agent", workspace: "workspaces/research-agent" });
		expect(await agents.list()).toEqual([saved]);
		expect(JSON.parse(await readFile(join(root, "definitions", "research-agent.json"), "utf8"))).toEqual(saved);
		expect(agents.workspacePath(saved)).toBe(join(root, "workspaces", "research-agent"));
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

		expect(await agents.get("writer")).toMatchObject({ description: "Writes concise reports" });
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

	test("rejects workspaces outside the registry", async () => {
		const { registry: agents } = await registry();
		await expect(
			agents.save({
				id: "escape",
				name: "Escape",
				description: "Invalid",
				tools: [],
				memory: "none",
				persona: "None",
				workspace: "../../outside",
				executor: "harness",
				permissionPolicy: "read-only",
				schedules: [],
			}),
		).rejects.toThrow("escapes the registry root");
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
