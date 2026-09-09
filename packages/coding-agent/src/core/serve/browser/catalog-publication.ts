import type { CatalogPackageReview } from "../catalog-package-contract.ts";

interface CatalogSource {
	kind: "agent" | "team";
	id: string;
	name: string;
}

/** Catalog-neutral presentation. Export is never presented as successful remote publication. */
export function installCatalogPublication(): void {
	const token = new URL(location.href).searchParams.get("token");
	const transcript = document.getElementById("transcript");
	const toolbar = document.getElementById("conversation-toolbar");
	if (!token || !transcript) return;
	const panel = document.createElement("section");
	panel.className = "catalog-publication";
	panel.setAttribute("aria-label", "Publish to catalog");
	panel.hidden = true;
	transcript.before(panel);
	let generation = 0;
	let restoreFocus: HTMLElement | undefined;
	let sources: CatalogSource[] = [];
	let review: CatalogPackageReview | undefined;
	const button = (text: string, action: () => void) => {
		const item = document.createElement("button");
		item.type = "button";
		item.textContent = text;
		item.addEventListener("click", action);
		return item;
	};
	const close = () => {
		generation++;
		panel.hidden = true;
		transcript.parentElement?.classList.remove("catalog-review-open");
		restoreFocus?.focus({ preventScroll: true });
	};
	const header = document.createElement("header");
	const title = document.createElement("h2");
	title.textContent = "Publish to catalog";
	header.append(title, button("Back", close));
	const body = document.createElement("div");
	body.className = "catalog-review-body";
	const sourceLabel = document.createElement("label");
	sourceLabel.textContent = "Saved agent or team";
	const source = document.createElement("select");
	source.setAttribute("aria-label", "Saved agent or team");
	sourceLabel.append(source);
	const versionLabel = document.createElement("label");
	versionLabel.textContent = "Package version";
	const version = document.createElement("input");
	version.value = "1.0.0";
	version.pattern = "[0-9]+\\.[0-9]+\\.[0-9]+";
	version.setAttribute("aria-label", "Package version");
	versionLabel.append(version);
	const status = document.createElement("p");
	status.setAttribute("role", "status");
	const content = document.createElement("div");
	content.className = "catalog-review-content";
	const footer = document.createElement("footer");
	const download = button("Download package", () => {
		if (!review) return;
		const blob = new Blob([`${JSON.stringify(review.package, null, 2)}\n`], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `pi-${review.package.kind}-${review.package.version}.json`;
		link.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 1000);
		status.textContent = "Package downloaded. It has not been published to a catalog.";
	});
	download.disabled = true;
	const publish = button("Publish to catalog", () => {});
	publish.disabled = true;
	publish.title = "A catalog admission adapter is required before publishing";
	const connection = document.createElement("span");
	connection.textContent = "Catalog not connected · export only";
	connection.className = "muted";
	footer.append(download, publish, connection);
	const intro = document.createElement("p");
	intro.textContent =
		"Review the saved configuration as a reusable package. Unsaved edits are not included. Publishing does not deploy or run an agent.";
	const fields = document.createElement("div");
	fields.className = "catalog-review-fields";
	fields.append(sourceLabel, versionLabel);
	body.append(intro, fields, status, content);
	panel.append(header, body, footer);
	const request = async (params: Record<string, string>) => {
		const response = await fetch(`/catalog-publication?${new URLSearchParams({ token, ...params })}`, {
			signal: AbortSignal.timeout(15000),
		});
		if (!response.ok) {
			const error = (await response.json()) as { error?: string };
			throw new Error(error.error ?? `Catalog review failed (${response.status})`);
		}
		return response.json();
	};
	const textSection = (label: string, text: string, open = false) => {
		const details = document.createElement("details");
		details.open = open;
		const summary = document.createElement("summary");
		summary.textContent = label;
		const value = document.createElement("p");
		value.textContent = text;
		details.append(summary, value);
		return details;
	};
	const refresh = async () => {
		const current = ++generation;
		review = undefined;
		download.disabled = true;
		content.replaceChildren();
		const selected = sources[Number(source.value)];
		if (!selected) {
			status.textContent = "No saved agents or teams are available.";
			return;
		}
		status.textContent = "Preparing package…";
		try {
			const next = (await request({
				kind: selected.kind,
				id: selected.id,
				version: version.value,
			})) as CatalogPackageReview;
			if (current !== generation) return;
			review = next;
			status.textContent = `${next.package.name} · ${next.package.kind} · version ${next.package.version}`;
			content.append(textSection("Purpose", next.package.description || "No purpose saved", true));
			for (const member of next.package.members)
				content.append(
					textSection(
						member.name,
						`${member.description}\n\nRole\n${member.role}\n\nAgent instructions\n${member.instructions}\n\nTeam instructions\n${member.teamInstructions || "None"}\n\nTool requirements: ${member.toolRequirements.join(", ") || "None"}`,
					),
				);
			content.append(textSection("Excluded personal data", next.excluded.join("\n")));
			content.append(
				textSection(
					"Review before sharing",
					"Names, descriptions, instructions, and memory-policy wording are included verbatim. Check them for personal details before sharing. Learned memory and shared notes are excluded.",
					true,
				),
			);
			if (next.issues.length) content.append(textSection("Requirements to resolve", next.issues.join("\n"), true));
			content.append(
				textSection(
					"Catalog connection",
					"The catalog integration must support importing and validating Pi agents and teams before publishing is available. You can download this package for review. It is not yet an installable package or a published listing.",
				),
			);
			const exact = document.createElement("details");
			const summary = document.createElement("summary");
			summary.textContent = "Exact package contents";
			const json = document.createElement("pre");
			json.textContent = JSON.stringify(next.package, null, 2);
			exact.append(summary, json);
			content.append(exact);
			download.disabled = false;
		} catch (error) {
			if (current === generation)
				status.textContent = error instanceof Error ? error.message : "Could not prepare package";
		}
	};
	source.addEventListener("change", () => void refresh());
	version.addEventListener("input", () => {
		generation++;
		review = undefined;
		download.disabled = true;
		status.textContent = "Select Review version to prepare this version.";
	});
	versionLabel.append(button("Review version", () => void refresh()));
	const open = async (kind?: string, id?: string) => {
		restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		panel.hidden = false;
		transcript.parentElement?.classList.add("catalog-review-open");
		panel.tabIndex = -1;
		panel.focus();
		const current = ++generation;
		review = undefined;
		download.disabled = true;
		content.replaceChildren();
		status.textContent = "Loading saved agents and teams…";
		try {
			const result = (await request({})) as { sources: CatalogSource[] };
			if (current !== generation) return;
			sources = result.sources;
			source.replaceChildren();
			for (const [index, entry] of sources.entries()) {
				const option = document.createElement("option");
				option.value = String(index);
				option.textContent = `${entry.name} · ${entry.kind}`;
				source.append(option);
			}
			const selected = sources.findIndex((entry) => entry.kind === kind && entry.id === id);
			source.value = String(Math.max(0, selected));
			await refresh();
		} catch (error) {
			if (current === generation)
				status.textContent = error instanceof Error ? error.message : "Could not load saved agents";
		}
	};
	toolbar?.append(button("Publish to catalog", () => void open("team", toolbar.dataset.catalogTeamId)));
	const agentForm = document.getElementById("agent-form");
	agentForm?.append(
		button(
			"Publish to catalog",
			() => void open("agent", document.querySelector<HTMLInputElement>("#agent-id")?.value),
		),
	);
	document.addEventListener("click", (event) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const cardButton = target.closest<HTMLElement>("[data-catalog-agent-id]");
		if (cardButton) void open("agent", cardButton.dataset.catalogAgentId);
		else if (!panel.hidden && target.closest(".rail")) close();
	});
	panel.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			close();
		}
	});
	const style = document.createElement("style");
	style.textContent = `
.catalog-review-open>#transcript,.catalog-review-open>#conversation-options,.catalog-review-open>#conversation-toolbar,.catalog-review-open>.chat-dock{display:none!important}
.catalog-review-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(130px,220px);gap:18px;align-items:start}@media(max-width:620px){.catalog-review-fields{grid-template-columns:1fr}}
.catalog-publication{display:flex;flex:1;flex-direction:column;min-height:0;background:var(--panel);color:var(--text)}.catalog-publication[hidden]{display:none}
.catalog-publication header,.catalog-publication footer{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 18px;border-bottom:1px solid var(--line);flex-shrink:0}.catalog-publication header h2{flex:1;margin:0;font-size:18px}.catalog-publication footer{border-top:1px solid var(--line);border-bottom:0}
.catalog-review-body{overflow:auto;min-height:0;padding:18px;display:grid;gap:18px}.catalog-review-body>*,.catalog-review-content{width:100%;max-width:850px;margin:0 auto;box-sizing:border-box}.catalog-publication label{display:grid;gap:8px;font-size:13px}.catalog-publication p{white-space:pre-wrap;line-height:1.6;font-size:13px;overflow-wrap:anywhere}.catalog-publication details{padding:12px 0;border-bottom:1px solid var(--line)}.catalog-publication summary{cursor:pointer;min-height:32px}.catalog-publication pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.catalog-publication button,.catalog-publication input,.catalog-publication select{min-height:44px;min-width:0;max-width:100%;border:1px solid var(--line);border-radius:9px;padding:10px;background:var(--surface);color:var(--text);font:inherit}.catalog-publication button:disabled{opacity:.5}.catalog-publication :focus-visible{outline:2px solid var(--pi);outline-offset:2px}
`;
	document.head.append(style);
}
