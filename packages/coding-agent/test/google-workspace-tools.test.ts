import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { CapabilityApprovalService } from "../src/core/serve/capability-approval-service.ts";
import type { ProviderAuthenticationManifest } from "../src/core/serve/capability-broker.ts";
import { createGoogleWorkspaceTools } from "../src/core/serve/google-workspace-tools.ts";
import { GovernedActionService } from "../src/core/serve/governed-action-service.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";
import { ServeAuditStore } from "../src/core/serve/serve-audit-store.ts";

describe("createGoogleWorkspaceTools", () => {
	let root: string;
	let approvals: CapabilityApprovalService;
	let environment: NodeJS.ProcessEnv;
	const manifest: ProviderAuthenticationManifest = {
		kind: "oauth2",
		fields: [
			{ env: "GOOGLE_CLIENT_ID", label: "Client ID", required: true, secret: false },
			{ env: "GOOGLE_CLIENT_SECRET", label: "Client secret", required: true, secret: true },
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
		root = await mkdtemp(join(tmpdir(), "pi-google-tools-"));
		approvals = new CapabilityApprovalService(root);
		await approvals.initialize();
		environment = {
			GOOGLE_CLIENT_ID: "client",
			GOOGLE_CLIENT_SECRET: "secret",
			GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
			GOOGLE_OAUTH_REFRESH_TOKEN: "refresh-token",
			GOOGLE_OAUTH_EXPIRES_AT: String(Date.now() + 3_600_000),
		};
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("searches with a bearer token without exposing credentials in the result", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ messages: [{ id: "message-1", threadId: "thread-1" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_search",
		);
		if (!tool) throw new Error("Search tool was not created");
		const result = await tool.execute(
			"search-1",
			{ query: "from:example.com", maxResults: 5 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer access-token" });
		expect(JSON.stringify(result)).toContain("message-1");
		expect(JSON.stringify(result)).not.toContain("access-token");
	});

	test("records governed provider calls and denies missing grants before dispatch", async () => {
		const audit = new ServeAuditStore(join(root, "audit"));
		const governedActions = new GovernedActionService(audit);
		const request = vi.fn<typeof fetch>();
		const tool = createGoogleWorkspaceTools({
			approvals,
			environment,
			fetch: request,
			governedActions,
			identities: { sessionId: "session-1" },
			authorizeCapability: async () => ({ decision: "deny", reason: "email.search is not granted" }),
		}).find((entry) => entry.name === "google_workspace_email_search")!;
		await expect(
			tool.execute("search-denied", { query: "newer:1d" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("email.search is not granted");
		expect(request).not.toHaveBeenCalled();
		expect(await audit.read()).toEqual([
			expect.objectContaining({
				kind: "decision",
				decision: "deny",
				identities: { sessionId: "session-1" },
			}),
		]);
	});

	test("requires a target-bound approval and emits an idempotent MIME message", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ id: "sent-1" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const receipt = await approvals.issue(
			{
				capabilityId: "email.send",
				providerId: "google-workspace",
				connectionId: "google-workspace-primary",
				action: "send",
				target: "recipient@example.com",
			},
			true,
		);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_send",
		);
		if (!tool) throw new Error("Send tool was not created");
		await tool.execute(
			"send-1",
			{
				to: ["recipient@example.com"],
				subject: "Test",
				text: "Body",
				receiptId: receipt.id,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const requestBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as { raw: string };
		const mime = Buffer.from(requestBody.raw, "base64url").toString("utf8");
		expect(mime).toContain(`X-Pi-Idempotency-Key: ${receipt.idempotencyKey}`);
		expect(approvals.list()[0]?.state).toBe("completed");
		await tool.execute(
			"send-replay",
			{
				to: ["recipient@example.com"],
				subject: "Test",
				text: "Body",
				receiptId: receipt.id,
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	test("rejects header injection before making a Gmail request", async () => {
		const request = vi.fn<typeof fetch>();
		const receipt = await approvals.issue(
			{
				capabilityId: "email.send",
				providerId: "google-workspace",
				connectionId: "google-workspace-primary",
				action: "send",
				target: "recipient@example.com",
			},
			true,
		);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_send",
		)!;
		await expect(
			tool.execute(
				"send-2",
				{
					to: ["recipient@example.com"],
					subject: "Safe\r\nBcc: attacker@example.com",
					text: "Body",
					receiptId: receipt.id,
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("line breaks");
		expect(request).not.toHaveBeenCalled();
	});

	test("normalizes message reads and bounds body text", async () => {
		const request = vi.fn<typeof fetch>().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						id: "message-1",
						threadId: "thread-1",
						snippet: "Preview",
						payload: {
							headers: [
								{ name: "Subject", value: "Subject" },
								{ name: "X-Secret-Header", value: "not returned" },
							],
							mimeType: "text/plain",
							body: { data: Buffer.from("Message body").toString("base64url") },
						},
					}),
					{ status: 200 },
				),
			),
		);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_read",
		)!;
		const result = await tool.execute(
			"read-1",
			{ messageId: "message-1" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(JSON.stringify(result)).toContain("Message body");
		expect(JSON.stringify(result)).toContain("Subject");
		expect(JSON.stringify(result)).not.toContain("X-Secret-Header");
		const bounded = await tool.execute(
			"read-2",
			{ messageId: "message-1", maxBodyChars: 7 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(JSON.stringify(bounded)).toContain('\\"body\\": \\"Message\\"');
		expect(JSON.stringify(bounded)).toContain('\\"truncated\\": true');
	});

	test("moves deleted messages to trash instead of requiring permanent-delete scope", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ id: "message-1" }), { status: 200 }));
		const receipt = await approvals.issue(
			{
				capabilityId: "email.delete",
				providerId: "google-workspace",
				connectionId: "google-workspace-primary",
				action: "delete",
				target: "message-1",
			},
			true,
		);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_delete",
		)!;
		const result = await tool.execute(
			"delete-1",
			{ messageId: "message-1", receiptId: receipt.id },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(String(request.mock.calls[0]?.[0])).toContain("/messages/message-1/trash");
		expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
		expect(JSON.stringify(result)).toContain("trashed");
	});

	test("persists refreshed credentials before exposing them to the process", async () => {
		environment.GOOGLE_OAUTH_EXPIRES_AT = "0";
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "refreshed", expires_in: 3600 }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
		const persistTokens = vi.fn(async () => {
			expect(environment.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("access-token");
		});
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request, persistTokens }).find(
			(entry) => entry.name === "google_workspace_email_search",
		)!;
		await tool.execute("search-refresh", { query: "newer:1d" }, undefined, undefined, {} as ExtensionContext);
		expect(persistTokens).toHaveBeenCalledWith(expect.objectContaining({ GOOGLE_OAUTH_ACCESS_TOKEN: "refreshed" }));
		expect(environment.GOOGLE_OAUTH_ACCESS_TOKEN).toBe("refreshed");
	});

	test("resolves and refreshes credentials through the trusted store boundary", async () => {
		environment.GOOGLE_OAUTH_EXPIRES_AT = "0";
		const credentials = new ProviderEnvironmentStore(root, () => manifest, {
			environment,
			platform: "linux",
			passphrase: "correct horse battery staple",
		});
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "store-refreshed", expires_in: 3600 }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
		const tool = createGoogleWorkspaceTools({
			approvals,
			credentials,
			environment: {},
			fetch: request,
		}).find((entry) => entry.name === "google_workspace_email_search")!;
		await tool.execute("search-store-refresh", { query: "newer:1d" }, undefined, undefined, {} as ExtensionContext);
		expect(String(request.mock.calls[0]?.[1]?.body)).toContain("refresh_token=refresh-token");
		expect(await credentials.resolveTrusted("google-workspace", ["GOOGLE_OAUTH_ACCESS_TOKEN"])).toEqual({
			GOOGLE_OAUTH_ACCESS_TOKEN: "store-refreshed",
		});
		expect(request.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: "Bearer store-refreshed" });
	});

	test("marks the connection unhealthy when token refresh fails", async () => {
		environment.GOOGLE_OAUTH_EXPIRES_AT = "0";
		const markConnectionUnhealthy = vi.fn(async () => undefined);
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
		const tool = createGoogleWorkspaceTools({
			approvals,
			environment,
			fetch: request,
			markConnectionUnhealthy,
		}).find((entry) => entry.name === "google_workspace_email_search")!;
		await expect(
			tool.execute("search-failed-refresh", { query: "newer:1d" }, undefined, undefined, {} as ExtensionContext),
		).rejects.toThrow("token refresh failed");
		expect(markConnectionUnhealthy).toHaveBeenCalledOnce();
	});

	test("quotes attachment filenames and rejects malformed MIME types", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ id: "draft-1", message: { id: "message-1" } }), { status: 200 }),
			);
		const issue = () =>
			approvals.issue(
				{
					capabilityId: "email.attach",
					providerId: "google-workspace",
					connectionId: "google-workspace-primary",
					action: "attach",
					target: "recipient@example.com",
				},
				true,
			);
		const tool = createGoogleWorkspaceTools({ approvals, environment, fetch: request }).find(
			(entry) => entry.name === "google_workspace_email_attach",
		)!;
		const receipt = await issue();
		await tool.execute(
			"attach-1",
			{
				to: ["recipient@example.com"],
				subject: "Attachment",
				text: "Body",
				receiptId: receipt.id,
				filename: 'report"final.txt',
				mimeType: "text/plain",
				contentBase64: Buffer.from("content").toString("base64"),
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const requestBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as { message: { raw: string } };
		const mime = Buffer.from(requestBody.message.raw, "base64url").toString("utf8");
		expect(mime).toContain('filename="report\\"final.txt"');

		const invalidReceipt = await issue();
		await expect(
			tool.execute(
				"attach-2",
				{
					to: ["recipient@example.com"],
					subject: "Attachment",
					text: "Body",
					receiptId: invalidReceipt.id,
					filename: "report.txt",
					mimeType: 'text/plain; name="report.txt"',
					contentBase64: Buffer.from("content").toString("base64"),
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("MIME type is invalid");
		expect(request).toHaveBeenCalledTimes(1);
	});
});
