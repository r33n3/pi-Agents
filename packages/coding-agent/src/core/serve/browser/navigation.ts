/** Keep navigation independent of chat focus and the mobile keyboard. */
export function installNavigation(): void {
	for (const label of document.querySelectorAll<HTMLLabelElement>('label[for^="mobile-panel-"]')) {
		const panel = document.getElementById(label.htmlFor);
		if (!(panel instanceof HTMLInputElement)) continue;
		const button = document.createElement("button");
		button.type = "button";
		button.className = label.className;
		button.title = label.title;
		button.setAttribute("aria-label", label.getAttribute("aria-label") ?? label.title);
		button.style.cssText = label.style.cssText;
		if (button.classList.contains("mobile-panel-scrim")) {
			button.style.border = "0";
			button.style.padding = "0";
		}
		button.append(...label.childNodes);
		// Keep the keyboard from moving the viewport between pointerdown and click.
		button.addEventListener("pointerdown", (event) => event.preventDefault());
		button.addEventListener("click", () => {
			panel.checked = true;
			const focused = document.activeElement;
			if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur();
		});
		label.replaceWith(button);
		panel.tabIndex = -1;
		panel.setAttribute("aria-hidden", "true");
	}
	const style = document.createElement("style");
	// Each absolute-positioned menu belongs to its own row, not the entire sidebar.
	style.textContent = `
.session-row{position:relative}.session-row>.session-select{padding-right:28px}
/* Keep both tap targets above the scrolling chat, including the first mobile paint. */
main>.header{position:relative;z-index:10;flex-shrink:0}
.header>.mobile-panel-toggle{position:relative;z-index:1;touch-action:manipulation}
.mobile-panel-toggle svg{pointer-events:none}
`;
	document.head.append(style);
}
