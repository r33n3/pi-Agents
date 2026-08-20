import { timingSafeEqual } from "node:crypto";

export function matchesCapabilityToken(expected: string, candidate: string | null): boolean {
	if (candidate === null) return false;
	const expectedBytes = Buffer.from(expected, "utf8");
	const candidateBytes = Buffer.from(candidate, "utf8");
	return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}
