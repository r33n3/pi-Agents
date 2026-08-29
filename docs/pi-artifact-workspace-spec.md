# Pi artifact workspace specification

## Status

Implementation contract for durable deliverables produced by Pi sessions,
agents, routines, workflows, delegated connections, and browser recordings.

This specification depends on
[the durable work and attention specification](pi-durable-work-attention-spec.md)
and refines the `ArtifactStore` named in
[the agent workspace specification](pi-agent-workspace-spec.md).

## Goal

Make finished work easy to find, preview, refresh, revise, compare, download,
and trace without turning the interface into a file manager.

An artifact is a durable work product, not every file a tool happens to touch.
Examples include a report, website preview, document, spreadsheet, image,
browser workflow, exported data set, or structured agent result.

## Product principles

1. **Results are first-class.** A user does not need to search a transcript to
   reopen an important deliverable.
2. **Origin is always visible.** Every artifact links to its task, attempt,
   agent or Pi session, workspace, sources, model route, and creation time.
3. **Versions are append-only.** Updating an artifact creates a version; it
   does not erase the evidence of what an earlier run produced.
4. **Preview is safe.** HTML and other active formats do not inherit serve-host
   authority, vault access, or unrestricted network access.
5. **Refresh means a new run.** Connected data is refreshed through an
   authenticated task with grants and audit, never directly from untrusted
   artifact JavaScript.
6. **The UI stays quiet.** Artifacts open in the center workspace from existing
   conversations, Attention, search, or recent results. They do not require a
   permanent top-level tab.

## Reference pattern

Claude Cowork's live artifacts are persistent interactive outputs that can
refresh from connected data and retain version history. Pi adopts the durable
result and versioning concepts while keeping provider access in Pi's governed
server-side adapters. See
[Use live artifacts in Claude Cowork](https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork).

## Artifact model

```ts
type ArtifactKind =
  | "text"
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "dataset"
  | "browser_workflow"
  | "directory"
  | "other";

type ArtifactOwnership = "managed" | "workspace_reference";

interface ArtifactRecord {
  id: string;
  title: string;
  kind: ArtifactKind;
  ownership: ArtifactOwnership;
  taskId: string;
  attemptId: string;
  conversationId: string;
  agentId?: string;
  workspaceRoot: string;
  currentVersionId: string;
  versionIds: string[];
  tags: string[];
  refreshDefinition?: ArtifactRefreshDefinition;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

interface ArtifactVersion {
  id: string;
  artifactId: string;
  ordinal: number;
  createdByTaskId: string;
  createdByAttemptId: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  content: ArtifactContentRef;
  sourceRefs: ArtifactSourceRef[];
  safeSummary?: string;
  createdAt: string;
}
```

IDs are opaque and stable. Titles are user-facing metadata and cannot be used
as paths. Media type is detected and validated server-side rather than trusted
from a model or upload.

### Managed artifacts

Managed content is copied into `ArtifactStore`. It is immutable per version and
can be retained independently of a changing workspace file.

### Workspace references

A workspace reference points to a canonical path under an explicitly permitted
root. Registering it also records a content digest and, for supported file
sizes, a managed snapshot so the original result remains reviewable after the
workspace changes.

Directories are manifests of validated relative entries, not unrestricted
filesystem mounts. Symlinks and junctions are resolved before boundary checks.

## Artifact creation

An executor may propose an artifact by returning a path or structured result.
`ArtifactStore.register` performs:

1. task and attempt authorization;
2. path canonicalization and root validation;
3. file type, size, and content safety checks;
4. digest calculation;
5. managed copy or validated reference creation;
6. metadata and provenance persistence;
7. `artifact.created` or `artifact.version.created` event append; and
8. safe preview generation when supported.

The model cannot select an arbitrary server path or mark content trusted.
Registration failure does not convert the task to completed-with-artifact; it
produces an explicit partial-result error.

Multiple outputs from one task may be grouped as a collection while retaining
independent artifact identities. A collection is metadata, not a directory
with broader path authority.

## Versioning and revisions

An update creates a new artifact version when the user or task explicitly
identifies an existing artifact ID. Matching filenames alone never overwrite
an artifact.

Version history shows:

- ordinal and timestamp;
- originating run and agent;
- safe summary of changes;
- size and media type;
- source changes; and
- preview, download, compare, and restore actions where supported.

Restore creates another version whose contents equal the selected historical
version. It never rewrites history. Text, Markdown, HTML, and supported tabular
data receive semantic or line-based comparison. Other formats show metadata
and rendered previews when available.

## Refreshable artifacts

