/** Style the shared send/stop action and conversation spacing. */
export function installConversationControls(): void {
	const style = document.createElement("style");
	style.textContent = `
#composer-action.is-stopping{border:1px solid var(--danger);border-radius:12px;background:var(--surface2);color:var(--danger)}#composer-action.is-stopping .stop-icon{background:var(--danger)}
#composer-action.is-stopping:focus-visible{outline:2px solid var(--danger);outline-offset:3px}
#transcript>.message.user{margin-top:28px;margin-bottom:28px;line-height:1.65}
#transcript>.message.assistant{margin-bottom:28px}#transcript>.team-communication{margin:12px 0;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
#transcript>.team-communication>summary{line-height:1.6;cursor:pointer}#transcript>.team-communication[open]>.message{margin:16px 0 4px}
#transcript .message p+p{margin-top:1em}#transcript>.message.user+ .message.user{margin-top:12px}
`;
	document.head.append(style);
}
