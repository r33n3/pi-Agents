import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CapabilityConnectionProfile, CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import type { CredentialStore } from "./credential-store.ts";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingAuthorization {
	verifier: string;
	redirectUri: string;
	capabilityIds: string[];
	expiresAt: number;
	initiatorDigest?: string;
}

export interface GoogleWorkspaceOAuthOptions {
	fetch?: typeof fetch;
	now?: () => number;
	environment?: NodeJS.ProcessEnv;
	environmentValue?: (name: string) => string | undefined;
}

/** Owns the Google authorization-code lifecycle without exposing tokens to HTTP callers. */
export class GoogleWorkspaceOAuth {
	readonly #credentials: CredentialStore;
	readonly #connections: CapabilityConnectionRegistry;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #environmentValue: (name: string) => string | undefined;
	readonly #pending = new Map<string, PendingAuthorization>();

	constructor(
		credentials: CredentialStore,
		connections: CapabilityConnectionRegistry,
		options: GoogleWorkspaceOAuthOptions = {},
	) {
		this.#credentials = credentials;
		this.#connections = connections;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		const environment = options.environment ?? process.env;
		this.#environmentValue = options.environmentValue ?? ((name) => environment[name]);
	}

	start(
		origin: string,
		capabilityIds: readonly string[],
		initiatorToken?: string,
	): { authorizationUrl: string; expiresAt: string } {
		const clientId = requiredString(this.#environmentValue("GOOGLE_CLIENT_ID"), "GOOGLE_CLIENT_ID");
		const normalizedCapabilities = normalizeCapabilities(capabilityIds);
		const state = randomBytes(32).toString("base64url");
		const verifier = randomBytes(48).toString("base64url");
		const redirectUri = callbackUri(this.#environmentValue("GOOGLE_OAUTH_REDIRECT_URI"), origin);
		const expiresAt = this.#now() + STATE_TTL_MS;
		this.#prune();
		this.#pending.set(state, {
			verifier,
			redirectUri,
			capabilityIds: normalizedCapabilities,
			expiresAt,
			initiatorDigest: initiatorToken ? tokenDigest(initiatorToken) : undefined,
		});
		const url = new URL(AUTHORIZATION_ENDPOINT);
		url.searchParams.set("client_id", clientId);
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", scopesFor(normalizedCapabilities).join(" "));
		url.searchParams.set("access_type", "offline");
		url.searchParams.set("include_granted_scopes", "true");
		url.searchParams.set("prompt", "select_account consent");
		url.searchParams.set("state", state);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
		return { authorizationUrl: url.href, expiresAt: new Date(expiresAt).toISOString() };
	}

