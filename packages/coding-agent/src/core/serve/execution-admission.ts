import { isAbsolute, relative, resolve, sep } from "node:path";

/** Shared host capacity and workspace exclusion, including nested workspace paths. */
export class ExecutionAdmission {
	readonly #leases = new Map<string, { workspace: string; writable: boolean }>();
	readonly #capacity: number;

	constructor(capacity = 4) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Execution capacity must be positive");
		this.#capacity = capacity;
	}

	availability(workspace: string, writable: boolean): "available" | "capacity" | "workspace-busy" {
		if (this.#leases.size >= this.#capacity) return "capacity";
		const normalized = process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace);
		for (const lease of this.#leases.values()) {
			if (!writable && !lease.writable) continue;
			const forward = relative(lease.workspace, normalized);
			const backward = relative(normalized, lease.workspace);
			if (
				[forward, backward].some(
					(path) => path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)),
				)
			)
				return "workspace-busy";
		}
		return "available";
	}

	acquire(id: string, workspace: string, writable: boolean): () => void {
		if (this.#leases.has(id)) throw new Error(`Execution ${id} already owns a lease`);
		const availability = this.availability(workspace, writable);
		if (availability !== "available") throw new Error(`Execution ${availability}: ${workspace}`);
		this.#leases.set(id, {
			workspace: process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace),
			writable,
		});
		return () => {
			this.#leases.delete(id);
		};
	}
}
