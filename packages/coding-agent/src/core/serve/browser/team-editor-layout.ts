/** Organize the existing team form without recreating its inputs or changing its save contract. */
export function organizeTeamEditor(form: HTMLFormElement): void {
	if (form.dataset.teamLayout || !form.querySelector(".room-member-row")) return;
	form.dataset.teamLayout = "true";
	form.parentElement?.classList.add("team-editor");
	const original = [...form.children];
	const nav = document.createElement("nav");
	nav.className = "editor-sections";
	nav.setAttribute("aria-label", "Team settings sections");
	const body = document.createElement("div");
	body.className = "editor-body";
	const sections = new Map<string, HTMLElement>();
	const buttons = new Map<string, HTMLButtonElement>();
	const show = (name: string) => {
		for (const [key, section] of sections) section.hidden = key !== name;
		for (const [key, button] of buttons) button.setAttribute("aria-current", key === name ? "page" : "false");
		body.scrollTop = 0;
	};
	for (const name of ["Overview", "Members", "Tools", "Memory", "Advanced"]) {
		const section = document.createElement("section");
		section.className = "editor-section";
		section.setAttribute("aria-label", name);
		const title = document.createElement("h2");
		title.textContent = name;
		section.append(title);
		sections.set(name, section);
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = name;
		button.addEventListener("click", () => show(name));
		buttons.set(name, button);
		nav.append(button);
		body.append(section);
	}
	const members = sections.get("Members")!;
	const roster = document.createElement("div");
	roster.className = "editor-roster";
	const available = document.createElement("details");
	available.className = "editor-add-members";
	const add = document.createElement("summary");
	add.textContent = "Add member";
	const search = document.createElement("input");
	search.type = "search";
	search.placeholder = "Search available agents";
	search.setAttribute("aria-label", "Search available agents");
	const choices = document.createElement("div");
	available.append(add, search, choices);
	members.append(available, roster);
	const memberCards: Array<{
		card: HTMLElement;
		checkbox: HTMLInputElement;
		profile: HTMLDetailsElement;
		name: string;
	}> = [];
	const consumed = new Set<Element>();
	for (const row of form.querySelectorAll<HTMLLabelElement>(":scope > .room-member-row")) {
		const profile = row.nextElementSibling;
		const checkbox = row.querySelector<HTMLInputElement>("input[type=checkbox]");
		if (!(profile instanceof HTMLDetailsElement) || !checkbox) continue;
		const card = document.createElement("article");
		card.className = "editor-member";
		const name = row.textContent?.trim() ?? "Agent";
		profile.querySelector("summary")!.textContent = "Role and instructions";
		card.append(row, profile);
		memberCards.push({ card, checkbox, profile, name });
		consumed.add(row);
		consumed.add(profile);
	}
	const updateMembers = () => {
		let count = 0;
		for (const { card, checkbox, profile, name } of memberCards) {
			if (checkbox.checked) {
				count++;
				if (card.parentElement !== roster) roster.append(card);
				card.hidden = false;
				profile.hidden = false;
			} else {
				if (card.parentElement !== choices) choices.append(card);
				card.hidden = !name.toLowerCase().includes(search.value.trim().toLowerCase());
				profile.hidden = true;
			}
		}
		buttons.get("Members")!.textContent = `Members · ${count}`;
	};
	search.addEventListener("input", updateMembers);
	form.addEventListener("change", updateMembers);
	const footer = document.createElement("footer");
	footer.className = "editor-footer";
	for (const child of original) {
		if (consumed.has(child)) continue;
		if (child.classList.contains("promotion-actions") || child.getAttribute("role") === "alert") {
			footer.append(child);
			continue;
		}
		if (child.tagName === "STRONG" && child.textContent === "Members") continue;
		if (child instanceof HTMLDetailsElement) {
			const summary = child.querySelector("summary");
			const label = summary?.textContent ?? "";
			const section = label.startsWith("Memory") ? "Memory" : label.startsWith("Tools") ? "Tools" : "Advanced";
			sections.get(section)!.append(child);
			if (section !== "Advanced") {
				child.open = true;
				if (summary) summary.hidden = true;
			}
			if (section === "Tools") {
				const filter = document.createElement("input");
				filter.type = "search";
				filter.placeholder = "Search team tools";
				filter.setAttribute("aria-label", "Search team tools");
				const labels = [...child.querySelectorAll<HTMLLabelElement>(":scope > label")].slice(1);
				filter.addEventListener("input", () => {
					for (const label of labels)
						label.hidden = !label.textContent?.toLowerCase().includes(filter.value.toLowerCase());
				});
				child.prepend(filter);
			}
		} else sections.get("Overview")!.append(child);
	}
	const layout = document.createElement("div");
	layout.className = "editor-layout";
	layout.append(nav, body);
	form.replaceChildren(layout, footer);
	form.addEventListener(
		"invalid",
		(event) => {
			if (!(event.target instanceof HTMLElement)) return;
			const section = event.target.closest(".editor-section");
			for (const [name, candidate] of sections) if (candidate === section) show(name);
		},
		true,
	);
	updateMembers();
	show("Overview");
}
