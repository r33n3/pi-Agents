/** Keep cancellation within reach without taking away the user's steering input. */
export function installConversationControls(): void {
	const composer = document.getElementById("composer");
	const transcript = document.getElementById("transcript");
	if (!composer || !transcript) return;
	const stop = document.createElement("button");
	stop.id = "conversation-stop";
	stop.type = "button";
	stop.title = "Stop execution";
	stop.setAttribute("aria-label", "Stop execution");
	stop.hidden = true;
	const square = document.createElement("span");
	square.setAttribute("aria-hidden", "true");
	stop.append(square);
	composer.append(stop);
	const update = () => {
		const target = [...transcript.querySelectorAll<HTMLButtonElement>(".agent-running button")].find(
			(button) => button.textContent?.trim() === "Stop team",
		);
		stop.hidden = !target;
		stop.disabled = target?.disabled ?? false;
	};
	stop.addEventListener("pointerdown", (event) => event.preventDefault());
	stop.addEventListener("click", () => {
		const target = [...transcript.querySelectorAll<HTMLButtonElement>(".agent-running button")].find(
			(button) => button.textContent?.trim() === "Stop team",
		);
		if (!target || target.disabled) return;
		stop.disabled = true;
		target.click();
	});
	const observer = new MutationObserver(update);
	observer.observe(transcript, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
	update();
	const style = document.createElement("style");
	style.textContent = `
#conversation-stop{flex:0 0 42px;width:42px;height:42px;display:grid;place-items:center;border:1px solid color-mix(in srgb,var(--danger) 65%,var(--line));border-radius:12px;background:var(--surface2);color:var(--danger);touch-action:manipulation}
#conversation-stop[hidden]{display:none}#conversation-stop span{width:14px;height:14px;border-radius:2px;background:currentColor;pointer-events:none}
#conversation-stop:hover{background:color-mix(in srgb,var(--danger) 15%,var(--surface2))}#conversation-stop:disabled{opacity:.45;cursor:wait}
#conversation-stop:focus-visible{outline:2px solid var(--danger);outline-offset:3px}
#composer-action.is-stopping{border:1px solid var(--danger);border-radius:12px;background:var(--surface2);color:var(--danger)}#composer-action.is-stopping .stop-icon{background:var(--danger)}
#transcript>.message.user{margin-top:28px;margin-bottom:28px;line-height:1.65}
#transcript>.message.assistant{margin-bottom:28px}#transcript>.team-communication{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
#transcript>.team-communication>summary{line-height:1.6;cursor:pointer}#transcript>.team-communication[open]>.message{margin:16px 0 4px}
#transcript .message p+p{margin-top:1em}#transcript>.message.user+ .message.user{margin-top:12px}
`;
	document.head.append(style);
}