A refreshable artifact stores a task template, not credentials or executable
browser code:

```ts
interface ArtifactRefreshDefinition {
  agentId: string;
  agentRevision?: number;
  promptTemplate: string;
  capabilityGrantIds: string[];
  providerAccountRefs: string[];
  workspaceRoot: string;
  permissionMode: "manual" | "safe_auto" | "unrestricted";
}
```

Selecting `Refresh` shows a compact contract review when grants, accounts,
workspace, model route, or permission policy changed. The server submits a new
task. Successful output creates a version; failure leaves the current version
unchanged and creates an Attention item.

Artifact preview code never receives provider tokens. Connected data flows
through registered Pi capabilities and the credential vault.

Routine-generated artifacts may append versions to a stable daily report,
create one artifact per run, or do both through an explicit output policy.
The policy is shown in the routine contract.

## Provenance

Every version records enough evidence to answer:

- Which task and attempt created this?
- Which Pi session, agent, routine, workflow, or delegated connection requested
  it?
- Which agent revision, model, provider, and billing route were used?
- Which capability grants and provider account references were used?
- Which source URLs, provider item IDs, input artifacts, and workspace files
  contributed?
- Was any source unavailable, stale, partial, or conflicting?

Secrets, raw authorization headers, hidden provider payloads, and complete
private transcripts are excluded. Source references use safe labels and stable
provider identifiers where available.

The default UI shows title, last updated time, producing identity, and a compact
source summary. Full provenance is collapsed under `Details`.

## Interface

### Opening artifacts

Artifacts open in the center workspace through:

- a result link in a Pi or agent conversation;
- an Attention completion item;
- an agent's recent output list;
- a routine run;
- global search or command palette; or
- a compact `View artifacts` action from Attention.

There is no permanent right-workspace Artifact tab. The selected artifact uses
the existing center tab strip and returns to the originating conversation with
one back action. Opening an already visible artifact focuses its tab rather
than duplicating it.

### Artifact header

The compact header contains:

- title and type icon;
- origin link;
- last-updated state;
- version selector;
- refresh when configured;
- preview or open-in-browser;
- download; and
- a three-dot menu for compare, rename, archive, reveal in workspace, and
  delete.

Labels appear in tooltips unless an action needs confirmation. The header does
not repeat the full workspace path, model route, or source list.

### Artifact library

`View artifacts` opens a center overlay with search and compact filters for
type, agent, project, routine, and updated time. Default results are recent and
unarchived. Cards show only thumbnail or icon, title, origin, and last update.

The library is not always visible in the left or right panel. A maximum of three
recent artifact links may appear under a completed task or agent summary.

### Mobile and narrow panes

- The artifact occupies the center viewport; side panels become drawers.
- Header actions collapse into icons and a three-dot menu.
- Search opens only after the user taps the filter field; opening the artifact
  library does not automatically raise the keyboard.
- Preview, version selection, and primary download remain reachable above the
  mobile browser's bottom controls.
- Large tables and canvases scroll inside the preview without causing page-level
  horizontal overflow.
- An unfolded Pixel Fold uses the compact layout whenever the available center
  pane is below the defined content breakpoint.

## Preview behavior

### Passive formats

Text, Markdown, images, and supported tabular data render through Pi-owned
components. PDF, document, spreadsheet, and presentation formats use generated
previews when available and retain direct download.

### HTML and interactive artifacts

HTML previews run in a sandboxed origin or iframe with:

- no same-origin access to `pi --serve`;
- no serve capability token in URL, storage, cookies, referrer, or DOM;
- scripts disabled by default;
- forms and top navigation blocked by default;
- a restrictive Content Security Policy;
- network access denied unless a reviewed artifact policy permits specific
  destinations; and
- explicit user action before opening externally.

Interactive mode is a separately declared preview profile. Even then, provider
and vault access occurs only through authenticated, grant-checked server
operations associated with a refresh task.

Browser workflow artifacts render as a step list, entry-state contract, target
origins, screenshots with secret regions redacted, and replay controls. Replay
creates a task and browser lease; it does not execute directly from preview
JavaScript.

## Deletion and retention

Archive hides an artifact from default results without deleting versions.
Delete requires confirmation and is refused while an active task, routine, or
published result depends on the artifact.

Deletion removes managed versions and previews after the configured recovery
window. It never deletes a referenced workspace file unless the user performs a
separate, explicit filesystem action. Permanent deletion creates a durable
audit event.

Automatic retention may remove unreferenced generated previews and temporary
exports. It does not remove current versions, open Attention results, pinned
artifacts, or audit/provenance records.

## Storage

