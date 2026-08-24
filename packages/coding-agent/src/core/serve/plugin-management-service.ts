import type { AgentSession } from "../agent-session.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "../package-manager.ts";
import type { PackageSource } from "../settings-manager.ts";

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
		const validated = validatePinnedPluginSource(source);
		await this.#manager.install(validated, { local: scope === "project" });
		this.#manager.addSourceToSettings(validated, { local: scope === "project" });
		this.#setPackageAutoload(validated, scope, false);
		await this.#session.resourceLoader.reload();
	}

	async setActive(source: string, scope: "user" | "project", active: boolean, approved: boolean): Promise<void> {
		assertApproval(approved);
		const validated = validatePluginSource(source);
		if (!this.#setPackageAutoload(validated, scope, active)) throw new Error(`Plugin ${validated} is not configured`);
		try {
			await this.#session.resourceLoader.reload();
		} catch (error) {
			this.#setPackageAutoload(validated, scope, !active);
			await this.#session.resourceLoader.reload();
			throw error;
		}
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
		await this.#manager.update(validatePinnedPluginSource(source));
		await this.#session.resourceLoader.reload();
	}

	#setPackageAutoload(source: string, scope: "user" | "project", active: boolean): boolean {
		const settings =
			scope === "project"
				? this.#session.settingsManager.getProjectSettings()
				: this.#session.settingsManager.getGlobalSettings();
		const packages = settings.packages ?? [];
		const index = packages.findIndex((entry) => packageSource(entry) === source);
		if (index < 0) return false;
		const next = [...packages];
		next[index] = active ? source : { source, autoload: false };
		if (scope === "project") this.#session.settingsManager.setProjectPackages(next);
		else this.#session.settingsManager.setPackages(next);
		return true;
	}
}

function packageSource(value: PackageSource): string {
	return typeof value === "string" ? value : value.source;
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

export function validatePinnedPluginSource(source: string): string {
	const value = validatePluginSource(source);
	if (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|file:)/.test(value)) return value;
	if (/^(?:github:|git\+|https?:\/\/.*\.git)/.test(value)) {
		if (!/#[0-9a-f]{7,64}$/i.test(value)) throw new Error("Plugin source must use an exact Git commit digest");
		return value;
	}
	const version = value.startsWith("@") ? value.slice(value.indexOf("/") + 1).split("@")[1] : value.split("@")[1];
	if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
		throw new Error("Plugin source must use an exact package version");
	}
	return value;
}
