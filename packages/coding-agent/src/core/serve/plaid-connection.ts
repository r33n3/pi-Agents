import { createHash, randomUUID } from "node:crypto";
import type { CapabilityConnectionRegistry } from "./capability-connection-registry.ts";
import type { CredentialStore } from "./credential-store.ts";

const PROVIDER_ID = "plaid";
const ITEM_STORE_FIELD = "PLAID_ITEMS_JSON";
const AGGREGATE_CONNECTION_ID = "plaid-all";
const MAX_RESPONSE_BYTES = 2_000_000;
const READ_CAPABILITIES = ["finance.accounts", "finance.transactions", "finance.spending"] as const;

export interface PlaidLinkStart {
	linkToken: string;
	expiration: string;
}

export interface PlaidInstitutionMetadata {
	id?: string;
	name?: string;
}

export interface PlaidAccount {
	connectionId: string;
	institutionName: string;
	accountId: string;
	name: string;
	officialName?: string;
	type: string;
	subtype?: string;
	mask?: string;
	balances: { available?: number; current?: number; limit?: number; isoCurrencyCode?: string };
}

export interface PlaidTransaction {
	connectionId: string;
	institutionName: string;
	transactionId: string;
	accountId: string;
	date: string;
	authorizedDate?: string;
	name: string;
	merchantName?: string;
	amount: number;
	isoCurrencyCode?: string;
	pending: boolean;
	category?: string;
}

interface StoredPlaidItem {
	accessToken: string;
	itemId: string;
	institutionId?: string;
	institutionName: string;
}

interface PlaidApiConfiguration {
	clientId: string;
	secret: string;
	baseUrl: string;
}

/** Keeps Plaid Link exchange and Item tokens behind the trusted provider boundary. */
export class PlaidConnectionService {
	readonly #credentials: CredentialStore;
	readonly #connections: CapabilityConnectionRegistry;
	readonly #fetch: typeof fetch;
	readonly #clientUserId: string;

	constructor(
		credentials: CredentialStore,
		connections: CapabilityConnectionRegistry,
		options: { fetch?: typeof fetch; clientUserId?: string } = {},
	) {
		this.#credentials = credentials;
		this.#connections = connections;
		this.#fetch = options.fetch ?? fetch;
		this.#clientUserId = options.clientUserId ?? `pi-local-${randomUUID()}`;
	}

	async startLink(signal?: AbortSignal): Promise<PlaidLinkStart> {
		const payload = record(
			await this.#request(
				"/link/token/create",
				{
					client_name: "Pi Agents",
					country_codes: ["US"],
					language: "en",
					products: ["transactions"],
					user: { client_user_id: this.#clientUserId },
				},
				signal,
			),
			"Plaid Link token response",
		);
		return {
			linkToken: requiredString(payload.link_token, "Plaid Link token"),
			expiration: requiredString(payload.expiration, "Plaid Link token expiration"),
		};
	}

