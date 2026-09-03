import { createHash } from "node:crypto";
import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type CapabilityApprovalActionBinding,
	type CapabilityApprovalOwner,
	type CapabilityApprovalService,
	createCapabilityApprovalActionBinding,
} from "./capability-approval-service.ts";
import type { CredentialStore } from "./credential-store.ts";
import {
	type ActionAuthority,
	assertActionAuthority,
	GovernedActionCancelledError,
	type GovernedActionDecision,
	type GovernedActionService,
	isGovernedActionCancellation,
} from "./governed-action-service.ts";
import type { ServeAuditIdentities } from "./serve-audit-store.ts";

const API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MESSAGE_TEXT_CHARS = 200_000;
const CONNECTION_ID = "google-workspace-primary";

export interface GoogleWorkspaceToolOptions {
	credentials?: CredentialStore;
	environment?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	now?: () => number;
	approvals: CapabilityApprovalService;
	governedActions?: GovernedActionService;
	identities?: ServeAuditIdentities;
	approvalOwner?: CapabilityApprovalOwner;
	authority?: ActionAuthority;
	authorizeCapability?: (capabilityId: string) => Promise<GovernedActionDecision>;
	persistTokens?: (values: Record<string, string>) => Promise<void>;
	markConnectionUnhealthy?: () => Promise<void>;
}

export interface GoogleWorkspaceMessageApprovalInput {
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	html?: string;
	filename?: string;
	mimeType?: string;
	contentBase64?: string;
}

interface MessageInput extends GoogleWorkspaceMessageApprovalInput {
	receiptId: string;
}

export interface GoogleWorkspaceApprovalRequest {
	capabilityId: string;
	providerId: "google-workspace";
	connectionId: typeof CONNECTION_ID;
	action: "draft" | "send" | "attach" | "delete";
	target: string;
	binding: CapabilityApprovalActionBinding;
}

interface BoundGoogleWorkspaceMessageApproval {
	request: GoogleWorkspaceApprovalRequest;
	dispatchInput: GoogleWorkspaceMessageApprovalInput;
}

export function bindGoogleWorkspaceMessageApproval(
	action: "draft" | "send" | "attach",
	input: GoogleWorkspaceMessageApprovalInput,
): BoundGoogleWorkspaceMessageApproval {
	if (input.to.length === 0 || input.to.length > 50) throw new Error("Gmail approval requires 1-50 recipients");
	if (input.cc && input.cc.length > 50) throw new Error("Gmail approval allows at most 50 copied recipients");
	const to = input.to.map((address) => boundedHeader(address, "Gmail recipient", 3, 320));
	const cc = input.cc?.map((address) => boundedHeader(address, "Gmail copied recipient", 3, 320));
	const subject = boundedHeader(input.subject, "Gmail subject", 0, 998);
	const text = boundedTextInput(input.text, "Gmail text body", 500_000);
	const html = input.html ? boundedTextInput(input.html, "Gmail HTML body", 500_000) : undefined;
	const filename =
		input.filename === undefined ? undefined : boundedHeader(input.filename, "Gmail attachment filename", 1, 255);
	const normalizedMimeType =
		input.mimeType === undefined
			? undefined
			: mimeType(boundedTextInput(input.mimeType, "Gmail attachment MIME type", 127, 1));
	if (input.contentBase64 !== undefined) {
		boundedTextInput(input.contentBase64, "Gmail attachment content", 1_500_000, 1);
	}
	if (action === "attach" && (!filename || !normalizedMimeType || !input.contentBase64)) {
		throw new Error("Gmail attachment approval requires filename, MIME type, and content");
	}
	const attachmentBytes = input.contentBase64 === undefined ? undefined : Buffer.from(input.contentBase64, "base64");
	if (attachmentBytes && attachmentBytes.byteLength > 1_000_000) throw new Error("Gmail attachment exceeds 1 MB");
	const contentBase64 = attachmentBytes?.toString("base64");
	const dispatchInput: GoogleWorkspaceMessageApprovalInput = compact({
		to,
		cc: cc && cc.length > 0 ? cc : undefined,
		subject,
		text,
		html,
		filename,
		mimeType: normalizedMimeType,
		contentBase64,
	});
	const target = [...to, ...(dispatchInput.cc ?? [])].join(",");
	return {
		request: {
			capabilityId: `email.${action}`,
			providerId: "google-workspace",
			connectionId: CONNECTION_ID,
			action,
			target,
			binding: createCapabilityApprovalActionBinding(
				{
					version: 1,
					capabilityId: `email.${action}`,
					providerId: "google-workspace",
					connectionId: CONNECTION_ID,
					action,
					input: {
						to,
						cc: dispatchInput.cc ?? null,
						subject: dispatchInput.subject,
						text: dispatchInput.text,
						html: dispatchInput.html ?? null,
						filename: dispatchInput.filename ?? null,
						mimeType: dispatchInput.mimeType ?? null,
						attachmentContentDigest: attachmentBytes
							? createHash("sha256").update(attachmentBytes).digest("hex")
							: null,
					},
				},
				`${display(action)} Gmail message to ${target}`,
			),
		},
		dispatchInput,
	};
}

