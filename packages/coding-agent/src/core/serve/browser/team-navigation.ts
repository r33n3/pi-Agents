/** Keeps team membership together while selection opens the main conversation. */
export function renderCollapsibleTeam(id: string, name: string, row: HTMLElement, members: HTMLElement): HTMLElement {
	const group = document.createElement("section");
	group.className = "team-navigation-entry";
	group.setAttribute("aria-label", name);
	group.dataset.agentSearch = row.dataset.agentSearch ?? name.toLowerCase();
	group.classList.toggle("hidden", row.classList.contains("hidden"));
	delete row.dataset.agentSearch;
	row.classList.remove("hidden");
	const storageKey = `pi.team-expanded:${id}`;
	let expanded = false;
	try {
		expanded = localStorage.getItem(storageKey) === "true";
	} catch {
		// Navigation still works when browser storage is unavailable.
	}
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.style.cssText = "flex:0 0 24px;padding:4px";
	members.id = `team-members-${encodeURIComponent(id)}`;
	members.setAttribute("role", "group");
	members.setAttribute("aria-label", `${name} members`);
	members.style.cssText = "margin:0 8px 10px 18px;border-left:1px solid var(--line);padding-left:8px";
	toggle.setAttribute("aria-controls", members.id);
	const update = () => {
		toggle.textContent = expanded ? "−" : "+";
		toggle.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} ${name}`);
		toggle.setAttribute("aria-expanded", String(expanded));
		members.classList.toggle("hidden", !expanded);
	};
	toggle.addEventListener("click", () => {
		expanded = !expanded;
		try {
			localStorage.setItem(storageKey, String(expanded));
		} catch {
			// Expanding the current view does not require persistence.
		}
		update();
	});
	update();
	row.prepend(toggle);
	group.append(row, members);
	return group;
}
