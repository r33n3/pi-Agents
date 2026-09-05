/** A narrow deterministic recipe for the initial inventory example, not a general CSV engine. */
export interface InventoryFacts {
	rowCount: number;
	totalValue: number;
	lineValues: number[];
	duplicateItems: string[];
}

export function inventoryFacts(content: string): InventoryFacts | undefined {
	const lines = content
		.replace(/^\uFEFF/, "")
		.trimEnd()
		.split(/\r?\n/);
	if (lines[0]?.trim() !== "item,quantity,unit_price") return undefined;
	const items = new Set<string>();
	const duplicateItems = new Set<string>();
	const lineValues: number[] = [];
	let totalCents = 0n;
	for (const [index, line] of lines.slice(1).entries()) {
		// This first recipe intentionally rejects quoted/multiline CSV rather than guessing its meaning.
		const fields = line.split(",").map((field) => field.trim());
		const [item, quantity, price] = fields;
		if (
			fields.length !== 3 ||
			!item ||
			item.includes('"') ||
			!quantity ||
			!/^\d+$/.test(quantity) ||
			!price ||
			!/^\d+(?:\.\d{1,2})?$/.test(price)
		) {
			throw new Error(
				`Inventory row ${index + 2} is invalid or unsupported. Expected an item, nonnegative integer quantity, and price with at most two decimal places.`,
			);
		}
		const [whole, fraction = ""] = price.split(".");
		const cents = BigInt(quantity) * (BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")));
		totalCents += cents;
		if (totalCents > BigInt(Number.MAX_SAFE_INTEGER))
			throw new Error("Inventory total exceeds the supported numeric range");
		lineValues.push(Number(cents) / 100);
		if (items.has(item)) duplicateItems.add(item);
		items.add(item);
	}
	return {
		rowCount: lineValues.length,
		totalValue: Number(totalCents) / 100,
		lineValues,
		duplicateItems: [...duplicateItems],
	};
}

/** Checks the structured inventory answer; arbitrary prose still requires task-specific evaluation. */
export function verifyInventoryOutput(output: string, facts: InventoryFacts | undefined): void {
	if (!facts) return;
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		return;
	}
	if (typeof value !== "object" || value === null || (!("totalValue" in value) && !("rowCount" in value))) return;
	if (
		!("rowCount" in value) ||
		value.rowCount !== facts.rowCount ||
		!("totalValue" in value) ||
		value.totalValue !== facts.totalValue
	) {
		throw new Error(
			`Inventory output verification failed: expected rowCount ${facts.rowCount} and totalValue ${facts.totalValue}.`,
		);
	}
}
