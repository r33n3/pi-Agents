/** Present existing team controls outside the transcript without replacing their action handlers. */
export function installConversationLayout(): void {
	const transcript = document.getElementById("transcript");
	const input = document.querySelector<HTMLTextAreaElement>("#prompt");
	if (!transcript || !input) return;
	const toolbar = document.createElement("nav");
	toolbar.id = "conversation-toolbar";
	toolbar.setAttribute("aria-label", "Conversation actions");
	toolbar.hidden = true;
	const title = document.createElement("strong");
	const panel = document.createElement("section");
	panel.id = "conversation-options";
	panel.hidden = true;
	transcript.before(toolbar, panel);
	let schedule: HTMLDetailsElement | undefined;
	let memory: HTMLDetailsElement | undefined;
	let teamName = "";
	let view: "chat" | "schedule" | "memory" | "configure" = "chat";
	let scrollTop = 0;
	let draft = "";
	let configuring = false;
	const action = (label: string, run: () => void) => {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.addEventListener("click", run);
		return button;
	};
	const configureTarget = () =>
		document.querySelector<HTMLButtonElement>(`.rail button[aria-label="${CSS.escape(`Configure ${teamName}`)}"]`);
	const capture = () => {
		if (view !== "chat") return;
		scrollTop = transcript.scrollTop;
		draft = input.value;
	};
	const showChat = (restore = true) => {
		panel.hidden = true;
		transcript.classList.remove("conversation-covered");
		if (schedule) schedule.open = false;
		if (memory) memory.open = false;
		view = "chat";
		back.hidden = true;
		for (const button of [configure, scheduling, remembering]) button.setAttribute("aria-pressed", "false");
		if (restore)
			requestAnimationFrame(() => {
				transcript.scrollTop = scrollTop;
			});
	};
	const show = (next: "schedule" | "memory", content: HTMLDetailsElement | undefined) => {
		if (!content) return;
		capture();
		if (schedule && schedule !== content) schedule.open = false;
		if (memory && memory !== content) memory.open = false;
		view = next;
		transcript.classList.add("conversation-covered");
		panel.hidden = false;
		panel.setAttribute("aria-label", next === "schedule" ? "Team schedule settings" : "Team memory");
		panel.replaceChildren(content);
		content.open = true;
		back.hidden = false;
		scheduling.setAttribute("aria-pressed", String(next === "schedule"));
		remembering.setAttribute("aria-pressed", String(next === "memory"));
		panel.scrollTop = 0;
		panel.tabIndex = -1;
		panel.focus({ preventScroll: true });
	};
	const configure = action("Configure", () => {
		const target = configureTarget();
		if (!target || target.disabled) return;
		capture();
		showChat(false);
		view = "configure";
		configuring = true;
		target.click();
	});
	const scheduling = action("Schedule", () => show("schedule", schedule));
	const remembering = action("Memory", () => show("memory", memory));
	const back = action("Back to chat", () => {
		if (view === "configure") {
			const cancel = [...transcript.querySelectorAll<HTMLButtonElement>(".promotion-actions button")].find(
				(button) => button.textContent === "Cancel",
			);
			cancel?.click();
		} else showChat();
	});
	back.hidden = true;
	toolbar.append(title, configure, scheduling, remembering, back);
	const update = () => {
		const incoming = transcript.querySelector<HTMLDetailsElement>(":scope > .team-schedule");
		const heading = transcript.querySelector<HTMLElement>(":scope > .subagent-inspector-heading");
		const editor = transcript.querySelector<HTMLElement>(":scope > .promotion-dialog");
		if (configuring && editor) {
			back.hidden = false;
			configure.hidden = scheduling.hidden = remembering.hidden = true;
			return;
		}
		if (incoming && heading) {
			const sameTeam = schedule?.dataset.roomId === incoming.dataset.roomId;
			if (!sameTeam) {
				showChat(false);
				configuring = false;
			}
			schedule = incoming;
			toolbar.dataset.catalogTeamId = incoming.dataset.roomId;
			teamName = heading.querySelector(".message-label")?.textContent ?? "Team";
			title.textContent = teamName;
			incoming.remove();
			const incomingMemory = transcript.querySelector<HTMLDetailsElement>(':scope > [data-team-detail="memory"]');
			if (incomingMemory) {
				if (view !== "memory" || !sameTeam) memory = incomingMemory;
				incomingMemory.remove();
			}
			if (configuring && sameTeam) {
				configuring = false;
				input.value = draft;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				showChat();
			} else if (view === "schedule" && !panel.contains(incoming)) {
				panel.replaceChildren(incoming);
				incoming.open = true;
			}
		}
		const active = Boolean(heading && schedule && heading.querySelector(".message-label")?.textContent === teamName);
		toolbar.hidden = !active;
		configure.hidden = scheduling.hidden = remembering.hidden = false;
		configure.disabled = configureTarget()?.disabled ?? true;
		configure.title = configure.disabled
			? "Stop the active team run before changing its configuration"
			: "Configure team";
		if (!active && view !== "chat") {
			showChat(false);
			configuring = false;
		}
	};
	new MutationObserver(update).observe(transcript, { childList: true });
	const rail = document.querySelector(".rail");
	if (rail) new MutationObserver(update).observe(rail, { childList: true, subtree: true });
	update();
}
