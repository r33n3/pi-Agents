import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import {
	ClientMessageDecoder,
	type Command,
	encodeClientMessage,
	ProtocolValidationError,
	parseClientMessage,
} from "../src/index.ts";
import { ModelControlCapabilitiesSchema } from "../src/schemas.ts";

describe("native model control commands", () => {
	test("transports bounded capability guidance as text without making it a selectable control", () => {
		const check = Compile(ModelControlCapabilitiesSchema);
		const processingTier = {
			values: ["standard", "fast"],
			guidance: "Preview access required; premium prices apply.",
			evidence: { kind: "provider-docs", reference: "synthetic", checkedAt: "2026-08-31" },
		};
		expect(check.Check({ processingTier })).toBe(true);
		for (const guidance of ["", "x".repeat(2001), 1, {}])
			expect(check.Check({ processingTier: { ...processingTier, guidance } })).toBe(false);
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "synthetic",
				request: { command: "set_model_controls", sessionId: "synthetic", modelControls: { guidance: "fast" } },
			}),
		).toThrow(ProtocolValidationError);
	});
	test.each([undefined, null, {}, { reasoningEffort: "high", processingTier: "fast" }])(
		"preserves omitted, legacy, default, and explicit model selections: %j",
		(modelControls) => {
			for (const request of [
				{ command: "create", modelControls },
				{ command: "set_model", sessionId: "fixture", model: { provider: "fixture", id: "model" }, modelControls },
			] satisfies Command[]) {
				const frame = encodeClientMessage({ type: "request", id: "change", request });
				const [decoded] = new ClientMessageDecoder().push(frame);
				expect(decoded).toEqual({ type: "request", id: "change", request: JSON.parse(JSON.stringify(request)) });
			}
		},
	);
	test.each([
		null,
		{},
		{ reasoningBudget: -1 },
		{ reasoningBudget: 0 },
		{ reasoningMode: "enabled", reasoningBudget: 2048 },
	])("accepts explicit native selections without translating sentinel values: %j", (modelControls) => {
		const message = {
			type: "request",
			id: "change",
			request: { command: "set_model_controls", sessionId: "fixture", modelControls },
		} as const;
		expect(parseClientMessage(message)).toEqual(message);
	});
	test.each([
		undefined,
		[],
		"high",
		{ reasoningBudget: -2 },
		{ reasoningBudget: 1.5 },
		{ processingTier: "" },
		{ temperature: 1 },
	])("rejects invalid selection shapes on the wire: %j", (modelControls) => {
		expect(() =>
			parseClientMessage({
				type: "request",
				id: "change",
				request: { command: "set_model_controls", sessionId: "fixture", modelControls },
			}),
		).toThrow(ProtocolValidationError);
	});
});
