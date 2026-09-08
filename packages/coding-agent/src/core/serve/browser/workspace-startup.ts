const startup = document.getElementById("workspace-startup");
let settled = false;
const deadline = window.setTimeout(() => {
	failWorkspaceStartup(new Error("Opening the workspace took too long. Check your connection and select Retry."));
}, 30_000);

function failWorkspaceStartup(error: unknown): void {
	if (settled || !startup) return;
	settled = true;
	window.clearTimeout(deadline);
	document.body.dataset.workspaceLoading = "failed";
	const title = document.getElementById("workspace-startup-title");
	if (title) title.textContent = "Couldn’t open workspace";
	const message = document.getElementById("workspace-startup-message");
	if (message) {
		message.setAttribute("role", "alert");
		message.textContent = error instanceof Error ? error.message : String(error);
	}
}

window.addEventListener("error", (event) => failWorkspaceStartup(event.error ?? event.message));

export function workspaceStartupMessage(message: string): void {
	if (settled) return;
	const target = document.getElementById("workspace-startup-message");
	if (target) target.textContent = message;
}

export async function startWorkspace(initialize: () => Promise<void>): Promise<void> {
	try {
		await initialize();
		if (settled) return;
		settled = true;
		window.clearTimeout(deadline);
		delete document.body.dataset.workspaceLoading;
		startup?.remove();
	} catch (error) {
		failWorkspaceStartup(error);
	}
}
