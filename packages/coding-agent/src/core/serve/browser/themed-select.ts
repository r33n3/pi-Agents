import { createBrowserId } from "./browser-id.ts";

export interface ThemedSelectController {
	refresh(): void;
}

let closeOpenPicker: (() => void) | undefined;

/** Keeps a native select as the value owner while providing a consistently themed popup. */
export function installThemedSelect(
	select: HTMLSelectElement,
	kind: "models" | "simple" = "models",
): ThemedSelectController {
	const shell = document.createElement("span");
	shell.className = "themed-select";
	shell.dataset.selectId = select.id;
	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "themed-select-trigger";
	trigger.setAttribute("role", "combobox");
	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");
	const label = select.getAttribute("aria-label") ?? select.closest("label")?.childNodes[0]?.textContent?.trim();
	trigger.setAttribute("aria-label", label || "Model");
	const list = document.createElement("div");
	list.id = `themed-select-${createBrowserId()}`;
	list.className = "themed-select-list hidden";
	list.setAttribute("role", "listbox");
	list.style.overflow = "hidden";
	list.style.flexDirection = "column";
	const search = document.createElement("input");
	search.type = "search";
	search.placeholder = kind === "models" ? "Filter models…" : "Filter options…";
	search.setAttribute("aria-label", `Filter ${label || "models"}`);
	search.style.boxSizing = "border-box";
	search.style.width = "100%";
	search.style.marginBottom = "6px";
	search.style.padding = "9px 10px";
	search.style.border = "1px solid #3a3a42";
	search.style.borderRadius = "7px";
	search.style.background = "#17171b";
	search.style.color = "inherit";
	search.style.font = "inherit";
	const searchRow = document.createElement("div");
	searchRow.className = "themed-select-search-row";
	const dismiss = document.createElement("button");
	dismiss.type = "button";
	dismiss.className = "themed-select-dismiss";
	dismiss.textContent = "×";
	dismiss.title = "Close model picker";
	dismiss.setAttribute("aria-label", "Close model picker");
	searchRow.append(search, dismiss);
	const costKindLabels: Readonly<Record<string, string>> = {
		lowest: "Lowest cost",
		low: "Low cost",
		moderate: "Moderate cost",
		high: "High cost",
		highest: "Highest cost",
		local: "Local model",
		unknown: "Pricing unavailable",
	};
	const costKindOrder = ["lowest", "low", "moderate", "high", "highest", "local", "unknown"];
	let activeCostKind: string | undefined;
	const filterBar = document.createElement("div");
	filterBar.className = "themed-select-cost-filters";
	filterBar.setAttribute("role", "group");
	filterBar.setAttribute("aria-label", "Filter by model cost");
	filterBar.style.display = "flex";
	filterBar.style.alignItems = "center";
	filterBar.style.gap = "7px";
	filterBar.style.marginBottom = "6px";
	filterBar.style.padding = "1px 2px 3px";
	const optionsHost = document.createElement("div");
	optionsHost.className = "themed-select-options";
	optionsHost.style.minHeight = "0";
	optionsHost.style.flex = "1 1 auto";
	optionsHost.style.overflowY = "auto";
	optionsHost.style.overscrollBehavior = "contain";
	optionsHost.style.touchAction = "pan-y";
	optionsHost.style.scrollbarGutter = "stable";
	const noResults = document.createElement("div");
	noResults.className = "themed-select-empty hidden";
	noResults.textContent = "No matching models";
	noResults.style.padding = "12px 10px";
	noResults.style.color = "#9999a3";
	trigger.setAttribute("aria-controls", list.id);
	shell.append(trigger);
	select.hidden = true;
	select.after(shell);
	if (kind === "models") list.append(searchRow, filterBar);
	list.append(optionsHost);
	document.body.append(list);

	const close = () => {
		if (document.activeElement === search) search.blur();
		list.classList.add("hidden");
		list.classList.remove("mobile-sheet");
		trigger.setAttribute("aria-expanded", "false");
		if (closeOpenPicker === close) closeOpenPicker = undefined;
	};
	const isMobilePicker = () =>
		(window.visualViewport?.width ?? window.innerWidth) <= 700 ||
		window.matchMedia("(hover: none) and (pointer: coarse)").matches;
	const positionList = () => {
		if (list.classList.contains("hidden")) return;
		const viewport = window.visualViewport;
		const viewportWidth = viewport?.width ?? window.innerWidth;
		const viewportHeight = viewport?.height ?? window.innerHeight;
		const viewportLeft = viewport?.offsetLeft ?? 0;
		const viewportTop = viewport?.offsetTop ?? 0;
		list.classList.remove("mobile-sheet");
		list.classList.toggle("mobile-anchored", isMobilePicker());
		const rect = trigger.getBoundingClientRect();
		const minimumWidth = kind === "models" ? (isMobilePicker() ? 320 : 260) : 180;
		const width = Math.min(Math.max(rect.width, minimumWidth), viewportWidth - 16);
		const availableAbove = rect.top - viewportTop - 8;
		const availableBelow = viewportTop + viewportHeight - rect.bottom - 8;
		const openAbove = availableAbove > availableBelow;
		const preferredHeight = kind === "models" ? 320 : optionButtons().length * 40 + 12;
		const height = Math.min(preferredHeight, Math.max(120, openAbove ? availableAbove : availableBelow));
		list.style.width = `${width}px`;
		list.style.height = `${height}px`;
		list.style.left = `${Math.max(viewportLeft + 8, Math.min(rect.left, viewportLeft + viewportWidth - width - 8))}px`;
		list.style.top = openAbove ? `${Math.max(viewportTop + 8, rect.top - height - 6)}px` : `${rect.bottom + 6}px`;
	};
	const optionButtons = () => [...optionsHost.querySelectorAll<HTMLButtonElement>(".themed-select-option")];
	const visibleOptionButtons = () => optionButtons().filter((button) => !button.hidden && !button.disabled);
	const choose = (index: number) => {
		if (select.options[index]?.disabled) return;
		select.selectedIndex = index;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		refresh();
		close();
		trigger.focus();
	};
	const applyOptionPresentation = (target: HTMLButtonElement, option: HTMLOptionElement) => {
		const accent = option.dataset.optionAccent;
		target.style.borderLeft = `3px solid ${accent ?? "transparent"}`;
		if (accent) target.dataset.optionAccent = accent;
		else delete target.dataset.optionAccent;
		if (option.dataset.optionKind) target.dataset.optionKind = option.dataset.optionKind;
		else delete target.dataset.optionKind;
		const text = option.textContent ?? "Select model";
		const description = option.title;
		target.title = description || text;
		target.setAttribute("aria-label", description ? `${text}. ${description}` : text);
	};
	const refresh = () => {
		const options = [...select.options];
		const selected = options[select.selectedIndex];
		trigger.textContent = selected?.textContent ?? "Select model";
		if (selected) applyOptionPresentation(trigger, selected);
		else {
			trigger.style.borderLeft = "";
			trigger.title = "Select model";
		}
		trigger.disabled = select.disabled;
		optionsHost.replaceChildren(
			...options.map((option, index) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "themed-select-option";
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", String(index === select.selectedIndex));
				button.disabled = option.disabled;
				button.textContent = option.textContent;
				applyOptionPresentation(button, option);
				button.addEventListener("click", () => choose(index));
				return button;
			}),
			noResults,
		);
		refreshCostFilters();
		applyFilter();
	};
	const refreshCostFilters = () => {
		const availableKinds = new Map<string, string>();
		for (const button of optionButtons()) {
			if (button.dataset.optionKind && button.dataset.optionAccent) {
				availableKinds.set(button.dataset.optionKind, button.dataset.optionAccent);
			}
		}
		if (activeCostKind && !availableKinds.has(activeCostKind)) activeCostKind = undefined;
		const createFilter = (kind: string | undefined, color?: string) => {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("aria-pressed", String(activeCostKind === kind));
			button.title = kind ? (costKindLabels[kind] ?? kind) : "All cost bands";
			button.setAttribute("aria-label", button.title);
			button.style.boxSizing = "border-box";
			button.style.height = "20px";
			button.style.minWidth = kind ? "20px" : "32px";
			button.style.padding = kind ? "0" : "0 6px";
			button.style.border = "1px solid #52525b";
			button.style.borderRadius = "999px";
			button.style.background = color ?? "transparent";
			button.style.color = "#d4d4d8";
			button.style.font = "inherit";
			button.style.fontSize = "10px";
			button.style.boxShadow = activeCostKind === kind ? "0 0 0 2px #dbeafe" : "none";
			if (!kind) button.textContent = "All";
			button.addEventListener("click", () => {
				activeCostKind = kind;
				refreshCostFilters();
				applyFilter();
				optionsHost.scrollTop = 0;
				if (!isMobilePicker()) search.focus();
			});
			return button;
		};
		filterBar.replaceChildren(
			createFilter(undefined),
			...costKindOrder.flatMap((kind) => {
				const color = availableKinds.get(kind);
				return color ? [createFilter(kind, color)] : [];
			}),
		);
	};
	const applyFilter = () => {
		const query = search.value.trim().toLocaleLowerCase();
		let matchCount = 0;
		for (const button of optionButtons()) {
			const matchesText = !query || button.textContent?.toLocaleLowerCase().includes(query);
			const matchesKind = !activeCostKind || button.dataset.optionKind === activeCostKind;
			const matches = matchesText && matchesKind;
			button.hidden = !matches;
			button.style.display = matches ? "block" : "none";
			if (matches) matchCount += 1;
		}
		noResults.classList.toggle("hidden", matchCount > 0);
	};
	const open = () => {
		if (select.disabled) return;
		closeOpenPicker?.();
		closeOpenPicker = close;
		search.value = "";
		activeCostKind = undefined;
		refresh();
		list.classList.remove("hidden");
		list.style.display = "flex";
		trigger.setAttribute("aria-expanded", "true");
		positionList();
		const selectedButton = optionButtons()[select.selectedIndex];
		selectedButton?.scrollIntoView({ block: "nearest" });
		if (kind === "models" && !isMobilePicker()) search.focus();
	};
	const moveFocus = (direction: 1 | -1) => {
		const buttons = visibleOptionButtons();
		if (buttons.length === 0) return;
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		for (let offset = 1; offset <= buttons.length; offset++) {
			const candidate = buttons[(current + direction * offset + buttons.length) % buttons.length];
			if (!candidate.disabled) {
				candidate.focus();
				return;
			}
		}
	};
	const focusBoundary = (end: boolean) => {
		const buttons = visibleOptionButtons();
		buttons[end ? buttons.length - 1 : 0]?.focus();
	};

	trigger.addEventListener("click", () => (list.classList.contains("hidden") ? open() : close()));
	dismiss.addEventListener("click", close);
	trigger.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		open();
	});
	search.addEventListener("input", () => {
		applyFilter();
		optionsHost.scrollTop = 0;
	});
	list.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveFocus(event.key === "ArrowDown" ? 1 : -1);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			focusBoundary(event.key === "End");
		} else if (event.key === "Enter" && document.activeElement === search) {
			event.preventDefault();
			visibleOptionButtons()[0]?.click();
		} else if (event.key === "Escape") {
			event.preventDefault();
			close();
			trigger.focus();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		const target = event.target;
		if (target instanceof Node && !shell.contains(target) && !list.contains(target)) close();
	});
	window.addEventListener("resize", positionList);
	window.visualViewport?.addEventListener("resize", positionList);
	window.visualViewport?.addEventListener("scroll", positionList);
	select.addEventListener("change", refresh);
	new MutationObserver(refresh).observe(select, { childList: true, subtree: true });
	refresh();
	return { refresh };
}
