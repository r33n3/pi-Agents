export function normalizePersonaName(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
		throw new Error(`Invalid persona name "${name}". Use a catalog identifier such as "greybeard".`);
	}
	return normalized;
}
