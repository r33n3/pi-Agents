import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { ANTHROPIC_FAST_MODELS } from "./anthropic-processing.ts";
import type { ModelAuthConnection } from "./auth/types.ts";
import type { Api, Model } from "./types.ts";

const EvidenceSchema = Type.Object(
	{
		kind: Type.Union([
			Type.Literal("provider-docs"),
			Type.Literal("provider-discovery"),
			Type.Literal("user-override"),
		]),
		reference: Type.String({ minLength: 1 }),
		checkedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const ChoiceControlSchema = Type.Object(
	{
		values: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
		default: Type.Optional(Type.String({ minLength: 1 })),
		/** Source-reviewed guidance, not proof of account access or billed price. Render as text. */
		guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

const BudgetControlSchema = Type.Object(
	{
		minimum: Type.Integer({ minimum: 0 }),
		/** Omitted when the provider bounds the budget by request settings instead. */
		maximum: Type.Optional(Type.Integer({ minimum: 0 })),
		/** Native sentinel values are available only when explicitly documented. */
		automaticValue: Type.Optional(Type.Literal(-1)),
		disabledValue: Type.Optional(Type.Literal(0)),
		default: Type.Optional(Type.Integer({ minimum: -1 })),
		evidence: EvidenceSchema,
	},
	{ additionalProperties: false },
);

/** Absent controls are unverified or not implemented, never inferred as supported. */
export const ModelControlCapabilitiesSchema = Type.Object(
	{
		reasoningMode: Type.Optional(ChoiceControlSchema),
		reasoningEffort: Type.Optional(ChoiceControlSchema),
		reasoningBudget: Type.Optional(BudgetControlSchema),
		processingTier: Type.Optional(ChoiceControlSchema),
	},
	{ additionalProperties: false },
);
export type ModelControlCapabilities = Static<typeof ModelControlCapabilitiesSchema>;

/** Native values, not cross-provider intensity aliases. Omission preserves provider defaults. */
export const ModelControlsSchema = Type.Object(
	{
		reasoningMode: Type.Optional(Type.String({ minLength: 1 })),
		reasoningEffort: Type.Optional(Type.String({ minLength: 1 })),
		reasoningBudget: Type.Optional(Type.Integer({ minimum: -1 })),
		processingTier: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export type ModelControls = Static<typeof ModelControlsSchema>;

/** A rejected user selection, distinct from transport, authentication, or catalog failures. */
export class ModelControlsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelControlsError";
	}
}

const checkCapabilities = Compile(ModelControlCapabilitiesSchema);
const checkControls = Compile(ModelControlsSchema);

export function getModelControlCapabilityErrors(value: unknown): string[] {
	if (!checkCapabilities.Check(value)) return ["controls has an invalid capability schema"];
	const errors: string[] = [];
	for (const control of Object.values(value)) {
		if (!control) continue;
		if (!Number.isFinite(Date.parse(control.evidence.checkedAt)))
			errors.push("controls evidence has an invalid date");
		if ("values" in control) {
			if (control.default !== undefined && !control.values.includes(control.default))
				errors.push("controls default must be a supported value");
		} else if (
			(control.maximum !== undefined && control.minimum > control.maximum) ||
			(control.default !== undefined &&
				control.default !== control.automaticValue &&
				control.default !== control.disabledValue &&
				(control.default < control.minimum || (control.maximum !== undefined && control.default > control.maximum)))
		) {
			errors.push("controls budget range or default is invalid");
		}
	}
	return errors;
}

const OPENAI_REASONING_EVIDENCE = {
	kind: "provider-docs",
	reference: "https://developers.openai.com/api/docs/guides/reasoning",
	checkedAt: "2026-08-31",
} as const;

const GOOGLE_THINKING_EVIDENCE = {
	kind: "provider-docs",
	reference: "https://ai.google.dev/gemini-api/docs/generate-content/thinking",
	checkedAt: "2026-08-31",
} as const;

// Exact IDs only: aliases and other Google APIs require independent review.
const GOOGLE_REVIEWED_EFFORT: Readonly<Record<string, { values: string[]; default: string }>> = {
	"gemini-3-flash-preview": { values: ["minimal", "low", "medium", "high"], default: "high" },
	"gemini-3.1-pro-preview": { values: ["low", "medium", "high"], default: "high" },
	"gemini-3.1-flash-lite": { values: ["minimal", "low", "medium", "high"], default: "minimal" },
	"gemini-3.1-flash-lite-image": { values: ["minimal", "high"], default: "minimal" },
	"gemini-3.5-flash": { values: ["minimal", "low", "medium", "high"], default: "medium" },
	"gemini-3.5-flash-lite": { values: ["minimal", "low", "medium", "high"], default: "minimal" },
	"gemini-3.6-flash": { values: ["minimal", "low", "medium", "high"], default: "medium" },
	"gemini-3.7-flash": { values: ["low", "medium", "high"], default: "medium" },
};
const GOOGLE_REVIEWED_BUDGET: Readonly<
	Record<string, Omit<NonNullable<ModelControlCapabilities["reasoningBudget"]>, "evidence">>
> = {
	"gemini-2.5-pro": { minimum: 128, maximum: 32768, automaticValue: -1, default: -1 },
	"gemini-2.5-flash": { minimum: 0, maximum: 24576, automaticValue: -1, disabledValue: 0, default: -1 },
	"gemini-2.5-flash-lite": { minimum: 512, maximum: 24576, automaticValue: -1, disabledValue: 0, default: 0 },
};

const ANTHROPIC_THINKING_EVIDENCE = {
	kind: "provider-docs",
	reference: "https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting",
	checkedAt: "2026-08-31",
} as const;

// Modes/defaults are independent of effort. No capabilities are inferred for similarly named models.
const ANTHROPIC_REVIEWED: Readonly<Record<string, { modes: string[]; defaultMode: string; efforts?: string[] }>> = {
	"claude-fable-5": {
		modes: ["adaptive"],
		defaultMode: "adaptive",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	"claude-opus-5": {
		modes: ["adaptive", "disabled"],
		defaultMode: "adaptive",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	"claude-sonnet-5": {
		modes: ["adaptive", "disabled"],
		defaultMode: "adaptive",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	"claude-opus-4-8": {
		modes: ["adaptive", "disabled"],
		defaultMode: "disabled",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	"claude-opus-4-7": {
		modes: ["adaptive", "disabled"],
		defaultMode: "disabled",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	"claude-opus-4-6": {
		modes: ["adaptive", "enabled", "disabled"],
		defaultMode: "disabled",
		efforts: ["low", "medium", "high", "max"],
	},
	"claude-sonnet-4-6": {
		modes: ["adaptive", "enabled", "disabled"],
		defaultMode: "disabled",
		efforts: ["low", "medium", "high", "max"],
	},
	"claude-opus-4-5": { modes: ["enabled", "disabled"], defaultMode: "disabled", efforts: ["low", "medium", "high"] },
	"claude-opus-4-5-20251101": {
		modes: ["enabled", "disabled"],
		defaultMode: "disabled",
		efforts: ["low", "medium", "high"],
	},
	"claude-sonnet-4-5": { modes: ["enabled", "disabled"], defaultMode: "disabled" },
	"claude-sonnet-4-5-20250929": { modes: ["enabled", "disabled"], defaultMode: "disabled" },
	"claude-haiku-4-5": { modes: ["enabled", "disabled"], defaultMode: "disabled" },
	"claude-haiku-4-5-20251001": { modes: ["enabled", "disabled"], defaultMode: "disabled" },
};

function isAnthropicPublicAPI(model: Model<Api>): boolean {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	try {
		const url = new URL(model.baseUrl);
		return url.origin === "https://api.anthropic.com" && url.pathname.replace(/\/$/, "") === "";
	} catch {
		return false;
	}
}

/**
 * Narrow reviewed overlay on the existing model catalog. Public API evidence must
 * not leak to Codex OAuth, gateways, or custom endpoints with similar model IDs.
 * Explicit model overrides remain authoritative; adapters still limit which
 * controls they can actually send.
 */
export function getModelControlCapabilities(
	model: Model<Api>,
	connection?: ModelAuthConnection,
): ModelControlCapabilities {
	// Catalog-only queries omit connection. Runtime queries must not turn unknown/OAuth
	// transport into public API-key evidence. Private declarations remain explicit.
	if (!model.controls && connection && connection.type !== "api_key") return {};
	if (connection?.baseUrl !== undefined) model = { ...model, baseUrl: connection.baseUrl };
	let capabilities: ModelControlCapabilities = model.controls ?? {};
	if (
		!model.controls &&
		model.provider === "openai" &&
		model.api === "openai-responses" &&
		["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(model.id)
	) {
		let isPublicAPI = false;
		try {
			const url = new URL(model.baseUrl);
			isPublicAPI = url.origin === "https://api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1";
		} catch {
			/* An invalid/custom endpoint gets no first-party claims. */
		}
		if (isPublicAPI) {
			capabilities = {
				reasoningMode: { values: ["standard", "pro"], default: "standard", evidence: OPENAI_REASONING_EVIDENCE },
				reasoningEffort: {
					values: ["none", "low", "medium", "high", "xhigh", "max"],
					default: "medium",
					evidence: OPENAI_REASONING_EVIDENCE,
				},
			};
			if (model.id === "gpt-5.6-sol")
				capabilities.processingTier = {
					values: ["default", "fast", "priority"],
					guidance:
						"Fast and priority select the same premium API service, independently of reasoning effort. Published GPT-5.6 Sol Fast rates are twice Standard rates, including long-context rates; these are estimates, not account-specific charges. Unset inherits the project's service tier and may use Fast. Choose default to request Standard explicitly. A response may report priority or a downgrade to default. This does not verify account access.",
					evidence: {
						kind: "provider-docs",
						reference: "https://developers.openai.com/api/docs/guides/fast-mode",
						checkedAt: "2026-08-31",
					},
				};
		}
	}
	if (!model.controls && model.provider === "google" && model.api === "google-generative-ai") {
		let isPublicAPI = false;
		try {
			const url = new URL(model.baseUrl);
			isPublicAPI =
				url.origin === "https://generativelanguage.googleapis.com" && url.pathname.replace(/\/$/, "") === "/v1beta";
		} catch {
			/* A custom endpoint receives no first-party claims. */
		}
		if (isPublicAPI) {
			const effort = Object.hasOwn(GOOGLE_REVIEWED_EFFORT, model.id) ? GOOGLE_REVIEWED_EFFORT[model.id] : undefined;
			const budget = Object.hasOwn(GOOGLE_REVIEWED_BUDGET, model.id) ? GOOGLE_REVIEWED_BUDGET[model.id] : undefined;
			capabilities = {
				...(effort ? { reasoningEffort: { ...effort, evidence: GOOGLE_THINKING_EVIDENCE } } : {}),
				...(budget ? { reasoningBudget: { ...budget, evidence: GOOGLE_THINKING_EVIDENCE } } : {}),
			};
		}
	}
	if (!model.controls && isAnthropicPublicAPI(model) && Object.hasOwn(ANTHROPIC_REVIEWED, model.id)) {
		const reviewed = ANTHROPIC_REVIEWED[model.id];
		capabilities = {
			reasoningMode: {
				values: reviewed.modes,
				default: reviewed.defaultMode,
				evidence: ANTHROPIC_THINKING_EVIDENCE,
			},
			...(ANTHROPIC_FAST_MODELS.includes(model.id)
				? {
						processingTier: {
							values: ["standard", "fast"],
							default: "standard",
							guidance:
								"Fast is a restricted research preview on the public Claude API; access requires Anthropic approval. A configured key does not establish eligibility. It changes speed, not reasoning effort or priority capacity. Published global Fast rates are $10 input / $50 output per million tokens; cache and residency modifiers apply. These are public estimates, not your account price. Choose standard for ordinary speed, or leave unset for the provider default.",
							evidence: {
								kind: "provider-docs" as const,
								reference: "https://platform.claude.com/docs/en/build-with-claude/fast-mode",
								checkedAt: "2026-08-31",
							},
						},
					}
				: {}),
			...(reviewed.efforts
				? {
						reasoningEffort: {
							values: reviewed.efforts,
							default: "high",
							evidence: {
								...ANTHROPIC_THINKING_EVIDENCE,
								reference: "https://platform.claude.com/docs/en/build-with-claude/effort",
							},
						},
					}
				: {}),
			...(reviewed.modes.includes("enabled")
				? {
						reasoningBudget: {
							minimum: 1024,
							evidence: {
								...ANTHROPIC_THINKING_EVIDENCE,
								reference: "https://platform.claude.com/docs/en/build-with-claude/extended-thinking",
							},
						},
					}
				: {}),
		};
	}
	const errors = getModelControlCapabilityErrors(capabilities);
	if (errors.length) throw new Error(errors.join("; "));
	// Each adapter is opted in only after it has an exercised serialization path.
	if (model.api !== "openai-responses" && model.api !== "google-generative-ai" && model.api !== "anthropic-messages")
		return {};
	const implemented: ModelControlCapabilities = structuredClone(
		model.api === "google-generative-ai"
			? { reasoningEffort: capabilities.reasoningEffort, reasoningBudget: capabilities.reasoningBudget }
			: model.api === "anthropic-messages"
				? {
						reasoningMode: capabilities.reasoningMode,
						reasoningEffort: capabilities.reasoningEffort,
						reasoningBudget: capabilities.reasoningBudget,
						processingTier: capabilities.processingTier,
					}
				: {
						reasoningMode: capabilities.reasoningMode,
						reasoningEffort: capabilities.reasoningEffort,
						processingTier: capabilities.processingTier,
					},
	);
	for (const key of ["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"] as const) {
		if (implemented[key] === undefined) delete implemented[key];
	}
	const adapterValues =
		model.api === "google-generative-ai"
			? { reasoningEffort: ["minimal", "low", "medium", "high"], processingTier: [] }
			: model.api === "anthropic-messages"
				? { reasoningEffort: ["low", "medium", "high", "xhigh", "max"], processingTier: ["standard", "fast"] }
				: {
						reasoningEffort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
						processingTier: ["auto", "default", "fast", "priority", "flex"],
					};
	for (const key of ["reasoningEffort", "processingTier"] as const) {
		const control = implemented[key];
		if (!control) continue;
		control.values = control.values.filter((value) => adapterValues[key].includes(value));
		if (control.values.length === 0) delete implemented[key];
		else if (control.default !== undefined && !control.values.includes(control.default)) delete control.default;
	}
	if (model.api === "anthropic-messages") {
		const mode = implemented.reasoningMode;
		if (mode) {
			mode.values = mode.values.filter((value) => ["adaptive", "enabled", "disabled"].includes(value));
			if (mode.values.length === 0) delete implemented.reasoningMode;
			else if (mode.default !== undefined && !mode.values.includes(mode.default)) delete mode.default;
		}
		// Anthropic has no numeric automatic/off sentinels. Those are separate thinking modes.
		const budget = implemented.reasoningBudget;
		if (budget) {
			budget.minimum = Math.max(1024, budget.minimum);
			delete budget.automaticValue;
			delete budget.disabledValue;
			if (budget.maximum !== undefined && budget.maximum < budget.minimum) delete implemented.reasoningBudget;
			else if (budget.default !== undefined && budget.default < budget.minimum) delete budget.default;
		}
	}
	return implemented;
}

/** Validate persisted selections before a model or connection is available. */
export function assertModelControls(controls: unknown): asserts controls is ModelControls {
	if (!checkControls.Check(controls)) throw new ModelControlsError("Invalid model controls");
}

/** Validate without clamping, injecting defaults, or performing auth/network work. */
export function validateModelControls(
	model: Model<Api>,
	controls: unknown,
	connection?: ModelAuthConnection,
): asserts controls is ModelControls {
	assertModelControls(controls);
	const capabilities = getModelControlCapabilities(model, connection);
	for (const key of ["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"] as const) {
		const value = controls[key];
		if (value === undefined) continue;
		const capability = capabilities[key];
		if (!capability)
			throw new ModelControlsError(`${key} is not verified or implemented for ${model.provider}/${model.id}`);
		if (typeof value === "number") {
			if (
				!("minimum" in capability) ||
				(value !== capability.automaticValue &&
					value !== capability.disabledValue &&
					(value < capability.minimum || (capability.maximum !== undefined && value > capability.maximum)))
			)
				throw new ModelControlsError(`Unsupported ${key} for ${model.provider}/${model.id}`);
		} else if (!("values" in capability) || !capability.values.includes(value)) {
			throw new ModelControlsError(`Unsupported ${key} for ${model.provider}/${model.id}`);
		}
	}
	if (
		model.api === "google-generative-ai" &&
		controls.reasoningEffort !== undefined &&
		controls.reasoningBudget !== undefined
	)
		throw new ModelControlsError("Choose a Google thinking level or token budget, not both");
	if (model.api === "anthropic-messages") {
		if (controls.reasoningMode === "enabled" && controls.reasoningBudget === undefined)
			throw new ModelControlsError("Anthropic enabled thinking requires an explicit reasoningBudget");
		if (controls.reasoningBudget !== undefined && controls.reasoningMode !== "enabled")
			throw new ModelControlsError("Anthropic reasoningBudget requires reasoningMode enabled");
		if (
			!model.controls &&
			isAnthropicPublicAPI(model) &&
			model.id === "claude-opus-5" &&
			controls.reasoningMode === "disabled" &&
			["xhigh", "max"].includes(controls.reasoningEffort ?? "high")
		)
			throw new ModelControlsError("Claude Opus 5 cannot disable thinking at xhigh or max effort");
	}
}
