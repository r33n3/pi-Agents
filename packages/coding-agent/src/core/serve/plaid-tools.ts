import Type from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { PlaidConnectionService, PlaidTransaction } from "./plaid-connection.ts";

export const PLAID_TOOL_NAMES = [
	"plaid_finance_accounts_list",
	"plaid_finance_transactions_search",
	"plaid_finance_spending_summary",
] as const;

/** Creates read-only Plaid tools restricted to the connection grants of one session or agent. */
export function createPlaidTools(
	service: PlaidConnectionService,
	allowedConnectionIds: () => readonly string[],
): ToolDefinition[] {
	return [
		{
			name: PLAID_TOOL_NAMES[0],
			label: "finance_accounts",
			description: "List balances and metadata for the specifically granted Plaid financial accounts.",
			parameters: Type.Object({}),
			executionMode: "parallel",
			async execute(_id, _input, signal) {
				return textResult({ accounts: await service.listAccounts(allowedConnectionIds(), signal) });
			},
		},
		{
			name: PLAID_TOOL_NAMES[1],
			label: "finance_transactions",
			description: "Search posted and pending transactions across the specifically granted Plaid accounts.",
			parameters: Type.Object({
				startDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
				endDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
				query: Type.Optional(Type.String({ maxLength: 200 })),
				maximum: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
			}),
			executionMode: "parallel",
			async execute(_id, { startDate, endDate, query, maximum = 200 }, signal) {
				const normalizedQuery = query?.trim().toLowerCase();
				const transactions = await service.listTransactions(allowedConnectionIds(), startDate, endDate, signal);
				return textResult({
					transactions: transactions
						.filter((transaction) => !normalizedQuery || transactionText(transaction).includes(normalizedQuery))
						.slice(0, maximum),
				});
			},
		},
		{
			name: PLAID_TOOL_NAMES[2],
			label: "finance_spending",
			description: "Summarize spending by category and institution across specifically granted Plaid accounts.",
			parameters: Type.Object({
				startDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
				endDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
			}),
			executionMode: "parallel",
			async execute(_id, { startDate, endDate }, signal) {
				const transactions = await service.listTransactions(
					allowedConnectionIds(),
					startDate,
					endDate,
					signal,
					"finance.spending",
				);
				return textResult(spendingSummary(startDate, endDate, transactions));
			},
		},
	];
}

function spendingSummary(startDate: string, endDate: string, transactions: readonly PlaidTransaction[]) {
	const spending = transactions.filter((transaction) => transaction.amount > 0 && !transaction.pending);
	return {
		startDate,
		endDate,
		total: rounded(spending.reduce((sum, transaction) => sum + transaction.amount, 0)),
		transactionCount: spending.length,
		byCategory: groupedTotals(spending, (transaction) => transaction.category ?? "UNCATEGORIZED"),
		byInstitution: groupedTotals(spending, (transaction) => transaction.institutionName),
		pending: rounded(
			transactions
				.filter((transaction) => transaction.pending && transaction.amount > 0)
				.reduce((sum, transaction) => sum + transaction.amount, 0),
		),
	};
}

function groupedTotals(
	transactions: readonly PlaidTransaction[],
	key: (transaction: PlaidTransaction) => string,
): Array<{ name: string; amount: number; count: number }> {
	const totals = new Map<string, { amount: number; count: number }>();
	for (const transaction of transactions) {
		const name = key(transaction);
		const current = totals.get(name) ?? { amount: 0, count: 0 };
		current.amount += transaction.amount;
		current.count += 1;
		totals.set(name, current);
	}
	return [...totals]
		.map(([name, value]) => ({ name, amount: rounded(value.amount), count: value.count }))
		.sort((left, right) => right.amount - left.amount);
}

function transactionText(transaction: PlaidTransaction): string {
	return [transaction.name, transaction.merchantName, transaction.category, transaction.institutionName]
		.filter((entry): entry is string => entry !== undefined)
		.join(" ")
		.toLowerCase();
}

function rounded(value: number): number {
	return Math.round(value * 100) / 100;
}

function textResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: undefined };
}
