import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/** Serves explicit workspace files on loopback so managed Chromium never needs file:// access. */
export class WorkspacePreviewServer implements AsyncDisposable {
	readonly #roots = new Map<string, string>();
	readonly #rootTokens = new Map<string, string>();
	#server: Server | undefined;
	#origin: string | undefined;
	#startPromise: Promise<void> | undefined;

	async urlFor(workspaceRoot: string, filePath: string): Promise<string> {
		await this.#start();
		const root = await realpath(workspaceRoot);
		const file = await realpath(resolve(root, filePath));
		assertWithin(root, file);
		const metadata = await stat(file);
		if (!metadata.isFile()) throw new Error("Browser preview path must identify a file");
		const token = this.#rootTokens.get(root) ?? randomBytes(18).toString("base64url");
		this.#roots.set(token, root);
		this.#rootTokens.set(root, token);
		const path = relative(root, file)
			.split(sep)
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		return `${this.#origin}/${token}/${path}`;
	}

	async close(): Promise<void> {
		this.#roots.clear();
		this.#rootTokens.clear();
		const server = this.#server;
		this.#server = undefined;
		this.#origin = undefined;
		this.#startPromise = undefined;
		await new Promise<void>(
			(resolveClose, reject) => server?.close((error) => (error ? reject(error) : resolveClose())) ?? resolveClose(),
		);
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close();
	}

	#start(): Promise<void> {
		this.#startPromise ??= new Promise((resolveStart, reject) => {
			const server = createServer((request, response) => void this.#serve(request.url, request.method, response));
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("Workspace preview server did not bind"));
					return;
				}
				this.#server = server;
				this.#origin = `http://127.0.0.1:${address.port}`;
				resolveStart();
			});
		});
		return this.#startPromise;
	}

	async #serve(requestUrl: string | undefined, method: string | undefined, response: ServerResponse): Promise<void> {
		try {
			if (method !== "GET" && method !== "HEAD") {
				response.writeHead(405, { allow: "GET, HEAD" }).end();
				return;
			}
			const parts = new URL(requestUrl ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
			const token = parts.shift();
			const root = token ? this.#roots.get(token) : undefined;
			if (!root || parts.length === 0) {
				response.writeHead(404).end();
				return;
			}
			const requested = resolve(root, ...parts.map((part) => decodeURIComponent(part)));
			const file = await realpath(requested);
			assertWithin(root, file);
			if (!(await stat(file)).isFile()) throw new Error("Preview target is not a file");
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-type": contentType(file),
				"x-content-type-options": "nosniff",
			});
			if (method === "HEAD") response.end();
			else {
				const stream = createReadStream(file);
				stream.once("error", () => response.destroy());
				stream.pipe(response);
			}
		} catch {
			if (!response.headersSent) response.writeHead(404);
			response.end();
		}
	}
}

function assertWithin(root: string, candidate: string): void {
	const child = relative(root, candidate);
	if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
		throw new Error("Browser preview file must be inside the session workspace");
	}
}

function contentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".json":
			return "application/json; charset=utf-8";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}
