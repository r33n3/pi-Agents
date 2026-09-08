import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAgentCommandTools } from "../src/core/serve/agent-command-tools.ts";
import { AgentRegistry, normalizeDefinition } from "../src/core/serve/agent-registry.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { createScopedAgentTools } from "../src/core/serve/scoped-agent-tools.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";
import { TeamResources } from "../src/core/serve/team-resources.ts";
import { createTeamContextTool, createTeamTurnTool } from "../src/core/serve/team-turn-tool.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-reconcile-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function agent(tools: string[] = []) {
	return normalizeDefinition(
		{
			id: "worker",
			name: "Worker",
			description: "Implement the assigned task",
			persona: "Implement and test",
			tools,
			memory: "none",
			executor: "harness",
			permissionPolicy: "workspace-write",
			schedules: [],
		},
		root,
	);
}

test("native read pagination and targeted edit preserve workspace boundaries", async () => {
	await writeFile(join(root, "source.txt"), "first\nsecond\nthird\n");
	const tools = createScopedAgentTools(agent(["read", "edit"]), root);
	const read = tools.find((tool) => tool.name === "read")!;
	const edited = tools.find((tool) => tool.name === "edit")!;
	const page = await read.execute(
		"read",
		{ path: "source.txt", offset: 2, limit: 1 } as never,
		undefined,
		undefined,
		undefined as never,
	);
	expect(page.content).toContainEqual(expect.objectContaining({ text: expect.stringContaining("second") }));
	await edited.execute(
		"edit",
		{ path: "source.txt", edits: [{ oldText: "second", newText: "updated" }] } as never,
		undefined,
		undefined,
		undefined as never,
	);
	expect(await readFile(join(root, "source.txt"), "utf8")).toBe("first\nupdated\nthird\n");
	await expect(
		read.execute("escape", { path: "../outside.txt" } as never, undefined, undefined, undefined as never),
	).rejects.toThrow("escapes");
	await expect(
		edited.execute(
			"ambiguous",
			{ path: "source.txt", edits: [{ oldText: "absent", newText: "bad" }] } as never,
			undefined,
			undefined,
			undefined as never,
		),
	).rejects.toThrow();
});

test("host commands require explicit grants and record actual execution", async () => {
	const shell = process.platform === "win32" ? "powershell" : "bash";
	const audit = new ServeAuditStore(join(root, "audit"));
	const gateway = new GovernedActionService(audit);
	const context = { runId: "test-run", workspace: root, prompt: "Check runtime", definition: agent() };
	expect(createAgentCommandTools(context, process.env, gateway)).toEqual([]);
	const seed = new TeamResources().seed(context.definition, [shell]);
	expect(context.definition.tools).toEqual([]);
	context.definition = seed.definition;
	expect(() => createAgentCommandTools(context, process.env, undefined)).toThrow("gateway");
	const command = createAgentCommandTools(context, process.env, gateway)[0]!;
	const result = await command.execute(
		"version",
		{ command: "node --version" },
		undefined,
		undefined,
		undefined as never,
	);
	expect(result.content).toContainEqual(expect.objectContaining({ text: expect.stringMatching(/v\d+\./) }));
	expect((await audit.read()).length).toBe(2);
	const controller = new AbortController();
	controller.abort();
	await expect(
		command.execute("stopped", { command: "node --version" }, controller.signal, undefined, undefined as never),
	).rejects.toThrow();
	context.definition = { ...context.definition, permissionPolicy: "read-only" };
	expect(() => createAgentCommandTools(context, process.env, gateway)).toThrow("write permission");
});

