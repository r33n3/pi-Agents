import type { BrowserSetup } from "../browser-setup-store.ts";

const token = new URL(location.href).searchParams.get("token");
const panel = document.querySelector<HTMLElement>("#browser");
if (token && panel) installBrowserSetup(panel, token);

function installBrowserSetup(panel: HTMLElement, token: string): void {
	const endpoint = `/browser/setup?token=${encodeURIComponent(token)}`;
	const details = document.createElement("details");
	details.className = "card";
	details.classList.add("browser-setup-editor");
	const style = document.createElement("style");
	style.textContent = `
.browser-setup-editor{container-type:inline-size}.browser-setup-editor p{font-size:13px;line-height:1.6}.browser-setup-editor form{display:grid;gap:18px;padding:16px 0}.browser-setup-editor form[hidden]{display:none}.browser-setup-editor label{display:grid;gap:7px;min-width:0;font-size:13px;color:var(--muted);line-height:1.5}.browser-setup-editor label[hidden]{display:none}.browser-setup-editor input,.browser-setup-editor select{width:100%;min-width:0;min-height:44px;border:1px solid var(--line);border-radius:9px;padding:10px;background:var(--panel);color:var(--text);font:inherit}.browser-setup-editor button{min-height:44px;border:1px solid var(--line);border-radius:9px;padding:10px;background:var(--surface2);color:var(--text);font:inherit}.browser-setup-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 0}.browser-setup-tabs button{flex:1}.browser-setup-tabs button[aria-pressed=true]{border-color:var(--pi);color:var(--pi)}.browser-setup-editor :focus-visible{outline:2px solid var(--pi);outline-offset:2px}
`;
	document.head.append(style);
	const summary = document.createElement("summary");
	summary.textContent = "Browser and site setup";
	const description = document.createElement("p");
	description.textContent =
		"Save once, then assign to selected members in team tools or ask your supervisor. Sign-ins stay in the named profile.";
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	const profileForm = document.createElement("form");
	const profileSelect = select("Saved browser profile", [["", "New profile"]], profileForm);
	const profileName = field("Profile name", profileForm);
	const profileId = field("Profile ID", profileForm);
	profileId.pattern = "[a-z0-9][a-z0-9-]{0,63}";
	const access = select(
		"Profile network access",
		[
			["public-web", "Public websites"],
			["loopback", "Local only"],
			["private-network", "LAN and local"],
		],
		profileForm,
	);
	const engine = select(
		"Profile browser engine",
		[
			["managed-chromium", "Managed Chromium"],
			["installed-chrome", "Installed Chrome"],
		],
		profileForm,
	);
	const saveProfile = document.createElement("button");
	saveProfile.textContent = "Save browser profile";
	profileForm.append(saveProfile);
	const siteForm = document.createElement("form");
	const siteSelect = select("Saved site preference", [["", "New site"]], siteForm);
	const siteName = field("Site name", siteForm);
	const siteId = field("Site ID", siteForm);
	siteId.pattern = profileId.pattern;
	const siteUrl = field("Site URL", siteForm);
	siteUrl.type = "url";
	const mode = select(
		"Preferred site interface",
		[
			["browser", "Browser"],
			["markdown", "Markdown"],
			["llms", "llms.txt documentation"],
			["connection", "Existing API or MCP tool"],
		],
		siteForm,
	);
	const contentUrl = field("Markdown or documentation URL (optional)", siteForm);
	contentUrl.required = false;
	contentUrl.type = "url";
	const connection = select("Existing configured capability", [["", "Choose a configured capability"]], siteForm);
	const saveSite = document.createElement("button");
	saveSite.textContent = "Save site preference";
	siteForm.append(saveSite);
	const tabs = document.createElement("nav");
	tabs.className = "browser-setup-tabs";
	tabs.setAttribute("aria-label", "Browser setup sections");
	for (const [label, target] of [
		["Browser profiles", profileForm],
		["Site preferences", siteForm],
	] as const) {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.setAttribute("aria-pressed", String(target === profileForm));
		button.addEventListener("click", () => {
			profileForm.hidden = target !== profileForm;
			siteForm.hidden = target !== siteForm;
			for (const tab of tabs.querySelectorAll("button")) tab.setAttribute("aria-pressed", String(tab === button));
		});
		tabs.append(button);
	}
	siteForm.hidden = true;
	const updateSiteFields = () => {
		contentUrl.parentElement!.hidden = mode.value !== "markdown" && mode.value !== "llms";
		connection.parentElement!.hidden = mode.value !== "connection";
		contentUrl.disabled = contentUrl.parentElement!.hidden;
		connection.disabled = connection.parentElement!.hidden;
	};
	mode.addEventListener("change", updateSiteFields);
	updateSiteFields();
	details.append(summary, description, tabs, profileForm, siteForm, status);
	panel.append(details);
	let setup: BrowserSetup = { profiles: [], sites: [] };
	const load = async () => {
		const selectedProfile = profileSelect.value;
		const selectedSite = siteSelect.value;
		const selectedConnection = connection.value;
		const response = await fetch(endpoint);
		if (!response.ok) throw new Error("Could not load browser setup");
		setup = (await response.json()) as BrowserSetup;
		const catalogResponse = await fetch(`/agent-rooms.json?token=${encodeURIComponent(token)}`);
		if (catalogResponse.ok) {
			const catalog = (await catalogResponse.json()) as {
				tools: Array<{ id: string; name: string; capabilities: unknown[] }>;
			};
			connection.replaceChildren(
				new Option("Choose a configured capability", ""),
				...catalog.tools
					.filter((tool) => tool.capabilities.length > 0)
					.map((tool) => new Option(tool.name, tool.id)),
			);
		}
		profileSelect.replaceChildren(
			new Option("New profile", ""),
			...setup.profiles.map((entry) => new Option(entry.name, entry.id)),
		);
		siteSelect.replaceChildren(
			new Option("New site", ""),
			...setup.sites.map((entry) => new Option(entry.name, entry.id)),
		);
		profileSelect.value = selectedProfile;
		siteSelect.value = selectedSite;
		connection.value = selectedConnection;
	};
	const save = async (update: unknown) => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(update),
		});
		if (!response.ok) {
			const error = (await response.json()) as { error?: string };
			throw new Error(error.error ?? "Could not save browser setup");
		}
		await load();
		status.textContent = "Saved. Select it in team tools or ask the supervisor to assign it.";
	};
	profileSelect.addEventListener("change", () => {
		const profile = setup.profiles.find((entry) => entry.id === profileSelect.value);
		profileId.value = profile?.id ?? "";
		profileName.value = profile?.name ?? "";
		access.value = profile?.access ?? "public-web";
		engine.value = profile?.runtime ?? "managed-chromium";
	});
	siteSelect.addEventListener("change", () => {
		const site = setup.sites.find((entry) => entry.id === siteSelect.value);
		siteId.value = site?.id ?? "";
		siteName.value = site?.name ?? "";
		siteUrl.value = site?.url ?? "";
		mode.value = site?.mode ?? "browser";
		contentUrl.value = site?.contentUrl ?? "";
		connection.value = site?.connectionToolId ?? "";
		updateSiteFields();
	});
	profileForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void save({
			profiles: [{ id: profileId.value, name: profileName.value, access: access.value, runtime: engine.value }],
			sites: [],
		})
			.then(() => {
				profileSelect.value = profileId.value;
			})
			.catch((error: unknown) => {
				status.textContent = String(error);
			});
	});
	siteForm.addEventListener("submit", (event) => {
		event.preventDefault();
		void save({
			profiles: [],
			sites: [
				{
					id: siteId.value,
					name: siteName.value,
					url: siteUrl.value,
					mode: mode.value,
					contentUrl: contentUrl.disabled ? undefined : contentUrl.value || undefined,
					connectionToolId: connection.disabled ? undefined : connection.value || undefined,
				},
			],
		})
			.then(() => {
				siteSelect.value = siteId.value;
			})
			.catch((error: unknown) => {
				status.textContent = String(error);
			});
	});
	details.addEventListener("toggle", () => {
		if (details.open)
			void load().catch((error: unknown) => {
				status.textContent = String(error);
			});
	});
	let revision = 0;
	let polling = false;
	window.setInterval(() => {
		if (document.visibilityState !== "visible" || polling) return;
		polling = true;
		void (async () => {
			const response = await fetch(`/browser/presentation?token=${encodeURIComponent(token)}`);
			if (!response.ok) return;
			const payload = (await response.json()) as { presentation?: { revision: number; sessionId: string } };
			if (!payload.presentation || payload.presentation.revision === revision) return;
			revision = payload.presentation.revision;
			document.querySelector<HTMLInputElement>("#mobile-panel-right")?.click();
			document.querySelector<HTMLButtonElement>('[data-tab="browser"]')?.click();
			const sessionsResponse = await fetch(`/browser/sessions?token=${encodeURIComponent(token)}`);
			if (!sessionsResponse.ok) return;
			const sessions = (await sessionsResponse.json()) as { sessions: Array<{ id: string; title?: string }> };
			const title = sessions.sessions.find((entry) => entry.id === payload.presentation?.sessionId)?.title;
			if (title)
				window.setTimeout(() => {
					const button = [...document.querySelectorAll<HTMLButtonElement>(".preview-tabs button")].find((entry) =>
						entry.textContent?.includes(title),
					);
					button?.click();
				}, 500);
		})()
			.catch(() => {})
			.finally(() => {
				polling = false;
			});
	}, 2500);
}

function field(name: string, form: HTMLFormElement): HTMLInputElement {
	const label = document.createElement("label");
	label.textContent = name;
	const input = document.createElement("input");
	input.required = true;
	input.setAttribute("aria-label", name);
	label.append(input);
	form.append(label);
	return input;
}

function select(name: string, values: string[][], form: HTMLFormElement): HTMLSelectElement {
	const label = document.createElement("label");
	label.textContent = name;
	const input = document.createElement("select");
	input.setAttribute("aria-label", name);
	for (const [value, text] of values) input.add(new Option(text, value));
	label.append(input);
	form.append(label);
	return input;
}
