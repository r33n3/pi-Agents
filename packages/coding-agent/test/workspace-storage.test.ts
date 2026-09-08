import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { withWorkspaceStorage } from "../src/core/serve/workspace-storage-http.ts";

test("storage browsing is authenticated, confined, and never serves file contents", async () => {
	const base = await mkdtemp(join(tmpdir(), "pi-storage-"));
	const workspace = join(base, "workspace");
	const settings = join(base, "settings");
	await mkdir(join(workspace, "teams"), { recursive: true });
	await mkdir(settings);
	await writeFile(join(workspace, "private.json"), "NEVER_RENDER_FILE_CONTENT");
	await symlink(settings, join(workspace, "outside-link"), "junction");
	const token = "workspace_storage_fixture_token_12345";
	const server = createServer(
		withWorkspaceStorage((_request, response) => response.writeHead(404).end(), token, workspace, settings),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const url = new URL(`http://127.0.0.1:${address.port}/workspace-storage`);
		expect((await fetch(url)).status).toBe(401);
		url.searchParams.set("token", token);
		const listing = await (await fetch(url)).text();
		expect(listing).toContain("teams/");
		expect(listing).toContain("private.json");
		expect(listing).not.toContain("NEVER_RENDER_FILE_CONTENT");
		url.searchParams.set("format", "json");
		expect(await (await fetch(url)).json()).toEqual({ workspace, settings });
		url.searchParams.delete("format");
		for (const path of ["../settings", "outside-link", settings]) {
			url.searchParams.set("path", path);
			expect((await fetch(url)).status).toBe(403);
		}
		url.searchParams.set("path", "private.json");
		expect((await fetch(url)).status).toBe(404);
		url.searchParams.set("path", "teams");
		expect(await (await fetch(url)).text()).toContain("Parent folder");
		expect((await fetch(url, { method: "POST" })).status).toBe(405);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await rm(base, { recursive: true, force: true });
	}
});
