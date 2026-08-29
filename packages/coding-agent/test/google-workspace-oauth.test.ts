import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderAuthenticationManifest } from "../src/core/serve/capability-broker.ts";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import { GoogleWorkspaceOAuth } from "../src/core/serve/google-workspace-oauth.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";

describe("GoogleWorkspaceOAuth", () => {
	let root: string;
	let environment: NodeJS.ProcessEnv;
	let connections: CapabilityConnectionRegistry;
	let environmentStore: ProviderEnvironmentStore;
	const manifest: ProviderAuthenticationManifest = {
		kind: "oauth2",
		fields: [
			{ env: "GOOGLE_CLIENT_ID", label: "Client ID", required: true, secret: false },
			{ env: "GOOGLE_CLIENT_SECRET", label: "Client secret", required: true, secret: true },
			{ env: "GOOGLE_OAUTH_REDIRECT_URI", label: "Redirect URI", required: false, secret: false, format: "url" },
			{ env: "GOOGLE_OAUTH_ACCESS_TOKEN", label: "Access", required: false, secret: true, operatorEditable: false },
			{
				env: "GOOGLE_OAUTH_REFRESH_TOKEN",
				label: "Refresh",
				required: false,
				secret: true,
				operatorEditable: false,
			},
			{ env: "GOOGLE_OAUTH_EXPIRES_AT", label: "Expiry", required: false, secret: false, operatorEditable: false },
		],
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-google-oauth-"));
		environment = { GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret" };
		connections = new CapabilityConnectionRegistry(join(root, "connections"));
		await connections.initialize();
		environmentStore = new ProviderEnvironmentStore(root, () => manifest, {
			environment,
			platform: "linux",
			passphrase: "correct horse battery staple",
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("uses PKCE, persists tokens without returning them, and creates a scoped connection", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 }),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ emailAddress: "operator@example.com" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { fetch: request, environment });
		const started = oauth.start("http://127.0.0.1:4173", ["email.read", "email.draft"]);
		const authorization = new URL(started.authorizationUrl);
		expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorization.searchParams.get("prompt")).toBe("select_account consent");
		expect(authorization.searchParams.get("include_granted_scopes")).toBe("true");
		expect(authorization.searchParams.get("scope")).toContain("gmail.readonly");
		expect(authorization.searchParams.get("scope")).toContain("gmail.compose");
		const connection = await oauth.complete(authorization.searchParams.get("state")!, "authorization-code");
		expect(connection).toMatchObject({
			id: "google-workspace-primary",
			providerId: "google-workspace",
			accountLabel: "operator@example.com",
			capabilityIds: ["email.draft", "email.read"],
			secretRef: "vault:user/google-workspace",
		});
		const tokenRequest = request.mock.calls[0];
		expect(String(tokenRequest?.[1]?.body)).toContain("code_verifier=");
		await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await environmentStore.metadata("google-workspace")).toMatchObject({
			storage: "encrypted-user-vault",
			configured: true,
		});
		expect(JSON.stringify(connection)).not.toContain("access-secret");
		await expect(oauth.complete(authorization.searchParams.get("state")!, "replay")).rejects.toThrow(
			"invalid or expired",
		);
	});

	test("rejects expired state before exchanging a token", async () => {
		let now = 1_000;
		const request = vi.fn<typeof fetch>();
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, {
			fetch: request,
			now: () => now,
			environment,
		});
		const started = oauth.start("http://localhost:4173", ["email.read"]);
		now += 10 * 60 * 1000 + 1;
		await expect(
			oauth.complete(new URL(started.authorizationUrl).searchParams.get("state")!, "code"),
		).rejects.toThrow("invalid or expired");
		expect(request).not.toHaveBeenCalled();
	});

	test("uses an explicitly configured redirect URI for proxied and LAN deployments", () => {
		environment.GOOGLE_OAUTH_REDIRECT_URI = "https://pi.example.test/capability-oauth/google-workspace/callback";
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { environment });
		const authorization = new URL(
			oauth.start("http://192.168.0.10:4173", ["email.send", "email.delete"]).authorizationUrl,
		);
		expect(authorization.searchParams.get("redirect_uri")).toBe(
			"https://pi.example.test/capability-oauth/google-workspace/callback",
		);
		expect(authorization.searchParams.get("scope")).toContain("gmail.send");
		expect(authorization.searchParams.get("scope")).toContain("gmail.modify");
	});

	test("binds pending authorization to the initiating browser token", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ emailAddress: "operator@example.com" }), { status: 200 }),
			);
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { fetch: request, environment });
		const started = oauth.start("http://127.0.0.1:4173", ["email.read"], "browser-token");
		const state = new URL(started.authorizationUrl).searchParams.get("state")!;
		await expect(oauth.complete(state, "code", "wrong-token")).rejects.toThrow("browser session");
		expect(request).not.toHaveBeenCalled();
	});

	test("rejects configured redirect paths outside the callback endpoint", () => {
		environment.GOOGLE_OAUTH_REDIRECT_URI = "https://pi.example.test/not-the-callback";
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { environment });
		expect(() => oauth.start("http://127.0.0.1:4173", ["email.read"])).toThrow("callback endpoint");
	});

	test("does not persist exchanged tokens when account validation fails", async () => {
		await connections.save({
			id: "google-workspace-primary",
			providerId: "google-workspace",
			accountLabel: "operator@example.com",
			secretRef: "env:GOOGLE_OAUTH_REFRESH_TOKEN",
			scopes: [],
			capabilityIds: ["email.read"],
		});
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
					{
						status: 200,
					},
				),
			)
			.mockResolvedValueOnce(new Response(null, { status: 401 }));
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { fetch: request, environment });
		const started = oauth.start("http://127.0.0.1:4173", ["email.read"]);
		await expect(
			oauth.complete(new URL(started.authorizationUrl).searchParams.get("state")!, "code"),
		).rejects.toThrow("account validation failed");
		expect(environment.GOOGLE_OAUTH_ACCESS_TOKEN).toBeUndefined();
		expect((await connections.get("google-workspace-primary"))?.status).toBe("unhealthy");
	});

	test("revocation removes local tokens and marks the connection revoked", async () => {
		await connections.save({
			id: "google-workspace-primary",
			providerId: "google-workspace",
			accountLabel: "operator@example.com",
			secretRef: "env:GOOGLE_OAUTH_REFRESH_TOKEN",
			scopes: [],
			capabilityIds: ["email.read"],
		});
		await environmentStore.configureManaged("google-workspace", {
			values: {
				GOOGLE_OAUTH_ACCESS_TOKEN: "access",
				GOOGLE_OAUTH_REFRESH_TOKEN: "refresh",
				GOOGLE_OAUTH_EXPIRES_AT: "123",
			},
		});
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
		const oauth = new GoogleWorkspaceOAuth(environmentStore, connections, { environment, fetch: request });
		await oauth.revoke();
		expect(request).toHaveBeenCalledWith(
			"https://oauth2.googleapis.com/revoke",
			expect.objectContaining({ method: "POST" }),
		);
		expect((await connections.get("google-workspace-primary"))?.status).toBe("revoked");
		expect(environment.GOOGLE_OAUTH_REFRESH_TOKEN).toBeUndefined();
	});
});