	async completeLink(
		publicToken: string,
		institution: PlaidInstitutionMetadata,
		signal?: AbortSignal,
	): Promise<{ connectionId: string; accountLabel: string }> {
		const exchange = record(
			await this.#request(
				"/item/public_token/exchange",
				{ public_token: requiredString(publicToken, "public token") },
				signal,
			),
			"Plaid token exchange response",
		);
		const accessToken = requiredString(exchange.access_token, "Plaid access token");
		const itemId = requiredString(exchange.item_id, "Plaid Item ID");
		const connectionId = connectionIdFor(itemId);
		const institutionName = normalizedLabel(institution.name) ?? "Financial account";
		const stored = await this.#storedItems();
		stored[connectionId] = {
			accessToken,
			itemId,
			institutionId: optionalString(institution.id),
			institutionName,
		};
		await this.#credentials.replace(PROVIDER_ID, { values: { [ITEM_STORE_FIELD]: JSON.stringify(stored) } });
		await this.#connections.save({
			id: connectionId,
			providerId: PROVIDER_ID,
			accountLabel: institutionName,
			secretRef: `managed:project-environment/${PROVIDER_ID}/${connectionId}`,
			scopes: ["accounts:read", "transactions:read"],
			capabilityIds: [...READ_CAPABILITIES],
			status: "active",
		});
		await this.#connections.save({
			id: AGGREGATE_CONNECTION_ID,
			providerId: PROVIDER_ID,
			accountLabel: "All linked financial accounts",
			secretRef: `managed:project-environment/${PROVIDER_ID}/all`,
			scopes: ["accounts:read", "transactions:read"],
			capabilityIds: [...READ_CAPABILITIES],
			status: "active",
		});
		return { connectionId, accountLabel: institutionName };
	}

	async revokeAll(signal?: AbortSignal): Promise<number> {
		const stored = await this.#storedItems();
		let revoked = 0;
		for (const [connectionId, item] of Object.entries(stored)) {
			try {
				await this.#request("/item/remove", { access_token: item.accessToken }, signal);
			} finally {
				const connection = await this.#connections.get(connectionId);
				if (connection && connection.status !== "revoked") await this.#connections.revoke(connectionId);
				delete stored[connectionId];
				revoked += 1;
			}
		}
		const aggregate = await this.#connections.get(AGGREGATE_CONNECTION_ID);
		if (aggregate && aggregate.status !== "revoked") await this.#connections.revoke(AGGREGATE_CONNECTION_ID);
		await this.#credentials.replace(PROVIDER_ID, {
			values: Object.keys(stored).length > 0 ? { [ITEM_STORE_FIELD]: JSON.stringify(stored) } : undefined,
			revoke: Object.keys(stored).length === 0 ? [ITEM_STORE_FIELD] : undefined,
		});
		return revoked;
	}

	async listAccounts(connectionIds: readonly string[], signal?: AbortSignal): Promise<PlaidAccount[]> {
		const items = await this.#authorizedItems(connectionIds, "finance.accounts");
		const accounts: PlaidAccount[] = [];
		for (const [connectionId, item] of items) {
			const payload = record(
				await this.#request("/accounts/get", { access_token: item.accessToken }, signal),
				"Plaid accounts response",
			);
			for (const value of array(payload.accounts, "Plaid accounts")) {
				const account = record(value, "Plaid account");
				const balances = record(account.balances, "Plaid account balances");
				accounts.push({
					connectionId,
					institutionName: item.institutionName,
					accountId: requiredString(account.account_id, "Plaid account ID"),
					name: requiredString(account.name, "Plaid account name"),
					officialName: optionalString(account.official_name),
					type: requiredString(account.type, "Plaid account type"),
					subtype: optionalString(account.subtype),
					mask: optionalString(account.mask),
					balances: {
						available: optionalNumber(balances.available),
						current: optionalNumber(balances.current),
						limit: optionalNumber(balances.limit),
						isoCurrencyCode: optionalString(balances.iso_currency_code),
					},
				});
			}
		}
		return accounts;
	}

	async listTransactions(
		connectionIds: readonly string[],
		startDate: string,
		endDate: string,
		signal?: AbortSignal,
		capabilityId: "finance.transactions" | "finance.spending" = "finance.transactions",
	): Promise<PlaidTransaction[]> {
		assertDate(startDate, "start date");
		assertDate(endDate, "end date");
		if (startDate > endDate) throw new Error("Plaid start date must not be after end date");
		const items = await this.#authorizedItems(connectionIds, capabilityId);
		const transactions: PlaidTransaction[] = [];
		for (const [connectionId, item] of items) {
			let offset = 0;
			let total = 1;
			while (offset < total && offset < 5_000) {
				const payload = record(
					await this.#request(
						"/transactions/get",
						{
							access_token: item.accessToken,
							start_date: startDate,
							end_date: endDate,
							options: { count: 500, offset },
						},
						signal,
					),
					"Plaid transactions response",
				);
				total = requiredNonNegativeInteger(payload.total_transactions, "Plaid transaction total");
				const page = array(payload.transactions, "Plaid transactions");
				for (const value of page) {
					const transaction = record(value, "Plaid transaction");
					const category = optionalRecord(transaction.personal_finance_category);
					transactions.push({
						connectionId,
						institutionName: item.institutionName,
						transactionId: requiredString(transaction.transaction_id, "Plaid transaction ID"),
						accountId: requiredString(transaction.account_id, "Plaid transaction account ID"),
						date: requiredString(transaction.date, "Plaid transaction date"),
						authorizedDate: optionalString(transaction.authorized_date),
						name: requiredString(transaction.name, "Plaid transaction name"),
						merchantName: optionalString(transaction.merchant_name),
						amount: requiredNumber(transaction.amount, "Plaid transaction amount"),
						isoCurrencyCode: optionalString(transaction.iso_currency_code),
						pending: transaction.pending === true,
						category: optionalString(category?.primary),
					});
				}
				offset += page.length;
				if (page.length === 0) break;
			}
		}
		return transactions.sort((left, right) => right.date.localeCompare(left.date));
	}

	async #authorizedItems(
		connectionIds: readonly string[],
		capabilityId: (typeof READ_CAPABILITIES)[number],
	): Promise<Array<[string, StoredPlaidItem]>> {
		if (connectionIds.length === 0) throw new Error("At least one Plaid connection grant is required");
		const stored = await this.#storedItems();
		const selected: Array<[string, StoredPlaidItem]> = [];
		for (const connectionId of [...new Set(connectionIds)]) {
			await this.#connections.assertGrant(connectionId, PROVIDER_ID, capabilityId);
			if (connectionId === AGGREGATE_CONNECTION_ID) {
				selected.push(...Object.entries(stored));
				continue;
			}
			const item = stored[connectionId];
			if (!item) throw new Error(`Plaid credentials for ${connectionId} are unavailable`);
			selected.push([connectionId, item]);
		}
		return [...new Map(selected).entries()];
	}

	async #storedItems(): Promise<Record<string, StoredPlaidItem>> {
		const credentials = await this.#credentials.resolveTrusted(PROVIDER_ID, [ITEM_STORE_FIELD]);
		const encoded = credentials[ITEM_STORE_FIELD];
		if (!encoded) return {};
		let value: unknown;
		try {
			value = JSON.parse(encoded);
		} catch {
			throw new Error("Stored Plaid Item credentials are invalid");
		}
		const input = record(value, "stored Plaid Items");
		const items: Record<string, StoredPlaidItem> = {};
		for (const [connectionId, entry] of Object.entries(input)) {
			if (!/^plaid-[a-f0-9]{24}$/.test(connectionId)) throw new Error("Stored Plaid connection ID is invalid");
			const item = record(entry, "stored Plaid Item");
			items[connectionId] = {
				accessToken: requiredString(item.accessToken, "stored Plaid access token"),
				itemId: requiredString(item.itemId, "stored Plaid Item ID"),
				institutionId: optionalString(item.institutionId),
				institutionName: requiredString(item.institutionName, "stored Plaid institution name"),
			};
		}
		return items;
	}

	async #request(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const configuration = await this.#configuration();
		const response = await this.#fetch(`${configuration.baseUrl}${path}`, {
			method: "POST",
			signal,
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ client_id: configuration.clientId, secret: configuration.secret, ...body }),
		});
		const text = await boundedText(response);
		let payload: unknown;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`Plaid returned invalid JSON with HTTP ${response.status}`);
		}
		if (!response.ok) {
			const error = optionalRecord(payload);
			throw new Error(optionalString(error?.error_message) ?? `Plaid request failed with HTTP ${response.status}`);
		}
		return payload;
	}

	async #configuration(): Promise<PlaidApiConfiguration> {
		const values = await this.#credentials.resolveTrusted(PROVIDER_ID, [
			"PLAID_CLIENT_ID",
			"PLAID_SECRET",
			"PLAID_ENV",
		]);
		const environment = requiredString(values.PLAID_ENV, "PLAID_ENV").toLowerCase();
		if (environment !== "sandbox" && environment !== "production") {
			throw new Error("PLAID_ENV must be sandbox or production");
		}
		return {
			clientId: requiredString(values.PLAID_CLIENT_ID, "PLAID_CLIENT_ID"),
			secret: requiredString(values.PLAID_SECRET, "PLAID_SECRET"),
			baseUrl: `https://${environment}.plaid.com`,
		};
	}
}

function connectionIdFor(itemId: string): string {
	return `plaid-${createHash("sha256").update(itemId).digest("hex").slice(0, 24)}`;
}

function normalizedLabel(value: unknown): string | undefined {
	const label = optionalString(value)
		?.replace(/[\0\r\n]/g, " ")
		.slice(0, 120)
		.trim();
	return label || undefined;
}

async function boundedText(response: Response): Promise<string> {
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Plaid response exceeds 2 MB");
	return new TextDecoder().decode(bytes);
}

function record(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function array(value: unknown, name: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	return value;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is unavailable`);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is invalid`);
	return value;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} is invalid`);
	return Number(value);
}

function assertDate(value: string, name: string): void {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
		throw new Error(`${name} must use YYYY-MM-DD`);
	}
}