export function bindGoogleWorkspaceDeleteApproval(messageId: string): GoogleWorkspaceApprovalRequest {
	const target = requiredString(messageId, "Gmail message ID");
	return {
		capabilityId: "email.delete",
		providerId: "google-workspace",
		connectionId: CONNECTION_ID,
		action: "delete",
		target,
		binding: createCapabilityApprovalActionBinding(
			{
				version: 1,
				capabilityId: "email.delete",
				providerId: "google-workspace",
				connectionId: CONNECTION_ID,
				action: "delete",
				input: { messageId: target },
			},
			`Move Gmail message ${target} to trash`,
		),
	};
}

/** Creates Gmail tools whose credentials remain outside model context. */
export function createGoogleWorkspaceTools(options: GoogleWorkspaceToolOptions): ToolDefinition[] {
	const client = new GmailClient(options);
	return [
		{
			name: "google_workspace_email_search",
			label: "email_search",
			description: "Search the connected Gmail account and return bounded message identifiers and snippets.",
			parameters: Type.Object({
				query: Type.String({ minLength: 1, maxLength: 500 }),
				maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
			}),
			executionMode: "parallel",
			async execute(_id, { query, maxResults = 10 }, signal) {
				return governedResult(options, "email.search", { query, maxResults }, signal, async () =>
					textResult(
						normalizeSearchResult(
							await client.request("/messages", signal, { q: query, maxResults: String(maxResults) }),
						),
					),
				);
			},
		},
		{
			name: "google_workspace_email_read",
			label: "email_read",
			description: "Read one message from the connected Gmail account by message ID with an optional body limit.",
			parameters: Type.Object({
				messageId: Type.String({ minLength: 1, maxLength: 256 }),
				maxBodyChars: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_MESSAGE_TEXT_CHARS })),
			}),
			executionMode: "parallel",
			async execute(_id, { messageId, maxBodyChars = MAX_MESSAGE_TEXT_CHARS }, signal) {
				return governedResult(options, "email.read", { messageId }, signal, async () =>
					textResult(
						normalizeMessage(
							await client.request(`/messages/${encodeURIComponent(messageId)}`, signal, { format: "full" }),
							maxBodyChars,
						),
					),
				);
			},
		},
		messageWriteTool("draft", "drafts", client, options),
		messageWriteTool("send", "messages/send", client, options),
		messageWriteTool("attach", "drafts", client, options, true),
		{
			name: "google_workspace_email_delete",
			label: "email_delete",
			description: "Move one Gmail message to trash using a matching approval receipt.",
			parameters: Type.Object({
				messageId: Type.String({ minLength: 1, maxLength: 256 }),
				receiptId: Type.String({ minLength: 1, maxLength: 128 }),
			}),
			async execute(_id, { messageId, receiptId }, signal) {
				const approval = bindGoogleWorkspaceDeleteApproval(messageId);
				return approvedResult(options, receiptId, approval, signal, async () => {
					await client.request(
						`/messages/${encodeURIComponent(approval.target)}/trash`,
						signal,
						undefined,
						"POST",
					);
					return { trashed: true, messageId: approval.target };
				});
			},
		},
	];
}

