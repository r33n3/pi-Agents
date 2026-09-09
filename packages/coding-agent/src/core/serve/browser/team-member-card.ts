import type { TeamMemberProfile } from "../team-member-profile.ts";

/** Read-only saved profile; editing remains in the existing agent/team forms. */
export function renderTeamMemberCard(
	profile: TeamMemberProfile,
	catalog: readonly { id: string; name: string; description: string }[],
): HTMLElement {
	const card = document.createElement("article");
	card.setAttribute("aria-label", `${profile.name} member card`);
	card.style.cssText =
		"display:grid;gap:14px;padding:16px;border:1px solid var(--line);border-radius:12px;overflow-wrap:anywhere";
	const title = document.createElement("strong");
	title.textContent = `${profile.name} · Revision ${profile.revision}`;
	card.append(title);
	for (const [label, value] of [
		["Purpose", profile.description],
		["Role in this team", profile.role],
		["Team instructions", profile.teamInstructions],
		["Agent instructions", profile.instructions],
	]) {
		const section = document.createElement("details");
		section.open = label !== "Agent instructions";
		const heading = document.createElement("summary");
		heading.textContent = label!;
		const text = document.createElement("p");
		text.style.cssText = "white-space:pre-wrap;line-height:1.6;margin:8px 0";
		text.textContent = value || "Not specified";
		section.append(heading, text);
		card.append(section);
	}
	const tools = document.createElement("details");
	const heading = document.createElement("summary");
	heading.textContent = `Assigned tools · ${profile.assignedToolIds.length}`;
	const list = document.createElement("ul");
	for (const id of profile.assignedToolIds) {
		const entry = catalog.find((tool) => tool.id === id);
		const item = document.createElement("li");
		item.textContent = entry?.name ?? id;
		item.title = entry?.description ?? "Configured tool ID";
		list.append(item);
	}
	const note = document.createElement("p");
	note.className = "muted";
	note.textContent = `Assignment source: ${profile.toolSource}. Configured access; connection health is checked when used. Role descriptions do not grant tools.`;
	tools.append(heading, list, note);
	card.append(tools);
	return card;
}
