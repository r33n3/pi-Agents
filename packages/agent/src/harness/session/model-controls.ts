import { assertModelControls, type ModelControls, ModelControlsError } from "@earendil-works/pi-ai";
import { type Entry, type LaneRecord, type NewRecord, type ProvisionedEntry, SessionError } from "./types.ts";

function validateEntryModelControls(entry: ProvisionedEntry): void {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new SessionError("invalid_payload", "Invalid session entry containing model controls");
	}
	if (entry.type === "model_controls_change" && entry.modelControls !== null) {
		assertModelControls(entry.modelControls);
	}
}

/** Shape validation is catalog-independent; execution must still validate against the resolved model. */
export function validateSessionModelControls(payload: Entry | ProvisionedEntry | LaneRecord | NewRecord): void {
	try {
		switch (payload.type) {
			case "model_controls_change":
				validateEntryModelControls(payload);
				break;
			case "operation_started":
				if (typeof payload.intent !== "object" || payload.intent === null) {
					throw new SessionError("invalid_payload", "Invalid session operation intent");
				}
				if (payload.intent.kind === "run") {
					if (!Array.isArray(payload.intent.initialMessages)) {
						throw new SessionError("invalid_payload", "Invalid session initial entries");
					}
					for (const entry of payload.intent.initialMessages) validateEntryModelControls(entry);
				}
				break;
			case "queue_enqueued":
			case "write_deferred":
				validateEntryModelControls(payload.target);
				break;
		}
	} catch (error) {
		if (error instanceof ModelControlsError) {
			throw new SessionError("invalid_payload", "Invalid session model controls", error);
		}
		throw error;
	}
}

/** Entries must be oldest first. A historical thinking/model entry never silently clears native settings. */
export function readSessionModelControls(
	entries: readonly Entry[],
	defaults?: ModelControls,
): ModelControls | undefined {
	let latest: Extract<Entry, { type: "model_controls_change" }> | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type === "model_controls_change") {
			latest = entry;
			break;
		}
	}
	const controls = latest === undefined ? defaults : latest.modelControls;
	if (controls === null || (controls === undefined && latest === undefined)) return undefined;
	assertModelControls(controls);
	return { ...controls };
}