test("new team actions require a typed plan and accept only one submission", async () => {
	const turn = createTeamTurnTool({
		type: "object",
		properties: {
			message: { type: "string" },
			plan: {
				type: "object",
				properties: { teamIds: { type: "array", items: { enum: ["design", "review"] } } },
				required: ["teamIds"],
				additionalProperties: false,
			},
		},
		required: ["message"],
		additionalProperties: false,
	});
	await expect(
		turn.tool.execute("missing", { message: "Done" }, undefined, undefined, undefined as never),
	).rejects.toThrow("schema");
	await expect(
		turn.tool.execute(
			"outside",
			{ message: "Assign", plan: { teamIds: ["outside"] } },
			undefined,
			undefined,
			undefined as never,
		),
	).rejects.toThrow("schema");
	await turn.tool.execute(
		"valid",
		{ message: "Both teams will contribute", plan: { teamIds: ["design", "review"] } },
		undefined,
		undefined,
		undefined as never,
	);
	expect(JSON.parse(turn.result()!).plan.teamIds).toEqual(["design", "review"]);
	await expect(
		turn.tool.execute(
			"repeat",
			{ message: "Repeat", plan: { teamIds: [] } },
			undefined,
			undefined,
			undefined as never,
		),
	).rejects.toThrow("already submitted");
});

test("complete context remains retrievable beyond the prompt summary", async () => {
	const text = `${"x".repeat(9000)}critical earlier decision`;
	const tool = createTeamContextTool(text);
	const first = await tool.execute("first", {}, undefined, undefined, undefined as never);
	const second = await tool.execute("next", { offset: 8000 }, undefined, undefined, undefined as never);
	expect(first.content).toContainEqual(
		expect.objectContaining({ text: expect.stringContaining('"nextOffset":8000') }),
	);
	expect(second.content).toContainEqual(
		expect.objectContaining({ text: expect.stringContaining("critical earlier decision") }),
	);
});

test("supervisor must justify repeating an already completed member assignment", async () => {
	const schema = {
		type: "object",
		properties: {
			requestAgentIds: { type: "array", items: { type: "string" } },
			reassignmentReason: { type: "string" },
		},
		required: ["requestAgentIds"],
	};
	const turn = createTeamTurnTool(schema, ["reporter"]);
	await expect(
		turn.tool.execute("repeat", { requestAgentIds: ["reporter"] }, undefined, undefined, {} as never),
	).rejects.toThrow("already completed");
	expect(turn.result()).toBeUndefined();
	await turn.tool.execute("finish", { requestAgentIds: [] }, undefined, undefined, {} as never);
	const corrected = createTeamTurnTool(schema, ["reporter"]);
	await corrected.tool.execute(
		"revise",
		{ requestAgentIds: ["reporter"], reassignmentReason: "The user corrected the destination; revise the report." },
		undefined,
		undefined,
		{} as never,
	);
	expect(corrected.result()).toContain("corrected the destination");
});

test("tool catalog is searchable on demand without inflating ordinary history", async () => {
	const tool = createTeamContextTool(
		JSON.stringify({
			goal: "Research",
			tools: [
				{ id: "search:web.search", name: "Search", setup: "Connect search" },
				{ id: "mail:email.send", name: "Send email", setup: "Connect mail" },
			],
		}),
	);
	const history = await tool.execute("history", {}, undefined, undefined, undefined as never);
	expect(JSON.stringify(history.content)).not.toContain("Connect mail");
	const catalog = await tool.execute(
		"catalog",
		{ section: "tools", query: "search" },
		undefined,
		undefined,
		undefined as never,
	);
	expect(JSON.stringify(catalog.content)).toContain("Connect search");
	expect(JSON.stringify(catalog.content)).not.toContain("Connect mail");
});

test("native read retains image bytes", async () => {
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==",
		"base64",
	);
	await writeFile(join(root, "pixel.png"), png);
	const read = createScopedAgentTools(agent(["read"]), root)[0]!;
	const result = await read.execute("image", { path: "pixel.png" } as never, undefined, undefined, undefined as never);
	expect(result.content.some((item) => item.type === "image" && item.mimeType === "image/png")).toBe(true);
});

test("explicit validators survive unrelated edits and can be disabled", async () => {
	const registry = new AgentRegistry(join(root, "registry"), { defaultWorkspace: root });
	await registry.save({ ...agent(["read"]), inputValidator: "inventory" });
	await registry.save({ ...agent(["read"]), name: "Renamed" });
	expect((await registry.get("worker"))?.inputValidator).toBe("inventory");
	await registry.save({ ...agent(["read"]), inputValidator: "none" });
	expect((await registry.get("worker"))?.inputValidator).toBe("none");
});
