const RUNTIME_ENVIRONMENT_NAMES = [
	"ALL_PROXY",
	"APPDATA",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"COMSPEC",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NODE_EXTRA_CA_CERTS",
	"NO_PROXY",
	"PATH",
	"PATHEXT",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USERPROFILE",
	"WINDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
] as const;

/** Builds a minimal child environment without inheriting provider credentials. */
export function scopedSubprocessEnvironment(
	source: NodeJS.ProcessEnv = process.env,
	additionalNames: readonly string[] = [],
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const name of new Set<string>([...RUNTIME_ENVIRONMENT_NAMES, ...additionalNames])) {
		const key =
			process.platform === "win32"
				? Object.keys(source).find((entry) => entry.toUpperCase() === name.toUpperCase())
				: name;
		if (!key) continue;
		const value = source[key];
		if (value !== undefined) environment[key] = value;
	}
	return environment;
}
