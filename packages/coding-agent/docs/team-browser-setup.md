# Team browser setup

## Goal and design

Reuse the environment's browser configuration from selected team members. A report should open beside the conversation, and an agent should be able to browse with a saved profile without copying login state into its card.

Browser setup stores named profile definitions and independent site preferences in the selected shared settings profile. Team tool IDs reference those entries. Each run captures its assigned browser access, engine and profile in its execution configuration. Cookies and site storage stay in the existing dedicated profile directory.

The alternative of starting a separate browser manager in each team worker hides sessions from the side panel and cannot coordinate profile ownership. Serve-hosted workers now call browser tools through the existing host tool channel. Standalone workers retain their existing browser runtime.

## User flow

In the Browser side panel, expand **Browser and site setup**. Save a named profile with its engine and network access. Site preferences can independently select browser, Markdown, llms.txt documentation or an existing connection tool. These are interface preferences; they do not create API integrations or grant connection access.

Select the resulting entries in a team's tool configuration, or ask its supervisor to assign them to named members. The same proposal/review flow used for other team tools persists those assignments. **Configure browser profiles and sites** is an optional tool for an agent explicitly entrusted to save setup through chat. Saving setup and assigning it are separate operations.

**Present report in side browser** gives only `browser_present`: a workspace-confined preview using an unsigned-in context. The report stays visible after the worker finishes. A presentation notification opens the Browser panel without replacing the team conversation.

**Browser: profile name** gives navigation, page text and controls, screenshots, and close. Only one browser profile can be assigned to a member. Multiple members may reference the same profile; an active profile lease prevents concurrent use. Close the browser before handing it to another member. Run completion also releases its sessions. Login expiry still requires user sign-in.

An exact active **Workflow** may also be selected. Its existing runner performs validation and side-effect approval checks. Profile access and workflow requirements still apply. Merely presenting a report never executes a recorded workflow.

## Limits and validation

Site Markdown and llms.txt reads are bounded, credential-free public reads with timestamps and source URLs. Their contents remain untrusted reference material. Site configuration does not imply a flight service actually provides Markdown, an API, fares or current availability.

Named profiles retain browser-managed cookies and storage, engine selection and network access. Custom browser extensions, proxies, locale overrides and per-site permission restrictions are not configured by this change.

Targeted tests exercise setup restart persistence, member-specific assignment, conflicting profile rejection, site isolation, actual HTML presentation, and actual cookie retention across sequential browser sessions. Existing browser lifecycle and tool tests cover control ownership and stale element references. These tests use local fixtures and no paid inference.

Live validation also exercised supervisor-approved member assignments, reading Google Flights with a saved profile, and presenting an existing report beside the team chat. The first combined run reached its accumulated token limit after both members succeeded. A fresh supervisor-to-reporter-to-supervisor run completed after a server restart, confirming assignment persistence and report presentation. This verifies browser setup, not current fare accuracy or authenticated flight workflows.

After tool approval, the next supervisor prompt includes the host's saved-assignment receipt and current browser policy. Earlier missing-tool results must not be treated as evidence that the new assignment failed. Regression tests cover this receipt through approval and service restart.
