import type { AuthType, ModelAuth, ModelAuthConnection } from "./types.ts";

/** Classify already-resolved request auth without retaining or returning credential values. */
export function getModelAuthConnection(
	providerId: string,
	auth: ModelAuth,
	type: AuthType = "api_key",
): ModelAuthConnection {
	const connection: ModelAuthConnection = { type, ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }) };
	if (type === "oauth") return connection;
	if (providerId === "anthropic") {
		// Match the Anthropic adapter's bearer routing, including tokens stored in API-key fields.
		if (auth.apiKey?.includes("sk-ant-oat")) connection.type = "oauth";
		else if (
			Object.entries(auth.headers ?? {}).some(
				([name, value]) => name.toLowerCase() === "authorization" && value != null,
			)
		)
			connection.type = "bearer";
		else if (
			!auth.apiKey &&
			!Object.entries(auth.headers ?? {}).some(
				([name, value]) => name.toLowerCase() === "x-api-key" && Boolean(value),
			)
		)
			connection.type = "unknown";
	}
	return connection;
}
