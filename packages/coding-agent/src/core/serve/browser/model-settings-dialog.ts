import type { ModelMetadata, ThinkingLevel } from "@earendil-works/pi-protocol";
import { describeCatalogRefresh, describeModelCatalog } from "./model-catalog-status.ts";
import { choiceLabels, type ModelSettingsSelection, modelSettingsError } from "./model-settings.ts";

/** A single Apply keeps coupled settings atomic. Catalog values are data, never provider-name heuristics. */
export function openModelSettings(options: {
	title: string;
	models: readonly ModelMetadata[];
	current: ModelSettingsSelection;
	allowInherit?: boolean;
	onApply(selection: ModelSettingsSelection): Promise<void>;
}): HTMLDialogElement {
	const dialog = document.createElement("dialog");
	dialog.className = "promotion-dialog";
	dialog.setAttribute("aria-label", options.title);
	dialog.style.cssText =
		"box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:hidden";
	const form = document.createElement("form");
	form.style.cssText = "display:flex;flex-direction:column;gap:12px;min-width:0;max-height:calc(100dvh - 72px)";
	const heading = document.createElement("h2");
	heading.textContent = options.title;
	heading.style.cssText = "margin:0;flex-shrink:0";
	const help = document.createElement("p");
	help.className = "muted";
	help.style.cssText = "margin:0;flex-shrink:0";
	help.textContent =
		"Effort controls reasoning work. A token budget guides reasoning token use. Processing speed is separate and may cost more. Catalog support does not verify account access.";
	const fields = document.createElement("div");
	fields.style.cssText = "display:grid;gap:12px;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain";
	const error = document.createElement("p");
	error.className = "run-error";
	error.setAttribute("role", "alert");
	error.style.cssText = "margin:0;flex-shrink:0";
	const actions = document.createElement("div");
	actions.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;flex-shrink:0";
	const cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "Cancel";
	cancel.style.minHeight = "44px";
	const apply = document.createElement("button");
	apply.type = "submit";
	apply.textContent = "Apply settings";
	apply.style.minHeight = "44px";
	actions.append(cancel, apply);
	const controls = { ...options.current.modelControls };
	let legacyThinking = options.current.thinkingLevel;
	let saving = false;
	const addSelect = (
		parent: HTMLElement,
		label: string,
		values: readonly { value: string; label: string }[],
		selected: string,
	) => {
		const wrapper = document.createElement("label");
		wrapper.style.cssText = "display:grid;gap:6px;min-width:0;flex-shrink:0";
		wrapper.append(document.createTextNode(label));
		const select = document.createElement("select");
		select.setAttribute("aria-label", label);
		select.style.cssText = "box-sizing:border-box;width:100%;min-width:0;min-height:44px;font:inherit";
		for (const value of values) select.add(new Option(value.label, value.value));
		if (![...select.options].some((option) => option.value === selected))
			select.add(new Option(`${selected} (unavailable — review)`, selected));
		select.value = selected;
		wrapper.append(select);
		parent.append(wrapper);
		return select;
	};
	form.append(heading, help);
	const model = addSelect(
		form,
		"Model",
		[
			...(options.allowInherit ? [{ value: "", label: "Inherit current session" }] : []),
			...options.models.map((entry) => ({
				value: `${entry.provider}/${entry.id}`,
				label: `${entry.name} · ${entry.provider}`,
			})),
		],
		options.current.model ? `${options.current.model.provider}/${options.current.model.id}` : "",
	);
	const style = addSelect(
		form,
		"Control style",
		[
			{ value: "native", label: "Provider-native controls" },
			{ value: "legacy", label: "Legacy Pi thinking mapping" },
		],
		options.current.modelControls === undefined ? "legacy" : "native",
	);
	form.append(fields, error, actions);
	dialog.append(form);
	const selection = (): ModelSettingsSelection => {
		const separator = model.value.indexOf("/");
		return {
			model:
				separator > 0
					? { provider: model.value.slice(0, separator), id: model.value.slice(separator + 1) }
					: undefined,
			thinkingLevel: legacyThinking,
			modelControls: style.value === "native" ? { ...controls } : undefined,
		};
	};
	const validate = () => {
		const message =
			!options.allowInherit && !selection().model
				? "Choose a model."
				: modelSettingsError(selection(), options.models);
		error.textContent = message ?? "";
		apply.disabled = saving || Boolean(message);
	};
	const renderFields = () => {
		fields.replaceChildren();
		const metadata = options.models.find((entry) => `${entry.provider}/${entry.id}` === model.value);
		const catalog = document.createElement("details");
		const catalogSummary = document.createElement("summary");
		const refresh = metadata?.catalogRefresh;
		catalogSummary.textContent = refresh
			? `${refresh.failed || refresh.warning || metadata?.catalog?.timestampWarning ? "Catalog warning" : metadata?.catalog?.freshness === "refresh-due" ? "Catalog refresh due" : "Catalog refresh"} — ${refresh.mode === "cache-only" ? "cache-only pass" : "network allowed"}`
			: metadata?.catalog
				? "Catalog source and freshness"
				: "Catalog refresh status unavailable";
		const catalogDetails = document.createElement("p");
		catalogDetails.className = "muted";
		catalogDetails.textContent = describeCatalogRefresh(refresh);
		catalog.append(catalogSummary, catalogDetails);
		const sourceDetails = document.createElement("p");
		sourceDetails.className = "muted";
		sourceDetails.textContent = describeModelCatalog(metadata?.catalog);
		catalog.append(sourceDetails);
		fields.append(catalog);
		if (style.value === "legacy") {
			const levels = metadata?.supportedThinkingLevels ?? [
				"off",
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			];
			const thinking = addSelect(
				fields,
				"Legacy thinking",
				levels.map((value) => ({ value, label: value })),
				legacyThinking,
			);
			thinking.addEventListener("change", () => {
				legacyThinking = thinking.value as ThinkingLevel;
				validate();
			});
		} else {
			const note = document.createElement("p");
			note.className = "muted";
			note.textContent =
				"Provider default leaves the field unset; it is not a fixed promise of speed, effort, or cost. Unsupported saved values stay visible until you correct them. The runtime validates combinations on Apply or save.";
			fields.append(note);
			for (const key of ["reasoningMode", "reasoningEffort", "processingTier"] as const) {
				const capability = metadata?.controls?.[key];
				if (!capability && controls[key] === undefined) continue;
				const select = addSelect(
					fields,
					choiceLabels[key],
					[
						{
							value: "",
							label:
								capability?.default === undefined
									? "Provider default (unset)"
									: `Provider default (documented: ${capability.default})`,
						},
						...(capability?.values ?? []).map((value) => ({ value, label: value })),
					],
					controls[key] ?? "",
				);
				if (capability?.guidance) {
					const guidance = document.createElement("p");
					guidance.id = `model-control-${key}-guidance`;
					guidance.className = "muted";
					guidance.style.cssText = "margin:0;overflow-wrap:anywhere";
					guidance.textContent = capability.guidance;
					select.setAttribute("aria-describedby", guidance.id);
					fields.append(guidance);
				}
				select.addEventListener("change", () => {
					if (select.value) controls[key] = select.value;
					else delete controls[key];
					validate();
				});
			}
			const budget = metadata?.controls?.reasoningBudget;
			if (budget || controls.reasoningBudget !== undefined) {
				const mode = addSelect(
					fields,
					"Reasoning token budget",
					[
						{ value: "default", label: "Provider default (unset)" },
						...(budget?.automaticValue !== undefined ? [{ value: "automatic", label: "Automatic" }] : []),
						...(budget?.disabledValue !== undefined ? [{ value: "off", label: "Off" }] : []),
						{ value: "custom", label: "Custom token limit" },
					],
					controls.reasoningBudget === undefined
						? "default"
						: controls.reasoningBudget === budget?.automaticValue
							? "automatic"
							: controls.reasoningBudget === budget?.disabledValue
								? "off"
								: "custom",
				);
				const label = document.createElement("label");
				label.style.cssText = "display:grid;gap:6px";
				label.textContent = `Token limit (${budget?.minimum ?? "?"}–${budget?.maximum ?? "unspecified"})`;
				const number = document.createElement("input");
				number.type = "number";
				number.step = "1";
				number.setAttribute("aria-label", "Reasoning token limit");
				number.style.cssText = "box-sizing:border-box;width:100%;min-height:44px;font:inherit";
				number.value = controls.reasoningBudget?.toString() ?? "";
				label.append(number);
				fields.append(label);
				const sync = () => {
					label.hidden = mode.value !== "custom";
					label.style.display = label.hidden ? "none" : "grid";
					number.disabled = label.hidden;
					if (mode.value === "default") delete controls.reasoningBudget;
					else
						controls.reasoningBudget =
							mode.value === "automatic"
								? -1
								: mode.value === "off"
									? 0
									: number.value === ""
										? Number.NaN
										: Number(number.value);
					validate();
				};
				mode.addEventListener("change", sync);
				number.addEventListener("input", sync);
				label.hidden = mode.value !== "custom";
				label.style.display = label.hidden ? "none" : "grid";
				number.disabled = label.hidden;
			}
			const evidence = document.createElement("details");
			const summary = document.createElement("summary");
			summary.textContent = "Capability evidence";
			evidence.append(summary);
			for (const key of ["reasoningMode", "reasoningEffort", "reasoningBudget", "processingTier"] as const) {
				const source = metadata?.controls?.[key]?.evidence;
				if (!source) continue;
				const paragraph = document.createElement("p");
				paragraph.style.overflowWrap = "anywhere";
				paragraph.textContent = `${key === "reasoningBudget" ? "Token budget" : choiceLabels[key]}: ${source.kind} · checked ${source.checkedAt} · ${source.reference}`;
				evidence.append(paragraph);
			}
			if (evidence.childElementCount === 1)
				evidence.append(
					document.createTextNode(
						"No native control evidence for this model and connection. Only unset defaults are available.",
					),
				);
			fields.append(evidence);
		}
		validate();
	};
	model.addEventListener("change", renderFields);
	style.addEventListener("change", renderFields);
	cancel.addEventListener("click", () => dialog.close());
	dialog.addEventListener("cancel", (event) => {
		if (saving) event.preventDefault();
	});
	dialog.addEventListener("close", () => dialog.remove());
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		validate();
		if (apply.disabled) return;
		const next = selection();
		saving = true;
		for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
			"input,select,button",
		))
			field.disabled = true;
		apply.textContent = "Applying…";
		void options.onApply(next).then(
			() => dialog.close(),
			(failure: unknown) => {
				saving = false;
				for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
					"input,select,button",
				))
					field.disabled = false;
				apply.textContent = "Apply settings";
				renderFields();
				error.textContent = failure instanceof Error ? failure.message : String(failure);
			},
		);
	});
	document.body.append(dialog);
	renderFields();
	dialog.showModal();
	return dialog;
}
