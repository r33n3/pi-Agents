import { expect, test } from "vitest";
import { inventoryFacts, verifyInventoryOutput } from "../src/core/serve/inventory-review.ts";

test("calculates the observed regression with exact cents and flags duplicate rows", () => {
	const facts = inventoryFacts("item,quantity,unit_price\nnotebooks,7,7\npens,4,2\npens,2,2\n");
	expect(facts).toEqual({ rowCount: 3, totalValue: 61, lineValues: [49, 8, 4], duplicateItems: ["pens"] });
	expect(() => verifyInventoryOutput('{"rowCount":3,"totalValue":65,"currency":"USD"}', facts)).toThrow(
		"verification failed",
	);
	expect(() => verifyInventoryOutput('{"rowCount":3,"totalValue":61,"currency":"USD"}', facts)).not.toThrow();
	expect(inventoryFacts("item,quantity,unit_price\na,3,0.10\nb,2,0.20")).toMatchObject({ totalValue: 0.7 });
});

test.each(["a,,2", "a,-1,2", "a,1,NaN", "a,1,0.001", '"a,b",1,2', "a,1,2,3", "a,9007199254740992,1"])(
	"fails explicitly on invalid or unsupported inventory rows: %s",
	(row) => {
		expect(() => inventoryFacts(`item,quantity,unit_price\n${row}`)).toThrow();
	},
);

test("leaves other tabular schemas and unstructured team prose outside this recipe", () => {
	expect(inventoryFacts("name,value\na,4")).toBeUndefined();
	expect(() => verifyInventoryOutput("An unstructured answer", undefined)).not.toThrow();
});