function messageWriteTool(
	action: "draft" | "send" | "attach",
	path: string,
	client: GmailClient,
	options: GoogleWorkspaceToolOptions,
	attachment = false,
): ToolDefinition {
	return {
		name: `google_workspace_email_${action}`,
		label: `email_${action}`,
		description: `${display(action)} a Gmail message using a matching approval receipt.`,
		parameters: Type.Object({
			to: Type.Array(Type.String({ minLength: 3, maxLength: 320 }), { minItems: 1, maxItems: 50 }),
			cc: Type.Optional(Type.Array(Type.String({ minLength: 3, maxLength: 320 }), { maxItems: 50 })),
			subject: Type.String({ maxLength: 998 }),
			text: Type.String({ maxLength: 500_000 }),
			html: Type.Optional(Type.String({ maxLength: 500_000 })),
			receiptId: Type.String({ minLength: 1, maxLength: 128 }),
			filename: attachment ? Type.String({ minLength: 1, maxLength: 255 }) : Type.Optional(Type.String()),
			mimeType: attachment ? Type.String({ minLength: 1, maxLength: 127 }) : Type.Optional(Type.String()),
			contentBase64: attachment ? Type.String({ minLength: 1, maxLength: 1_500_000 }) : Type.Optional(Type.String()),
		}),
		async execute(_id, input, signal) {
			const message = input as MessageInput;
			const bound = bindGoogleWorkspaceMessageApproval(action, message);
			return approvedResult(options, message.receiptId, bound.request, signal, async (idempotencyKey) => {
				const raw = mimeMessage({ ...bound.dispatchInput, idempotencyKey });
				const body = action === "send" ? { raw } : { message: { raw } };
				return normalizeWriteResult(
					action,
					bound.request.target,
					await client.request(`/${path}`, signal, undefined, "POST", body),
				);
			});
		},
	};
}

class GmailClient {
	readonly #credentials: CredentialStore | undefined;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #persistTokens: ((values: Record<string, string>) => Promise<void>) | undefined;
	readonly #markConnectionUnhealthy: (() => Promise<void>) | undefined;
	readonly #authority: ActionAuthority | undefined;

	constructor(options: GoogleWorkspaceToolOptions) {
		this.#credentials = options.credentials;
		this.#environment = options.environment ?? process.env;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#persistTokens = options.persistTokens;
		this.#markConnectionUnhealthy = options.markConnectionUnhealthy;
		this.#authority = options.authority;
	}

