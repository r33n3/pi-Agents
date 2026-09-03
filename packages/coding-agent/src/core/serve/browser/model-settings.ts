import type { ModelControls, ModelMetadata, ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";

export interface ModelSettingsSelection {
	model?: ModelRef;
	thinkingLevel: ThinkingLevel;
	/** Absent uses Pi's legacy thinking mapping; an empty object uses provider defaults. */
	modelControls?: ModelControls;
}

export const choiceLabels = {
	reasoningMode: "Reasoning mode",
	reasoningEffort: "Reasoning effort",
	processingTier: "Processing speed / tier",
} as const;

export type ModelSettingsButtonState = "unavailable" | "available" | "active";

export interface ModelSettingsButtonPresentation {
	state: ModelSettingsButtonState;
	disabled: boolean;
	label: string;
	title: string;
}

/** Keep the control present so capability changes do not shift the layout. */
export function modelSettingsButtonPresentation(
	model: ModelMetadata | undefined,
	controls: ModelControls | undefined,
): ModelSettingsButtonPresentation {
	const modelName = model?.name ?? "this model";
	const hasCapabilities = Boolean(
		model?.controls &&
			["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"].some(
				(key) => model.controls?.[key as keyof NonNullable<ModelMetadata["controls"]>] !== undefined,
			),
	);
	const hasOverrides =
		controls !== undefined &&
		["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"].some(
			(key) => controls[key as keyof ModelControls] !== undefined,
		);
	if (hasOverrides) {
		const description = describeModelControls(controls);
		return {
			state: "active",
			disabled: false,
			label: `Custom model settings active for ${modelName}`,
			title: `Custom model settings active · ${description}`,
		};
	}
	if (hasCapabilities || controls !== undefined) {
		return {
			state: "available",
			disabled: false,
			label: `Model settings available for ${modelName}`,
			title:
				controls === undefined
					? `Additional model settings are available for ${modelName}`
					: `Provider defaults active for ${modelName}; additional model settings are available`,
		};
	}
	return {
		state: "unavailable",
		disabled: true,
		label: `No additional model settings for ${modelName}`,
		title: `No additional model settings are verified for ${modelName}`,
	};
}

/** Checks transport shape only. The runtime owns provider-specific combinations and request limits. */
export function parseModelControls(value: unknown): ModelControls {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Model controls must be an object; use {} for provider defaults.");
	const result: { -readonly [Key in keyof ModelControls]: ModelControls[Key] } = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === "reasoningBudget") {
			if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < -1)
				throw new Error("Reasoning budget must be an integer of -1 or greater.");
			result.reasoningBudget = entry;
		} else if (key === "reasoningMode" || key === "reasoningEffort" || key === "processingTier") {
			if (typeof entry !== "string" || !entry.trim()) throw new Error(`${choiceLabels[key]} must be a value.`);
			result[key] = entry;
		} else throw new Error(`Unknown model control: ${key}`);
	}
	return result;
}

/** Validate only the capability projection, without duplicating provider policy in the browser. */
export function modelSettingsError(
	selection: ModelSettingsSelection,
	models: readonly ModelMetadata[],
): string | undefined {
	const metadata = models.find(
		(entry) => entry.provider === selection.model?.provider && entry.id === selection.model.id,
	);
	if (selection.model && !metadata) return "This model is not in the current catalog. Choose an available model.";
	if (selection.modelControls === undefined) {
		if (metadata && !metadata.supportedThinkingLevels.includes(selection.thinkingLevel))
			return `The legacy thinking level ${selection.thinkingLevel} is not supported by this model.`;
		return undefined;
	}
	if (!metadata) return "Choose an explicit model before setting provider-native controls.";
	let controls: ModelControls;
	try {
		controls = parseModelControls(selection.modelControls);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	for (const key of ["reasoningMode", "reasoningEffort", "processingTier"] as const) {
		const value = controls[key];
		if (value !== undefined && !metadata.controls?.[key]?.values.includes(value))
			return `${choiceLabels[key]} ${value} is not supported by this model and connection. Review model settings.`;
	}
	const budget = controls.reasoningBudget;
	if (budget !== undefined) {
		const capability = metadata.controls?.reasoningBudget;
		if (!capability) return "A reasoning token budget is not supported by this model and connection.";
		const special = budget === capability.automaticValue || budget === capability.disabledValue;
		if (
			!special &&
			(budget < capability.minimum || (capability.maximum !== undefined && budget > capability.maximum))
		)
			return `Reasoning budget must be ${capability.minimum}–${capability.maximum ?? "unbounded"} tokens, or a supported automatic/off value.`;
	}
	return undefined;
}

export function describeModelControls(controls: ModelControls | undefined): string {
	if (controls === undefined) return "Legacy thinking mapping";
	const parts: string[] = [];
	if (controls.reasoningMode !== undefined) parts.push(`Mode: ${controls.reasoningMode}`);
	if (controls.reasoningEffort !== undefined) parts.push(`Effort: ${controls.reasoningEffort}`);
	if (controls.reasoningBudget !== undefined)
		parts.push(
			`Budget: ${controls.reasoningBudget === -1 ? "automatic" : controls.reasoningBudget === 0 ? "off" : `${controls.reasoningBudget} tokens`}`,
		);
	if (controls.processingTier !== undefined) parts.push(`Processing: ${controls.processingTier}`);
	return parts.join(" · ") || "Provider defaults (no explicit overrides)";
}

/** Partial chat edits preserve controls unless an explicit native/default/legacy replacement is supplied. */
export function mergeModelSettingsDraft(
	current: ModelSettingsSelection,
	draft: Record<string, unknown>,
	models: readonly ModelMetadata[],
): ModelSettingsSelection {
	if (draft.modelControls !== undefined && draft.modelControls !== null && draft.thinking !== undefined)
		throw new Error("Use native model controls or legacy thinking, not both.");
	const next = {
		...current,
		modelControls: current.modelControls === undefined ? undefined : { ...current.modelControls },
	};
	if (draft.model !== undefined) {
		if (typeof draft.model !== "string") throw new Error("Model must be a provider/model reference.");
		const separator = draft.model.indexOf("/");
		if (draft.model && (separator < 1 || separator === draft.model.length - 1))
			throw new Error("Model must be a provider/model reference.");
		next.model = draft.model
			? { provider: draft.model.slice(0, separator), id: draft.model.slice(separator + 1) }
			: undefined;
	}
	if (draft.thinking !== undefined) {
		if (
			typeof draft.thinking !== "string" ||
			!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(draft.thinking)
		)
			throw new Error("Invalid legacy thinking level.");
		next.thinkingLevel = draft.thinking as ThinkingLevel;
		next.modelControls = undefined;
	} else if (draft.modelControls !== undefined)
		next.modelControls = draft.modelControls === null ? undefined : parseModelControls(draft.modelControls);
	const error = modelSettingsError(next, models);
	if (error) throw new Error(error);
	return next;
}
