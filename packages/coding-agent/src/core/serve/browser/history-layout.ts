/** Format the existing activity records and retain their navigation, retry, and review actions. */
export function installHistoryLayout(): void {
	const list = document.getElementById("agent-activity-list");
	if (!list) return;
	const search = document.createElement("input");
	search.type = "search";
	search.className = "settings-search";
	search.placeholder = "Filter displayed history";
	search.setAttribute("aria-label", "Filter displayed history");
	list.before(search);
	const empty = document.createElement("p");
	empty.className = "muted";
	empty.textContent = "No displayed records match this search.";
	empty.hidden = true;
	list.after(empty);
	const filter = () => {
		let count = 0;
		for (const group of list.querySelectorAll<HTMLElement>(".history-day")) {
			let visible = 0;
			for (const row of group.querySelectorAll<HTMLElement>(":scope > .history-record")) {
				row.hidden = !row.textContent?.toLowerCase().includes(search.value.trim().toLowerCase());
				if (!row.hidden) visible++;
			}
			group.hidden = visible === 0;
			count += visible;
		}
		empty.hidden = count > 0 || !search.value;
	};
	search.addEventListener("input", filter);
	const update = () => {
		const rows = [...list.children].filter((row) => row.matches(".agent-activity-entry,.attention-entry-wrap"));
		if (!rows.length) return;
		const groups = new Map<string, HTMLElement>();
		for (const row of rows) {
			const button = row.matches("button")
				? (row as HTMLButtonElement)
				: row.querySelector<HTMLButtonElement>(".agent-activity-entry");
			if (!button) continue;
			const text = button.querySelector("small");
			if (text?.textContent?.trim().startsWith("{")) {
				try {
					const data: unknown = JSON.parse(button.title || text.textContent);
					if (typeof data === "object" && data !== null && "message" in data && typeof data.message === "string")
						text.textContent = data.message;
				} catch {
					// Older activity summaries were truncated before the structured reply was decoded.
					const message = (button.title || text.textContent).match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)/);
					if (message) {
						try {
							text.textContent = `${JSON.parse(`"${message[1]}"`)}…`;
						} catch {
							/* Preserve the original text if its string escapes are also incomplete. */
						}
					}
				}
			}
			const time = button.querySelector("time");
			const date = time?.dateTime ? new Date(time.dateTime) : undefined;
			const pending = /running|waiting|queued|approval|question/.test(button.dataset.status ?? "");
			const day = pending
				? "Needs attention"
				: date && !Number.isNaN(date.getTime())
					? date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
					: "Recent activity";
			let group = groups.get(day);
			if (!group) {
				group = document.createElement("section");
				group.className = "history-day";
				const heading = document.createElement("h3");
				heading.textContent = day;
				group.append(heading);
				groups.set(day, group);
			}
			row.classList.add("history-record");
			group.append(row);
			if (date && time) time.title = date.toLocaleString();
		}
		list.replaceChildren(...groups.values());
		filter();
	};
	new MutationObserver(update).observe(list, { childList: true });
	update();
	document.getElementById("external-connection-list")?.closest("details")?.remove();
	document.querySelector('[aria-label="Delegate to an external agent"]')?.remove();
	const style = document.createElement("style");
	style.textContent = `.history-day h3{margin:20px 4px 8px;font-size:12px;color:var(--muted);font-weight:600}.history-record[hidden],.history-day[hidden]{display:none!important}.history-day .agent-activity-entry{padding:14px 10px;border:1px solid var(--line);border-radius:12px;background:var(--panel);grid-template-columns:8px minmax(0,1fr);align-items:start}.history-day .agent-activity-entry strong{font-size:13px;white-space:normal;line-height:1.5}.history-day .agent-activity-entry small{font-size:12px;line-height:1.5;white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.history-day .agent-activity-entry time{grid-column:2;font-size:11px}.history-day .agent-activity-status{margin-top:7px}.history-day .attention-entry-wrap{grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:10px}.history-day .attention-inline-action{width:36px;height:36px}.history-day .attention-entry-wrap>.agent-activity-entry{grid-row:span 3;margin:0}`;
	document.head.append(style);
}
