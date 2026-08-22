import type { AgentSession } from "../agent-session.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "../package-manager.ts";

/** Provides explicit, validated plugin lifecycle operations for the local console. */
export class PluginManagementService {
	readonly #session: AgentSession;
	readonly #manager: DefaultPackageManager;

	constructor(session: AgentSession, cwd: string, agentDir: string) {
		this.#session = session;
		this.#manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: session.settingsManager });
	}

	list(): ConfiguredPackage[] {
		return this.#manager.listConfiguredPackages();
	}

	async install(source: string, scope: "user" | "project", approved: boolean): Promise<void> {
		assertApproval(approved);
		const validated = validatePluginSource(source);
		await this.#manager.installAndPersist(validated, { local: scope === "project" });
		await this.#session.resourceLoader.reload();
	}

	async remove(source: string, scope: "user" | "project", approved: boolean): Promise<boolean> {
		assertApproval(approved);
		const removed = await this.#manager.removeAndPersist(validatePluginSource(source), {
			local: scope === "project",
		});
		await this.#session.resourceLoader.reload();
		return removed;
	}

	async update(source: string, approved: boolean): Promise<void> {
		assertApproval(approved);
		await this.#manager.update(validatePluginSource(source));
		await this.#session.resourceLoader.reload();
	}
}

function assertApproval(approved: boolean): void {
	if (!approved) throw new Error("Plugin lifecycle changes require explicit approval");
}

export function validatePluginSource(source: string): string {
	const value = source.trim();
	if (!value || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error("Plugin source is invalid");
	if (/\s/.test(value)) throw new Error("Plugin source must not contain whitespace");
	return value;
}