	async request(
		path: string,
		signal: AbortSignal | undefined,
		query?: Record<string, string>,
		method = "GET",
		body?: unknown,
	): Promise<unknown> {
		const url = new URL(`${API_ROOT}${path}`);
		for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
		let token = await this.#accessToken(signal);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			assertProviderAuthority(this.#authority, signal);
			const response = await this.#fetch(url, {
				method,
				signal,
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/json",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			if (response.status === 401 && attempt === 0) {
				token = await this.#refresh(signal);
				continue;
			}
			if (!response.ok) throw new Error(`Gmail request failed with HTTP ${response.status}`);
			if (response.status === 204) return {};
			return JSON.parse(await boundedText(response)) as unknown;
		}
		throw new Error("Gmail authorization failed after token refresh");
	}

	async #accessToken(signal: AbortSignal | undefined): Promise<string> {
		const credentials = await this.#resolveCredentials(["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_EXPIRES_AT"]);
		const token = credentials.GOOGLE_OAUTH_ACCESS_TOKEN;
		const expiresAt = Number(credentials.GOOGLE_OAUTH_EXPIRES_AT);
		if (token && Number.isFinite(expiresAt) && expiresAt > this.#now() + 60_000) return token;
		return this.#refresh(signal);
	}

	async #refresh(signal: AbortSignal | undefined): Promise<string> {
		try {
			const credentials = await this.#resolveCredentials([
				"GOOGLE_CLIENT_ID",
				"GOOGLE_CLIENT_SECRET",
				"GOOGLE_OAUTH_REFRESH_TOKEN",
			]);
			assertProviderAuthority(this.#authority, signal);
			const response = await this.#fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				signal,
				headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
				body: new URLSearchParams({
					client_id: requiredCredential(credentials, "GOOGLE_CLIENT_ID"),
					client_secret: requiredCredential(credentials, "GOOGLE_CLIENT_SECRET"),
					refresh_token: requiredCredential(credentials, "GOOGLE_OAUTH_REFRESH_TOKEN"),
					grant_type: "refresh_token",
				}),
			});
			if (!response.ok) throw new Error(`Google token refresh failed with HTTP ${response.status}`);
			const payload = record((await response.json()) as unknown, "Google token response");
			const token = requiredString(payload.access_token, "Google access token");
			const expiresAt = String(this.#now() + positiveInteger(payload.expires_in, "Google token expiry") * 1000);
			const values = { GOOGLE_OAUTH_ACCESS_TOKEN: token, GOOGLE_OAUTH_EXPIRES_AT: expiresAt };
			if (this.#credentials) {
				await this.#credentials.replace("google-workspace", { values });
			} else {
				await this.#persistTokens?.(values);
				this.#environment.GOOGLE_OAUTH_ACCESS_TOKEN = token;
				this.#environment.GOOGLE_OAUTH_EXPIRES_AT = expiresAt;
			}
			return token;
		} catch (error) {
			if (!isGovernedActionCancellation(error) && !signal?.aborted) await this.#markConnectionUnhealthy?.();
			throw error;
		}
	}

	async #resolveCredentials(names: readonly string[]): Promise<Readonly<Record<string, string>>> {
		if (this.#credentials) return this.#credentials.resolveTrusted("google-workspace", names);
		const values: Record<string, string> = {};
		for (const name of names) {
			const value = this.#environment[name]?.trim();
			if (value) values[name] = value;
		}
		return values;
	}
}

async function approvedResult(
	options: GoogleWorkspaceToolOptions,
	receiptId: string,
	approval: GoogleWorkspaceApprovalRequest,
	signal: AbortSignal | undefined,
	operation: (idempotencyKey: string) => Promise<unknown>,
) {
	const owner = approvalOwner(options);
	const begun = await options.approvals.begin(receiptId, {
		...approval,
		owner,
	});
	if (begun.kind === "replay") return textResult(begun.result);
	try {
		return await governedResult(
			options,
			approval.capabilityId,
			{ action: approval.action, target: approval.target, approval: receiptId },
			signal,
			async () => {
				const result = await operation(begun.receipt.idempotencyKey);
				await options.approvals.complete(receiptId, result);
				return textResult(result);
			},
			receiptId,
		);
	} catch (error) {
		if (isGovernedActionCancellation(error) || signal?.aborted || options.authority?.signal?.aborted) {
			await options.approvals.cancel(receiptId, error instanceof Error ? error.message : "Action was cancelled");
		} else {
			await options.approvals.fail(receiptId, error instanceof Error ? error.message : String(error));
		}
		throw error;
	}
}

