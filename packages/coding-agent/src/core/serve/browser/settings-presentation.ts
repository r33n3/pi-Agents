import { organizeTeamEditor } from "./team-editor-layout.ts";

type SettingControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Add disclosure and editing affordances while retaining the original controls and save handlers. */
export function installSettingsPresentation(): void {
	const opened = new Map<string, boolean>();
	const enhancedForms = new WeakSet<HTMLFormElement>();
	const settings = document.getElementById("settings-workspace");
	const transcript = document.getElementById("transcript");
	const options = document.getElementById("conversation-options");
	const style = document.createElement("style");
	style.textContent = `
#transcript:has(>.team-editor){overflow:hidden;padding:12px}
#transcript>.team-editor{height:100%;max-height:100%!important;border:0}
#transcript>.promotion-dialog.team-editor>form{height:100%;min-height:0;display:grid;grid-template-rows:minmax(0,1fr) auto;gap:0;padding:0;overflow:hidden}
.editor-layout{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:0}.editor-sections{display:flex;flex-direction:column;gap:6px;padding:12px;border-right:1px solid var(--line)}
.editor-sections button{min-height:44px;text-align:left;border:0;border-radius:9px;padding:10px;background:transparent;color:var(--muted)}.editor-sections button[aria-current=page]{background:var(--surface2);color:var(--pi)}
.editor-body{min-height:0;overflow:auto;padding:20px}.editor-section{display:grid;gap:18px;max-width:760px;margin:auto}.editor-section[hidden],.editor-member[hidden],.editor-section label[hidden],.editor-member details[hidden]{display:none!important}.editor-section h2{font-size:18px;margin:0 0 4px}.editor-section p{line-height:1.6;margin:0}
.editor-section label{display:grid!important;gap:8px!important;min-width:0}.editor-section label:has(>input[type=checkbox]){display:flex!important;align-items:center;min-height:44px}.editor-section label>input[type=checkbox]{flex:0 0 18px}
#transcript .editor-section label[hidden]{display:none!important}
.editor-section input:not([type=checkbox]),.editor-section textarea,.editor-section select{width:100%}.editor-roster{display:grid;gap:12px}.editor-member{padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.editor-member>.room-member-row{font-weight:600}.editor-member details>label{margin:12px 0}.editor-add-members>summary{color:var(--pi)}.editor-add-members>div{display:grid;gap:8px;margin-top:12px}
.editor-footer{padding:8px 16px;border-top:1px solid var(--line);background:var(--panel)}#transcript>.team-editor .promotion-actions{position:static;margin:0;box-shadow:none;border:0;padding:0}.editor-footer [role=alert]:empty{display:none}
@media(max-width:1100px){.editor-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.editor-sections{flex-direction:row;flex-wrap:wrap;border-right:0;border-bottom:1px solid var(--line);padding:6px;gap:4px}.editor-sections button{flex:1 1 80px;text-align:center;font-size:12px}.editor-body{padding:16px 10px}}
#conversation-toolbar{flex:0 0 auto;display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
#conversation-toolbar[hidden],#conversation-options[hidden]{display:none}
#conversation-toolbar strong{flex:1 1 160px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
#conversation-toolbar button,.settings-form-actions button,.settings-edit-footer button,#transcript>.promotion-dialog .promotion-actions button{min-height:44px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);padding:9px 12px;touch-action:manipulation}
#conversation-toolbar button[aria-pressed=true]{border-color:var(--pi);color:var(--pi)}#conversation-toolbar button:disabled{opacity:.5}
#transcript.conversation-covered{display:none}#conversation-options{flex:1;min-height:0;overflow:auto;padding:20px clamp(12px,3vw,40px);scrollbar-gutter:stable}
#conversation-options>.team-schedule,#conversation-options>[data-team-detail=memory]{max-width:850px;margin:0 auto!important;padding:0!important;border:0!important}
#conversation-options>.team-schedule>summary,#conversation-options>[data-team-detail=memory]>summary{display:none}
#conversation-options [data-team-detail=memory]>.muted{line-height:1.65;margin:14px 0;white-space:pre-wrap;overflow-wrap:anywhere}
#conversation-options button{min-height:44px}#conversation-options [data-team-detail=memory] button{padding:10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--text)}
.settings-workspace{grid-template-rows:auto minmax(0,1fr)}.settings-header{min-height:64px}.settings-heading span{font-size:12px}
.settings-content{padding-bottom:24px}.settings-panel>.muted{font-size:13px;line-height:1.6}.settings-grid{gap:14px;align-items:start}
.settings-card{padding:0}.settings-card>.settings-disclosure>summary{padding:16px;cursor:pointer;list-style:none;position:relative;padding-right:42px}
.settings-disclosure>summary::-webkit-details-marker{display:none}.settings-disclosure>summary:after{content:'›';position:absolute;right:17px;top:16px;font-size:22px;color:var(--pi)}
.settings-disclosure[open]>summary:after{transform:rotate(90deg)}.settings-card:has(>.settings-disclosure[open]){grid-column:1/-1}
.settings-card-header strong{font-size:14px}.settings-badge,.settings-state,.settings-card .capability-meta{font-size:12px;line-height:1.6}.settings-card-header strong{white-space:normal}
.settings-card-body{padding:0 16px 16px;border-top:1px solid var(--line)}.settings-card-body:empty{display:none}
.settings-workspace label,#transcript>.promotion-dialog label{font-size:13px;line-height:1.6;gap:8px}.settings-workspace input:not([type=checkbox]),.settings-workspace select,.settings-workspace textarea,#transcript>.promotion-dialog input:not([type=checkbox]),#transcript>.promotion-dialog select,#transcript>.promotion-dialog textarea{min-width:0;max-width:100%;min-height:44px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--text);padding:10px;font:inherit}
.settings-workspace input[type=checkbox],#transcript>.promotion-dialog input[type=checkbox]{width:18px;height:18px;accent-color:var(--pi)}
.settings-workspace .provider-field-row{gap:8px}.settings-workspace .provider-field-action{min-width:44px;min-height:44px}.settings-workspace .provider-permissions{grid-template-columns:1fr}
.settings-workspace .provider-service{padding:12px;min-width:0}.settings-workspace .provider-capability{min-height:44px;display:flex;align-items:center;gap:10px}
.settings-workspace .configuration-form{display:grid;gap:18px;padding-top:16px}.settings-workspace summary,#transcript>.promotion-dialog summary{min-height:44px;line-height:1.5;padding:12px 0;cursor:pointer}
.builder-settings-title{font-size:14px}.builder-settings-description,.builder-settings-status{font-size:12px;line-height:1.5}.builder-settings-grid>label{font-size:13px;line-height:1.5}.builder-settings-grid{gap:14px}.builder-settings-group>summary{min-height:56px}.builder-settings-grid input,.builder-settings-grid select{min-height:44px}
#transcript>.promotion-dialog{background:var(--panel)}#transcript>.promotion-dialog form{overflow:visible;gap:20px}#transcript>.promotion-dialog details{border-top:1px solid var(--line);padding:4px 0}#transcript>.promotion-dialog details>label{margin:12px 0}
#transcript>.promotion-dialog .promotion-actions,.settings-form-actions,.settings-edit-footer{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;flex-wrap:wrap;gap:8px;background:var(--panel);border-top:1px solid var(--line);padding:12px 0;margin-top:12px;box-shadow:0 -10px 18px var(--panel)}
.settings-edit-footer[hidden]{display:none}.settings-edit-footer .muted{flex:1 1 150px;font-size:12px}.settings-inline-error{color:var(--danger);font-size:13px;line-height:1.5}
.settings-workspace :focus-visible,#conversation-toolbar :focus-visible,#conversation-options :focus-visible,#transcript>.promotion-dialog :focus-visible{outline:2px solid var(--pi);outline-offset:3px}
.rail>#open-settings{position:relative!important;inset:auto!important;flex:0 0 44px;width:100%;margin-top:10px;display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);padding:10px;z-index:4}
.rail>#open-settings svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8}
@media(max-width:1100px){.settings-grid{grid-template-columns:1fr}.settings-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.settings-nav{display:flex;flex-wrap:wrap;gap:4px;border-right:0;border-bottom:1px solid var(--line);padding:8px}.settings-nav button{flex:1 1 100px;text-align:center;min-height:44px}.settings-content{padding:16px 12px}.settings-card-body{padding:0 12px 12px}}
@media(max-width:620px){#conversation-toolbar{padding:8px 12px;gap:6px}#conversation-toolbar strong{flex-basis:100%}#conversation-toolbar button{flex:1;font-size:13px;padding:8px}.settings-nav button{font-size:12px;flex-basis:90px}.settings-header{padding:10px 12px}.settings-heading span{max-width:70vw}.settings-workspace .provider-field-row{grid-template-columns:minmax(0,1fr) auto auto}.settings-workspace .provider-field-row input{width:100%}}
`;
	document.head.append(style);
	const settingsButton = document.getElementById("open-settings");
	if (settingsButton) {
		const text = document.createElement("span");
		text.textContent = "Settings";
		settingsButton.append(text);
		document.querySelector(".rail")?.append(settingsButton);
	}
	function enhanceForm(form: HTMLFormElement): void {
		if (enhancedForms.has(form)) return;
		enhancedForms.add(form);
		const defaults = new Map<SettingControl, { value: string; checked?: boolean }>();
		const remember = () => {
			for (const control of form.querySelectorAll<SettingControl>("input:not([type=hidden]),select,textarea"))
				defaults.set(control, {
					value: control.value,
					checked: control instanceof HTMLInputElement ? control.checked : undefined,
				});
		};
		remember();
		const footer = document.createElement("div");
		footer.className = "settings-edit-footer";
		footer.hidden = true;
		const state = document.createElement("span");
		state.className = "muted";
		state.textContent = "Unsaved changes";
		state.setAttribute("role", "status");
		const discard = document.createElement("button");
		discard.type = "button";
		discard.textContent = "Discard edits";
		const saveField = document.createElement("button");
		saveField.type = "button";
		saveField.hidden = true;
		let fieldAction: HTMLButtonElement | undefined;
		saveField.addEventListener("click", () => fieldAction?.click());
		discard.addEventListener("click", () => {
			for (const [control, initial] of defaults) {
				control.value = initial.value;
				if (control instanceof HTMLInputElement && initial.checked !== undefined) control.checked = initial.checked;
				control.dispatchEvent(new Event("input", { bubbles: true }));
				control.dispatchEvent(new Event("change", { bubbles: true }));
			}
			footer.hidden = true;
		});
		footer.append(state, saveField, discard);
		const existingActions = form.querySelector<HTMLElement>(".promotion-actions,.settings-form-actions");
		if (existingActions) {
			existingActions.prepend(state);
			state.hidden = true;
		} else form.append(footer);
		form.addEventListener("settings-baseline", () => {
			remember();
			footer.hidden = state.hidden = true;
		});
		form.addEventListener("input", () => {
			const dirty = [...defaults].some(
				([control, initial]) =>
					control.value !== initial.value ||
					(control instanceof HTMLInputElement && control.checked !== initial.checked),
			);
			footer.hidden = !dirty;
			state.hidden = !dirty;
		});
		form.addEventListener("focusin", (event) => {
			const control = event.target;
			if (!(control instanceof HTMLElement) || footer.contains(control)) return;
			fieldAction =
				control
					.closest(".provider-field-row")
					?.querySelector<HTMLButtonElement>('.provider-field-action[title^="Save"]') ?? undefined;
			saveField.hidden = !fieldAction;
			saveField.textContent = fieldAction?.title ?? "Save field";
			saveField.disabled = fieldAction?.disabled ?? true;
		});
		new MutationObserver(() => {
			const disabled = fieldAction?.disabled ?? true;
			if (saveField.disabled !== disabled) saveField.disabled = disabled;
		}).observe(form, { attributes: true, subtree: true, attributeFilter: ["disabled"] });
		form.addEventListener(
			"invalid",
			(event) => {
				const control = event.target;
				if (
					!(
						control instanceof HTMLInputElement ||
						control instanceof HTMLTextAreaElement ||
						control instanceof HTMLSelectElement
					)
				)
					return;
				for (let parent = control.parentElement; parent; parent = parent.parentElement)
					if (parent instanceof HTMLDetailsElement) parent.open = true;
				let error = control.parentElement?.querySelector<HTMLElement>(".settings-inline-error");
				if (!error) {
					error = document.createElement("span");
					error.className = "settings-inline-error";
					error.setAttribute("role", "alert");
					control.after(error);
				}
				error.textContent = control.validationMessage;
				control.setAttribute("aria-invalid", "true");
				control.addEventListener("input", () => {
					if (control.validity.valid) {
						error?.remove();
						control.removeAttribute("aria-invalid");
					}
				});
			},
			true,
		);
	}
	function update(): void {
		for (const card of settings?.querySelectorAll<HTMLElement>(".settings-card:not([data-disclosure-ready])") ?? []) {
			card.dataset.disclosureReady = "true";
			const key = `${card.closest("[data-settings-panel]")?.id}/${card.dataset.settingsResource}`;
			const details = document.createElement("details");
			details.className = "settings-disclosure";
			const summary = document.createElement("summary");
			const body = document.createElement("div");
			body.className = "settings-card-body";
			const children = [...card.children];
			let statusFound = false;
			for (const child of children) {
				if (!statusFound) summary.append(child);
				else body.append(child);
				if (child.classList.contains("settings-state")) statusFound = true;
			}
			details.append(summary, body);
			card.append(details);
			const resource = location.hash.split("/")[2];
			details.open =
				opened.get(key) ?? Boolean(resource && decodeURIComponent(resource) === card.dataset.settingsResource);
			details.addEventListener("toggle", () => opened.set(key, details.open));
			card.addEventListener("focus", () => {
				details.open = true;
			});
		}
		for (const root of [settings, transcript, options])
			for (const form of root?.querySelectorAll<HTMLFormElement>(
				".provider-configuration-form,.promotion-dialog>form,.team-schedule>form",
			) ?? []) {
				enhanceForm(form);
				organizeTeamEditor(form);
			}
	}
	for (const root of [settings, transcript, options])
		if (root) new MutationObserver(update).observe(root, { childList: true, subtree: true });
	update();
}
