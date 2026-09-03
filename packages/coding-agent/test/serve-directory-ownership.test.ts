import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	acquireServeDirectoryOwnership,
	type ServeDirectoryOwnership,
} from "../src/core/serve/serve-directory-ownership.ts";

const roots: string[] = [];
const ownerships: ServeDirectoryOwnership[] = [];

afterEach(async () => {
	await Promise.allSettled(ownerships.splice(0).map((ownership) => ownership.release()));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-serve-owner-"));
	roots.push(root);
	return root;
}

describe("ServeDirectoryOwnership", () => {
	test("excludes another owner until the current owner releases the canonical directory", async () => {
		const root = await temporaryRoot();
		const serveRoot = join(root, "serve");
		const first = await acquireServeDirectoryOwnership(serveRoot, () => {});
		ownerships.push(first);

		await expect(acquireServeDirectoryOwnership(serveRoot, () => {})).rejects.toThrow(
			`Serve data directory ${first.path} is already owned by another Pi serve host`,
		);

		await first.release();
		await expect(first.release()).resolves.toBeUndefined();
		const replacement = await acquireServeDirectoryOwnership(serveRoot, () => {});
		ownerships.push(replacement);
	});

	test("treats a filesystem alias as the same ownership boundary", async () => {
		const root = await temporaryRoot();
		const serveRoot = join(root, "serve");
		const first = await acquireServeDirectoryOwnership(serveRoot, () => {});
		ownerships.push(first);
		const alias = join(root, "serve-alias");
		try {
			await symlink(serveRoot, alias, process.platform === "win32" ? "junction" : "dir");
		} catch {
			return;
		}

		await expect(acquireServeDirectoryOwnership(alias, () => {})).rejects.toThrow(
			`Serve data directory ${first.path} is already owned by another Pi serve host`,
		);
	});

	test("reports a compromised lease and still releases idempotently", async () => {
		const root = await temporaryRoot();
		let reportCompromised: (error: Error) => void = () => {};
		const compromised = new Promise<Error>((resolve) => {
			reportCompromised = resolve;
		});
		const ownership = await acquireServeDirectoryOwnership(join(root, "serve"), reportCompromised);
		ownerships.push(ownership);

		await rm(`${ownership.path}.lock`, { recursive: true });
		await expect(compromised).resolves.toMatchObject({ code: "ECOMPROMISED" });
		await expect(ownership.release()).resolves.toBeUndefined();
		await expect(ownership.release()).resolves.toBeUndefined();
	}, 5_000);
});