async function governedResult<TResult>(
	options: GoogleWorkspaceToolOptions,
	capabilityId: string,
	target: Record<string, unknown>,
	signal: AbortSignal | undefined,
	operation: () => Promise<TResult>,
	approval?: string,
): Promise<TResult> {
	if (!options.governedActions) {
		assertProviderAuthority(options.authority, signal);
		return operation();
	}
	const result = await options.governedActions.execute({
		family: "provider.call",
		target,
		identities: options.identities,
		authority: scopedAuthority(options.authority, signal),
		canonicalize: (value) => ({
			providerId: "google-workspace",
			connectionId: CONNECTION_ID,
			capabilityId,
			...value,
		}),
		authorize: async () => {
			const decision = options.authorizeCapability
				? await options.authorizeCapability(capabilityId)
				: { decision: "allow" as const, reason: "Trusted provider adapter" };
			return approval && decision.decision === "allow" ? { ...decision, approval } : decision;
		},
		dispatch: operation,
	});
	if (result.status === "denied") throw new Error(`Provider action denied: ${result.reason}`);
	return result.value;
}

function mimeMessage(input: {
	to: string[];
	cc?: string[];
	subject: string;
	text: string;
	html?: string;
	filename?: string;
	mimeType?: string;
	contentBase64?: string;
	idempotencyKey: string;
}): string {
	const headers = [
		`To: ${addressList(input.to)}`,
		...(input.cc?.length ? [`Cc: ${addressList(input.cc)}`] : []),
		`Subject: ${header(input.subject)}`,
		`X-Pi-Idempotency-Key: ${header(input.idempotencyKey)}`,
		"MIME-Version: 1.0",
	];
	const boundary = `pi-${input.idempotencyKey}`;
	const alternative = input.html
		? [
				`Content-Type: multipart/alternative; boundary="${boundary}-alt"`,
				"",
				`--${boundary}-alt`,
				bodyPart("text/plain", input.text),
				`--${boundary}-alt`,
				bodyPart("text/html", input.html),
				`--${boundary}-alt--`,
			].join("\r\n")
		: bodyPart("text/plain", input.text);
	let message = [
		...headers,
		...(input.contentBase64 ? [`Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`] : [""]),
		alternative,
	].join("\r\n");
	if (input.contentBase64) {
		const bytes = Buffer.from(input.contentBase64, "base64");
		if (bytes.byteLength > 1_000_000) throw new Error("Gmail attachment exceeds 1 MB");
		message += `\r\n--${boundary}\r\nContent-Type: ${mimeType(input.mimeType ?? "application/octet-stream")}\r\nContent-Disposition: attachment; filename="${quotedParameter(input.filename ?? "attachment")}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${bytes.toString("base64")}\r\n--${boundary}--`;
	}
	return Buffer.from(message, "utf8").toString("base64url");
}

function addressList(values: string[]): string {
	return values.map((value) => header(value.trim())).join(", ");
}

function header(value: string): string {
	if (/[\r\n]/.test(value)) throw new Error("Email headers must not contain line breaks");
	return value;
}

function boundedHeader(value: string, name: string, minimum: number, maximum: number): string {
	return header(boundedTextInput(value.trim(), name, maximum, minimum));
}

function boundedTextInput(value: string, name: string, maximum: number, minimum = 0): string {
	if (value.length < minimum || value.length > maximum) {
		throw new Error(`${name} must contain ${minimum}-${maximum} characters`);
	}
	return value;
}

function bodyPart(type: "text/plain" | "text/html", value: string): string {
	return [
		`Content-Type: ${type}; charset=utf-8`,
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.from(value).toString("base64"),
	].join("\r\n");
}

function mimeType(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(value)) {
		throw new Error("Gmail attachment MIME type is invalid");
	}
	return value;
}

