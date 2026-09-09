# Catalog publication

Agent/member cards and the team conversation use **Publish to catalog**. The destination is separate from that label. The current flow prepares and downloads a `pi.catalog-package.v1` review artifact; remote publication is unavailable until an admission adapter is implemented.

The review uses saved definitions, not unsaved form edits. Package versions are explicit. Downloading retains the reviewed snapshot; editing the live agent never republishes it.

The package includes purpose, member instructions, roles, tool requirements, permissions, memory strategy, and team bounds. Account bindings, credentials, workspace paths, conversation history, learned memory, shared notes, schedules, and sending approvals are excluded. Free-text names/instructions and memory-policy wording still need human review for personal details. Download is a review artifact, not a deployment bundle.

## Destination integration

WTK's existing source-transfer API updates an already constructed package and requires its current source digest. It cannot admit a new native Pi package. Its catalog publication endpoint requires qualification and approval evidence. Therefore Pi does not call either endpoint with this incompatible artifact or manufacture passing evidence.

The next integration must admit a native Pi package into WTK's construction process, retain source and version identity, resolve tool and child-team dependencies, qualify the supported execution behavior, and return a catalog receipt for the exact reviewed digest. Dynamic recruitment must be explicitly supported or reported as unsupported. Keep this in a destination adapter, not in card rendering. Another catalog can implement the same review/admission/receipt boundary without changing the user-facing label.

An export-only implementation was chosen over submitting the manifest through goal intake: goal intake would reinterpret saved behavior with a model and could silently change tools, member selection, and memory semantics. No external publication or deployment has been proven by exporting.
