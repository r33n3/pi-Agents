export interface ThemedSelectController {
	refresh(): void;
}

let closeOpenPicker: (() => void) | undefined;

/** Keeps a native select as the value owner while providing a consistently themed popup. */
export function installThemedSelect(select: HTMLSelectElement): ThemedSelectController {
	const shell = document.createElement("span");
	shell.className = "themed-select";
	const trigger = document.createElement("button");
	trigger.type = "button";
	trigger.className = "themed-select-trigger";
	trigger.setAttribute("role", "combobox");
	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");
	const label = select.getAttribute("aria-label") ?? select.closest("label")?.childNodes[0]?.textContent?.trim();
	trigger.setAttribute("aria-label", label || "Model");
	const list = document.createElement("div");
	list.id = `themed-select-${crypto.randomUUID()}`;
	list.className = "themed-select-list hidden";
	list.setAttribute("role", "listbox");
	trigger.setAttribute("aria-controls", list.id);
	shell.append(trigger);
	select.hidden = true;
	select.after(shell);
	document.body.append(list);

	const close = () => {
		list.classList.add("hidden");
		trigger.setAttribute("aria-expanded", "false");
		if (closeOpenPicker === close) closeOpenPicker = undefined;
	};
	const optionButtons = () => [...list.querySelectorAll<HTMLButtonElement>(".themed-select-option")];
	const choose = (index: number) => {
		if (select.options[index]?.disabled) return;
		select.selectedIndex = index;
		select.dispatchEvent(new Event("change", { bubbles: true }));
		refresh();
		close();
		trigger.focus();
	};
	const refresh = () => {
		const options = [...select.options];
		const selected = options[select.selectedIndex];
		trigger.textContent = selected?.textContent ?? "Select model";
		trigger.title = selected?.textContent ?? "Select model";
		trigger.disabled = select.disabled;
		list.replaceChildren(
			...options.map((option, index) => {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "themed-select-option";
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", String(index === select.selectedIndex));
				button.disabled = option.disabled;
				button.textContent = option.textContent;
				button.title = option.textContent;
				button.addEventListener("click", () => choose(index));
				return button;
			}),
		);
	};
	const open = () => {
		if (select.disabled) return;
		closeOpenPicker?.();
		closeOpenPicker = close;
		refresh();
		list.classList.remove("hidden");
		trigger.setAttribute("aria-expanded", "true");
		const rect = trigger.getBoundingClientRect();
		const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
		const availableAbove = rect.top - 8;
		const availableBelow = window.innerHeight - rect.bottom - 8;
		const openAbove = availableAbove > availableBelow;
		const height = Math.min(320, Math.max(120, openAbove ? availableAbove : availableBelow));
		list.style.width = `${width}px`;
		list.style.maxHeight = `${height}px`;
		list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
		list.style.top = openAbove ? `${Math.max(8, rect.top - height - 6)}px` : `${rect.bottom + 6}px`;
		const selectedButton = optionButtons()[select.selectedIndex];
		selectedButton?.scrollIntoView({ block: "nearest" });
		selectedButton?.focus();
	};
	const moveFocus = (direction: 1 | -1) => {
		const buttons = optionButtons();
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
		for (let offset = 1; offset <= buttons.length; offset++) {
			const candidate = buttons[(current + direction * offset + buttons.length) % buttons.length];
			if (!candidate.disabled) {
				candidate.focus();
				return;
			}
		}
	};

	trigger.addEventListener("click", () => (list.classList.contains("hidden") ? open() : close()));
	trigger.addEventListener("keydown", (event) => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		open();
	});
	list.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			moveFocus(event.key === "ArrowDown" ? 1 : -1);
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
	window.addEventListener("resize", close);
	select.addEventListener("change", refresh);
	new MutationObserver(refresh).observe(select, { childList: true, subtree: true });
	refresh();
	return { refresh };
}
