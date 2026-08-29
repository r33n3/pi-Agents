import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { ProviderAuthenticationManifest } from "../src/core/serve/capability-broker.ts";
import { CapabilityConnectionRegistry } from "../src/core/serve/capability-connection-registry.ts";
import { PlaidConnectionService } from "../src/core/serve/plaid-connection.ts";
import { createPlaidTools } from "../src/core/serve/plaid-tools.ts";
import { ProviderEnvironmentStore } from "../src/core/serve/provider-environment-store.ts";

describe("PlaidConnectionService", () => {
	let root: string;
	let connections: CapabilityConnectionRegistry;
	let credentials: ProviderEnvironmentStore;
	const manifest: ProviderAuthenticationManifest = {
		kind: "plaid-link",
		fields: [
			{ env: "PLAID_CLIENT_ID", label: "Client ID", required: true, secret: false },
			{ env: "PLAID_SECRET", label: "Secret", required: true, secret: true },
			{ env: "PLAID_ENV", label: "Environment", required: true, secret: false },
			{
				env: "PLAID_ITEMS_JSON",
				label: "Items",
				required: false,
				secret: true,
				operatorEditable: false,
			},
		],
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-plaid-"));
		connections = new CapabilityConnectionRegistry(join(root, "connections"));
		await connections.initialize();
		credentials = new ProviderEnvironmentStore(root, () => manifest, {
			environment: {
				PLAID_CLIENT_ID: "client-id",
				PLAID_SECRET: "client-secret",
				PLAID_ENV: "sandbox",
			},
			platform: "linux",
			passphrase: "correct horse battery staple",
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("creates Link tokens with server-side credentials", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(JSON.stringify({ link_token: "link-sandbox", expiration: "2026-08-28T00:00:00Z" }), {
				status: 200,
			}),
		);
		const service = new PlaidConnectionService(credentials, connections, {
			fetch: request,
			clientUserId: "local-user",
		});

		await expect(service.startLink()).resolves.toEqual({
			linkToken: "link-sandbox",
			expiration: "2026-08-28T00:00:00Z",
		});
		expect(request).toHaveBeenCalledWith(
			"https://sandbox.plaid.com/link/token/create",
			expect.objectContaining({ method: "POST" }),
		);
		const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
		expect(body).toMatchObject({ client_id: "client-id", secret: "client-secret", products: ["transactions"] });
	});

	test("exchanges an Item, redacts its token, and restricts account reads to the saved grant", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "access-sandbox", item_id: "item-sandbox" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						accounts: [
							{
								account_id: "account-1",
								name: "Credit Card",
								official_name: "Test Credit Card",
								type: "credit",
								subtype: "credit card",
								mask: "1234",
								balances: { current: 42.5, limit: 1000, iso_currency_code: "USD" },
							},
						],
					}),
					{ status: 200 },
				),
			);
		const service = new PlaidConnectionService(credentials, connections, { fetch: request });
		const linked = await service.completeLink("public-sandbox", { id: "ins_1", name: "Test Bank" });

		expect(linked).toMatchObject({ accountLabel: "Test Bank" });
		const connection = await connections.get(linked.connectionId);
		expect(connection).toMatchObject({
			providerId: "plaid",
			accountLabel: "Test Bank",
			capabilityIds: ["finance.accounts", "finance.spending", "finance.transactions"],
		});
		expect(JSON.stringify(connection)).not.toContain("access-sandbox");
		expect(await connections.get("plaid-all")).toMatchObject({
			accountLabel: "All linked financial accounts",
			providerId: "plaid",
		});
		await expect(service.listAccounts(["plaid-all"])).resolves.toMatchObject([
			{ accountId: "account-1", institutionName: "Test Bank", balances: { current: 42.5 } },
		]);
		await expect(service.listAccounts(["plaid-000000000000000000000000"])).rejects.toThrow("was not found");
		await expect(readFile(join(root, ".env.local"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect((await credentials.status("plaid")).fields.find((field) => field.env === "PLAID_ITEMS_JSON")).toEqual(
			expect.objectContaining({ configured: true, secret: true }),
		);
	});

	test("summarizes spending through the aggregate account grant", async () => {
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ access_token: "access-sandbox", item_id: "item-sandbox" }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						total_transactions: 3,
						transactions: [
							{
								transaction_id: "txn-1",
								account_id: "account-1",
								date: "2026-08-26",
								name: "Groceries",
								merchant_name: "Market",
								amount: 12.5,
								iso_currency_code: "USD",
								pending: false,
								personal_finance_category: { primary: "FOOD_AND_DRINK" },
							},
							{
								transaction_id: "txn-2",
								account_id: "account-1",
								date: "2026-08-26",
								name: "Pending",
								amount: 4,
								pending: true,
							},
							{
								transaction_id: "txn-3",
								account_id: "account-1",
								date: "2026-08-25",
								name: "Refund",
								amount: -2,
								pending: false,
							},
						],
					}),
					{ status: 200 },
				),
			);
		const service = new PlaidConnectionService(credentials, connections, { fetch: request });
		await service.completeLink("public-sandbox", { name: "Test Bank" });
		const tool = createPlaidTools(service, () => ["plaid-all"]).find(
			(entry) => entry.name === "plaid_finance_spending_summary",
		);
		if (!tool) throw new Error("Plaid spending tool was not created");
		const result = await tool.execute(
			"summary-1",
			{ startDate: "2026-08-01", endDate: "2026-08-27" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const content = result.content[0]?.type === "text" ? JSON.parse(result.content[0].text) : undefined;
		expect(content).toMatchObject({ total: 12.5, pending: 4 });
		expect(content).toMatchObject({ byCategory: [{ name: "FOOD_AND_DRINK", amount: 12.5, count: 1 }] });
		expect(JSON.stringify(result)).not.toContain("access-sandbox");
	});
});