	async complete(state: string, code: string, initiatorToken?: string): Promise<CapabilityConnectionProfile> {
		const pending = this.#pending.get(state);
		this.#pending.delete(state);
		if (!pending || pending.expiresAt <= this.#now())
			throw new Error("Google authorization state is invalid or expired");
		if (pending.initiatorDigest && !matchesTokenDigest(pending.initiatorDigest, initiatorToken)) {
			throw new Error("Google authorization state does not belong to this browser session");
		}
		if (!code.trim()) throw new Error("Google authorization code is required");
		const credentials = await this.#credentials.resolveTrusted("google-workspace", [
			"GOOGLE_CLIENT_ID",
			"GOOGLE_CLIENT_SECRET",
			"GOOGLE_OAUTH_REFRESH_TOKEN",
		]);
		const body = new URLSearchParams({
			client_id: requiredCredential(credentials, "GOOGLE_CLIENT_ID"),
			client_secret: requiredCredential(credentials, "GOOGLE_CLIENT_SECRET"),
			code,
			code_verifier: pending.verifier,
			grant_type: "authorization_code",
			redirect_uri: pending.redirectUri,
		});
		const response = await this.#fetch(TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
		});
		if (!response.ok) throw new Error(`Google token exchange failed with HTTP ${response.status}`);
		const tokens = record((await response.json()) as unknown, "Google token response");
		const accessToken = requiredString(tokens.access_token, "Google access token");
		const refreshToken =
			optionalString(tokens.refresh_token) ?? requiredCredential(credentials, "GOOGLE_OAUTH_REFRESH_TOKEN");
		const expiresIn = positiveInteger(tokens.expires_in, "Google token expiry");
		let email: string;
		try {
			const profileResponse = await this.#fetch(PROFILE_ENDPOINT, {
				headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
			});
			if (!profileResponse.ok)
				throw new Error(`Google account validation failed with HTTP ${profileResponse.status}`);
			const profile = record((await profileResponse.json()) as unknown, "Google profile response");
			email = requiredString(profile.emailAddress, "Google account email");
		} catch (error) {
			await this.#markConnectionUnhealthy();
			throw error;
		}
		const credentialMetadata = await this.#credentials.replace("google-workspace", {
			values: {
				GOOGLE_OAUTH_ACCESS_TOKEN: accessToken,
				GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
				GOOGLE_OAUTH_EXPIRES_AT: String(this.#now() + expiresIn * 1000),
			},
		});
		const id = "google-workspace-primary";
		const existing = await this.#connections.get(id);
		if (existing?.status === "revoked") await this.#connections.deleteRevoked(id);
		return this.#connections.save({
			id,
			providerId: "google-workspace",
			accountLabel: email,
			secretRef: credentialMetadata.reference,
			scopes: scopesFor(pending.capabilityIds),
			capabilityIds: pending.capabilityIds,
			status: "active",
		});
	}

	async revoke(): Promise<void> {
		const connection = await this.#connections.get("google-workspace-primary");
		const credentials = await this.#credentials.resolveTrusted("google-workspace", [
			"GOOGLE_OAUTH_REFRESH_TOKEN",
			"GOOGLE_OAUTH_ACCESS_TOKEN",
		]);
		const token = credentials.GOOGLE_OAUTH_REFRESH_TOKEN ?? credentials.GOOGLE_OAUTH_ACCESS_TOKEN;
		let remoteError: Error | undefined;
		if (token) {
			try {
				const response = await this.#fetch(REVOCATION_ENDPOINT, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
					body: new URLSearchParams({ token }),
				});
				if (!response.ok) remoteError = new Error(`Google token revocation failed with HTTP ${response.status}`);
			} catch (error) {
				remoteError = error instanceof Error ? error : new Error(String(error));
			}
		}
		if (connection && connection.status !== "revoked") await this.#connections.revoke(connection.id);
		await this.#credentials.revoke("google-workspace", [
			"GOOGLE_OAUTH_ACCESS_TOKEN",
			"GOOGLE_OAUTH_REFRESH_TOKEN",
			"GOOGLE_OAUTH_EXPIRES_AT",
		]);
		if (remoteError) throw remoteError;
	}

	#prune(): void {
		const now = this.#now();
		for (const [state, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(state);
	}

	async #markConnectionUnhealthy(): Promise<void> {
		const connection = await this.#connections.get("google-workspace-primary");
		if (!connection || connection.status === "revoked") return;
		await this.#connections.save({ ...connection, status: "unhealthy" });
	}
}

function normalizeCapabilities(values: readonly string[]): string[] {
	const allowed = new Set(["email.search", "email.read", "email.draft", "email.send", "email.attach", "email.delete"]);
	const normalized = [...new Set(values)];
	if (normalized.length === 0) return ["email.search", "email.read", "email.draft"];
	for (const value of normalized)
		if (!allowed.has(value)) throw new Error(`Google authorization cannot grant ${value}`);
	return normalized.sort();
}

function scopesFor(capabilityIds: readonly string[]): string[] {
	const scopes = new Set<string>();
	if (capabilityIds.some((id) => id === "email.search" || id === "email.read")) {
		scopes.add("https://www.googleapis.com/auth/gmail.readonly");
	}
	if (capabilityIds.some((id) => id === "email.draft" || id === "email.attach")) {
		scopes.add("https://www.googleapis.com/auth/gmail.compose");
	}
	if (capabilityIds.includes("email.send") && !scopes.has("https://www.googleapis.com/auth/gmail.compose")) {
		scopes.add("https://www.googleapis.com/auth/gmail.send");
	}
	if (capabilityIds.includes("email.delete")) scopes.add("https://www.googleapis.com/auth/gmail.modify");
	return [...scopes].sort();
}

function canonicalOrigin(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OAuth origin must use HTTP or HTTPS");
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("OAuth origin must not include credentials, a path, query, or fragment");
	}
	return url.origin;
}

function callbackUri(configured: string | undefined, origin: string): string {
	const value = configured?.trim();
	const url = value ? new URL(value) : new URL("/capability-oauth/google-workspace/callback", canonicalOrigin(origin));
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("Google OAuth redirect URI must use HTTP or HTTPS");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Google OAuth redirect URI must not include credentials, a query, or fragment");
	if (url.pathname !== "/capability-oauth/google-workspace/callback") {
		throw new Error("Google OAuth redirect URI must use the Google Workspace callback endpoint");
	}
	return url.href;
}

function tokenDigest(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function matchesTokenDigest(expected: string, value: string | undefined): boolean {
	if (!value) return false;
	const actual = tokenDigest(value);
	return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function requiredCredential(credentials: Readonly<Record<string, string>>, name: string): string {
	return requiredString(credentials[name], name);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is unavailable`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} is invalid`);
	return Number(value);
}