```text
~/.pi/agent/serve/
  artifacts/<artifact-id>/artifact.json
  artifacts/<artifact-id>/versions/<version-id>/version.json
  artifacts/<artifact-id>/versions/<version-id>/content
  artifacts/<artifact-id>/versions/<version-id>/preview/
  artifacts/index.json
```

Metadata replacement is atomic. Content is written to a temporary owned path,
validated, hashed, and renamed before the version becomes visible. The index is
rebuildable from artifact metadata.

Deduplicating identical content by digest is optional. If implemented, garbage
collection must be reference-counted and crash-safe; correctness must not
depend on deduplication.

## Authenticated API

The browser-facing resource surface provides these semantics:

```text
GET  /api/artifacts
GET  /api/artifacts/:artifactId
GET  /api/artifacts/:artifactId/versions/:versionId/content
GET  /api/artifacts/:artifactId/versions/:versionId/preview
POST /api/artifacts/:artifactId/refresh
POST /api/artifacts/:artifactId/restore
POST /api/artifacts/:artifactId/archive
DELETE /api/artifacts/:artifactId
```

Routes may follow established repository naming. Content responses set an
explicit media type, `X-Content-Type-Options: nosniff`, safe disposition, cache
policy, and frame policy. Range requests are bounded. Downloads never accept a
client-provided filesystem path.

## Migration

1. Enumerate artifact references already attached to tasks and attempts.
2. Canonicalize and validate each path against the recorded workspace or
   task-owned artifact root.
3. Register supported content with original task and attempt provenance.
4. Preserve legacy path references only when content cannot be safely copied;
   mark missing or unsafe content explicitly.
5. Build the artifact index and append migration events without changing task
   completion timestamps.
6. Keep legacy directories read-only until counts, digests, and open/download
   parity are verified.

Migration is idempotent and must not follow untrusted links or copy secrets
from environment, vault, browser profile, or credential directories.

## Implementation slices

### Slice A1: authoritative artifact store

- Add versioned artifact and version records.
- Add validated managed-copy and workspace-reference registration.
- Add digest, media detection, size limits, atomic writes, and index rebuild.

### Slice A2: task and Attention integration

- Append artifact events through `AgentTaskService`.
- Link task results and completion Attention items.
- Add artifact IDs to routine, workflow, ACP, A2A, and browser outputs.

### Slice A3: safe preview service

- Implement passive preview generation.
- Add isolated HTML preview with restrictive defaults.
- Add safe download headers, range limits, and authorization tests.

### Slice A4: center workspace and library

- Add the compact artifact header and origin navigation.
- Add center-overlay search, filters, recent results, and no-duplicate focus.
- Keep provenance and source details collapsed.

### Slice A5: versions and refresh

- Add explicit update, compare, restore, and history.
- Submit refresh through the durable task path and contract review.
- Preserve current versions on failed refresh.

### Slice A6: specialized deliverables

- Add browser workflow presentation and task-based replay.
- Add document, spreadsheet, presentation, and PDF rendered previews where
  supported by the installed workspace runtime.
- Add directory collection manifests without broad filesystem exposure.

### Slice A7: migration and validation

- Migrate existing task artifact references idempotently.
- Validate restart recovery, missing files, changed workspace files, and
  retention.
- Run focused tests and `npm run check`.
- Validate desktop, resized pane, phone, and unfolded Pixel Fold behavior in a
  live `pi --serve` session.

## Acceptance criteria

- A completed run can expose an artifact without embedding its body in chat.
- Opening an artifact from chat, Attention, or an agent focuses one center tab.
- Every version links to immutable task and attempt provenance.
- Updating and restoring append versions without rewriting history.
- A refresh executes as a governed task and never exposes provider credentials
  to artifact code.
- HTML preview cannot access the serve token, vault, parent DOM, unrestricted
  network, or top-level navigation.
- Workspace references cannot escape their permitted root through traversal,
  symlink, junction, alternate data stream, or encoded path input.
- Downloads have safe content headers and require serve authentication.
- Restart preserves metadata, versions, previews, task links, and Attention
  state.
- A failed refresh leaves the current artifact version unchanged and creates
  one actionable Attention item.
- Artifact library and preview remain usable on desktop, mobile, and unfolded
  Pixel Fold layouts without adding a permanent top-level workspace.

## Non-goals

- Replacing the operating-system file browser.
- Making every generated file an artifact.
- Running arbitrary artifact JavaScript with Pi credentials.
- Public anonymous artifact hosting.
- Real-time collaborative editing in the first implementation.
- A cloud artifact synchronization service or organization-wide sharing model.

