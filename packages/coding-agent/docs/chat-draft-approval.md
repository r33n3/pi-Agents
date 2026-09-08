# Chat-backed draft preparation

## Problem and scope

A user asked a team to attach an approved report to an email draft. The worker invented a receipt ID and recipient, then substituted a local preview for the requested Gmail draft. The supervisor subsequently asked the user to supply internal receipt state.

The shared Gmail adapter now resolves draft authorization from host-selected user messages. This applies to direct chats and members of directly requested teams with the corresponding capability. It does not grant sending, delegated child-team authority, or unattended scheduling permission.

## Implementation

The host selects user-authored messages from the current request, excluding old conversation history and delegated agent prompts. Conservative English draft-intent recognition returns the message and conversation IDs plus a text digest. Ambiguous requests fail closed. This is limited intent recognition, not general natural-language authorization.

The existing approval store binds that evidence to the exact action, account, recipients, body and attachment digest. A repeated identical operation from the same owner replays the provider result; changed content cannot reuse the receipt. The model does not supply evidence or manufacture receipts. Sending continues to require its separate exact-action approval.

Drafts may have no recipients. With assigned read access, reportPath reads a confined HTML file and uses the same bytes for the embedded body and attachment. The adapter never sends it. Authentication is checked before issuing a new chat-backed receipt. Uncertain write failures are not automatically retried.

The worker guidance distinguishes a local preview from a real draft, and team submission rejects questions asking users for receipt IDs. Provider draft IDs are returned only after a successful Gmail response. The review URL opens Gmail Drafts; users must select the connected account when signed into multiple accounts.

## Validation and limits

Tests cover message evidence, refusals, exact attachments, blank recipients, replay, content changes, persistence, missing authorization, separate send approval, authentication failure and correction of invalid receipt questions. Live Flight Finder validation successfully bound the original user approval and invoked Gmail, but Google token refresh returned HTTP 400. No real Gmail draft was created in that run; reconnecting the account is required for end-to-end verification.

Recurring-send policies and chat-based approval of a prepared send action remain future work. Do not infer either permission from a draft request.