function quotedParameter(value: string): string {
	header(value);
	return value.replace(/(["\\])/g, "\\$1");
}

function normalizeSearchResult(value: unknown): unknown {
	const input = record(value, "Gmail search response");
	const messages = Array.isArray(input.messages)
		? input.messages.slice(0, 25).map((entry) => {
				const message = record(entry, "Gmail search message");
				return {
					id: requiredString(message.id, "Gmail message ID"),
					threadId: optionalString(message.threadId),
				};
			})
		: [];
	return {
		messages,
		nextPageToken: optionalString(input.nextPageToken),
		resultSizeEstimate: optionalNonNegativeInteger(input.resultSizeEstimate),
	};
}

function normalizeMessage(value: unknown, maxBodyChars: number): unknown {
	const input = record(value, "Gmail message response");
	const payload = input.payload === undefined ? undefined : record(input.payload, "Gmail message payload");
	const body = extractMessageText(payload);
	const headers: Record<string, string> = {};
	if (Array.isArray(payload?.headers)) {
		for (const entry of payload.headers) {
			const item = record(entry, "Gmail message header");
			const name = optionalString(item.name)?.toLowerCase();
			const headerValue = optionalString(item.value);
			if (name && headerValue && ["from", "to", "cc", "subject", "date"].includes(name)) headers[name] = headerValue;
		}
	}
	return {
		id: requiredString(input.id, "Gmail message ID"),
		threadId: optionalString(input.threadId),
		labelIds: stringList(input.labelIds, 100),
		snippet: optionalString(input.snippet)?.slice(0, 1_000),
		internalDate: optionalString(input.internalDate),
		sizeEstimate: optionalNonNegativeInteger(input.sizeEstimate),
		headers,
		body: body.slice(0, maxBodyChars),
		truncated: body.length > maxBodyChars,
	};
}

function extractMessageText(part: Record<string, unknown> | undefined): string {
	if (!part) return "";
	const body = part.body === undefined ? undefined : record(part.body, "Gmail message body");
	const data = optionalString(body?.data);
	if (data && (!part.mimeType || part.mimeType === "text/plain" || part.mimeType === "text/html")) {
		return Buffer.from(data, "base64url").toString("utf8");
	}
	if (!Array.isArray(part.parts)) return "";
	return part.parts
		.map((entry) => extractMessageText(record(entry, "Gmail message part")))
		.filter(Boolean)
		.join("\n");
}

function normalizeWriteResult(action: "draft" | "send" | "attach", target: string, value: unknown): unknown {
	const input = record(value, `Gmail ${action} response`);
	const message = action === "draft" || action === "attach" ? record(input.message, "Gmail draft message") : input;
	return {
		action,
		target,
		id: requiredString(input.id, `Gmail ${action} ID`),
		messageId: optionalString(message.id),
		threadId: optionalString(message.threadId),
	};
}

async function boundedText(response: Response): Promise<string> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Gmail response exceeds 2 MB");
	return new TextDecoder().decode(bytes);
}

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function requiredCredential(credentials: Readonly<Record<string, string>>, name: string): string {
	return requiredString(credentials[name], name);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is unavailable`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function stringList(value: unknown, maximum: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string").slice(0, maximum);
}

function positiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} is invalid`);
	return Number(value);
}

function display(value: string): string {
	return value[0]!.toUpperCase() + value.slice(1);
}

function approvalOwner(options: GoogleWorkspaceToolOptions): CapabilityApprovalOwner {
	const owner = options.authority?.owner ?? options.approvalOwner;
	if (!owner) throw new Error("Google Workspace write requires an explicit approval owner");
	if (
		options.authority &&
		options.approvalOwner &&
		(options.authority.owner.kind !== options.approvalOwner.kind ||
			options.authority.owner.id !== options.approvalOwner.id)
	) {
		throw new Error("Google Workspace approval owner does not match action authority");
	}
	return owner;
}

function assertProviderAuthority(authority: ActionAuthority | undefined, signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GovernedActionCancelledError("Google Workspace action was cancelled");
	assertActionAuthority(authority);
}

function scopedAuthority(
	authority: ActionAuthority | undefined,
	signal: AbortSignal | undefined,
): ActionAuthority | undefined {
	if (!authority) return undefined;
	return {
		owner: authority.owner,
		signal: signal ?? authority.signal,
		assertLive: () => {
			if (signal?.aborted) throw new GovernedActionCancelledError("Google Workspace action was cancelled");
			assertActionAuthority(authority);
		},
	};
}

function compact<T extends object>(value: T): T {
	for (const key of Object.keys(value)) {
		if (value[key as keyof T] === undefined) delete value[key as keyof T];
	}
	return value;
}
