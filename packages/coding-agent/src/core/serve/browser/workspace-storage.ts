let storage: Promise<{ workspace: string; settings: string }> | undefined;

export function createWorkspaceStorageCard(token: string): HTMLElement {
	const card = document.createElement("div");
	card.style.cssText = "display:flex;align-items:center;gap:8px;padding:4px 8px 10px;min-width:0";
	const path = document.createElement("span");
	path.textContent = "Loading storage…";
	path.style.cssText =
		"flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-muted);font-size:11px";
	const folder = document.createElement("a");
	folder.href = `/workspace-storage?${new URLSearchParams({ token })}`;
	folder.target = "_blank";
	folder.rel = "noopener noreferrer";
	folder.setAttribute("aria-label", "Browse workspace storage");
	folder.title = "Browse workspace storage on the Pi host";
	folder.style.cssText = "display:block;flex:0 0 24px;width:24px;height:24px;color:var(--pi)";
	folder.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5h6l3 3h9v12H3Z"/><path d="M3 10h18"/></svg>';
	card.append(path, folder);
	storage ??= fetch(`/workspace-storage?${new URLSearchParams({ token, format: "json" })}`).then(async (response) => {
		if (!response.ok) throw new Error("Storage location unavailable");
		const data: unknown = await response.json();
		if (
			!data ||
			typeof data !== "object" ||
			!("workspace" in data) ||
			typeof data.workspace !== "string" ||
			!("settings" in data) ||
			typeof data.settings !== "string"
		)
			throw new Error("Storage location unavailable");
		return { workspace: data.workspace, settings: data.settings };
	});
	void storage
		.then((data) => {
			path.textContent = data.workspace;
			path.title = `Workspace storage: ${data.workspace}\nSettings and encrypted vault: ${data.settings}`;
		})
		.catch(() => {
			path.textContent = "Storage location unavailable";
			storage = undefined;
		});
	return card;
}
