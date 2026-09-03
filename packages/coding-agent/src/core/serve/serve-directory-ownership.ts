import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";

const STALE_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 2_500;

export interface ServeDirectoryOwnership extends AsyncDisposable {
	readonly path: string;
	release(): Promise<void>;
}

class AcquiredServeDirectoryOwnership implements ServeDirectoryOwnership {
	readonly path: string;
	readonly #releaseLock: () => Promise<void>;
	#compromised = false;
	#releasePromise: Promise<void> | undefined;

	constructor(path: string, releaseLock: () => Promise<void>) {
		this.path = path;
		this.#releaseLock = releaseLock;
	}

	release(): Promise<void> {
		this.#releasePromise ??= this.#compromised ? Promise.resolve() : this.#releaseLock();
		return this.#releasePromise;
	}

	markCompromised(): void {
		this.#compromised = true;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.release();
	}
}

/** Acquires the process-long lease protecting all persistent state below one serve root. */
export async function acquireServeDirectoryOwnership(
	serveRoot: string,
	onCompromised: (error: Error) => void,
): Promise<ServeDirectoryOwnership> {
	const resolvedRoot = resolve(serveRoot);
	await mkdir(resolvedRoot, { recursive: true });
	const canonicalRoot = await realpath(resolvedRoot);
	try {
		let ownership: AcquiredServeDirectoryOwnership | undefined;
		const release = await lockfile.lock(canonicalRoot, {
			realpath: true,
			stale: STALE_INTERVAL_MS,
			update: HEARTBEAT_INTERVAL_MS,
			retries: 0,
			onCompromised: (error) => {
				ownership?.markCompromised();
				onCompromised(error);
			},
		});
		ownership = new AcquiredServeDirectoryOwnership(canonicalRoot, release);
		return ownership;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error(
				`Serve data directory ${canonicalRoot} is already owned by another Pi serve host. Stop that host, or wait up to 10 seconds after a crash.`,
				{ cause: error },
			);
		}
		throw error;
	}
}
