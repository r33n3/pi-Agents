# Product backlog

## Portable user profiles and VDI recovery

Status: deferred at the user's request. Prioritize reliable individual-agent and team outcomes before implementation.

### Scenario

A user loses an installed environment when a VDI is replaced or reset. After installing Pi on another machine, they restore their profile and resume work with minimal setup.

### Proposed scope

- Versioned, user-selected export and restore of preferences, agent/team definitions, skills, tool assignments, and configuration.
- Optional migration of private memory, conversations, and workspace content; keep user-owned data distinct from shared workspace data.
- Portable encrypted credential backup protected by a user-held passphrase or recovery key. Copying the current Windows-bound vault is not sufficient for another machine.
- Reuse a user's configured connections across authorized workspaces, while preserving explicit agent/team tool grants.
- Reconcile machine-specific paths and detect missing tools. Offer installation/configuration where supported and authorized.
- Guide users through expired authorizations or services that require a fresh sign-in.
- Report what was restored, what was skipped, and what still requires attention. Do not claim seamless transfer of browser sessions or every authorization.

### Acceptance criteria

Restore a representative profile on a clean, separate environment; verify selected configuration and data, credential protection, scoped tool grants, missing-dependency guidance, and successful single-agent and team runs. Verify that unselected workspace data is not migrated and existing destination data is not silently overwritten.

Authentication, permissions, recovery-key handling, backup location, and conflict resolution require design before implementation. This backlog entry does not implement profile portability, multi-user isolation, or automatic software restoration.
