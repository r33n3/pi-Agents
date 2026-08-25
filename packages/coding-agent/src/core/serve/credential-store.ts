/** A write request that atomically replaces values and revokes named entries. */
export interface CredentialReplaceRequest {
	values?: Readonly<Record<string, string>>;
	revoke?: readonly string[];
}

/** Safe credential state. This type must never contain plaintext credential values. */
export interface CredentialMetadata {
	reference: string;
	providerId: string;
	storage: string;
	configured: boolean;
	entries: Array<{
		name: string;
		configured: boolean;
	}>;
}

/**
 * Keeps credential persistence behind one replaceable boundary.
 *
 * `resolveTrusted` is for provider adapters only. Browser handlers, agent
 * definitions, prompts, transcripts, and audit events must use `metadata`.
 */
export interface CredentialStore {
	/** Creates previously absent entries and refuses accidental overwrite. */
	store(providerId: string, values: Readonly<Record<string, string>>): Promise<CredentialMetadata>;

	/** Atomically overwrites and/or revokes explicitly named entries. */
	replace(providerId: string, request: CredentialReplaceRequest): Promise<CredentialMetadata>;

	/** Resolves only the requested entries inside a trusted provider adapter. */
	resolveTrusted(providerId: string, names: readonly string[]): Promise<Readonly<Record<string, string>>>;

	/** Revokes selected entries, or every provider entry when names are omitted. */
	revoke(providerId: string, names?: readonly string[]): Promise<CredentialMetadata>;

	/** Reports configuration state without returning plaintext. */
	metadata(providerId: string): Promise<CredentialMetadata>;
}
