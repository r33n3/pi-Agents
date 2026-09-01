import { assertModelControls, type ModelControls, ModelControlsError } from "@earendil-works/pi-ai";

/** Parse durable settings without needing a live catalog; omitted controls retain legacy thinking. */
export function parseAgentModelControls(settings: {
	model?: unknown;
	thinking?: unknown;
	modelControls?: unknown;
}): ModelControls | undefined {
	if (settings.modelControls === undefined) return undefined;
	assertModelControls(settings.modelControls);
	if (settings.thinking !== undefined)
		throw new ModelControlsError("Choose agent modelControls or legacy thinking, not both");
	if (settings.model === undefined || settings.model === null)
		throw new ModelControlsError("Select an explicit agent model before setting modelControls");
	return { ...settings.modelControls };
}
