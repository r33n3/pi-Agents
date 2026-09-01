# Pi Agents documentation screenshots

These images show the actual local Pi Agents web interface with synthetic demo
data. They are documentation assets, not screenshots of a user's live workspace.

| Image | View |
| --- | --- |
| [workspace.jpg](workspace.jpg) | Two demo sessions, an illustrative release-review conversation, three example agents, and pending proof-review items. |
| [agent-builder.jpg](agent-builder.jpg) | A saved, unpublished Documentation reviewer draft with its Profile settings open. |

Captured on 2026-08-31 from the local development checkout, including work in
progress. These images are not tied to a published release. Both are unedited
1280 × 720 JPEG browser captures; no browser chrome or access URL is included.

The demo used the production `createServePage` interface and browser bundle,
`TestServerService` for session data, and a separate temporary agent registry and
build lifecycle. Optional service listings used synthetic empty responses.
“Demo model” and the conversation were fixture data. Agent execution was disabled;
no model requests, external actions, personal credentials, or live agent stores
were used. The draft was not published and no schedule was enabled.

## Refreshing the images

1. Start an isolated local demo with synthetic sessions and a separate data directory.
2. Use the real UI to select the workspace or Agent Builder view. Do not substitute a mockup or alter the rendered page to imply successful work.
3. Capture the browser viewport under ignored `output/` first.
4. Inspect each image for personal names, host paths, conversations, credentials, access URLs, and account details. Inspect embedded metadata as well.
5. Copy only reviewed images here, link them from the root README, and update these capture notes. Keep raw evidence and temporary scripts out of public source.

The checked images contain only synthetic names, `/workspace/demo-*` example
paths, and JPEG encoding metadata. See the
[user-data privacy guide](../pi-user-data-privacy.md) for the repository policy.
