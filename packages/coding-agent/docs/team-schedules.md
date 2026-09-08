# Team schedules

Open a team conversation and select **Schedule** in the fixed conversation header. **Back to chat** restores your conversation position and unsent message. Complete and review a successful team run first. The editor uses the last successful request as a starting point; replace it with the work that should happen every time.

Choose the cadence, time, and time zone. Delivery defaults to **Gmail drafts for review**; **Local report only** is also available. Specify intended recipients in the request. Draft authorization never authorizes sending.

Repeat options include Daily, Weekdays, Weekly, Monthly, and Yearly. Monthly schedules skip months without the selected date; choose days 1–28 for every month. Yearly schedules choose a month and date, with February limited to 28 days. The time zone defaults to the browser device's zone and is saved with the schedule. The Pi server uses its system clock and that saved zone, including daylight-saving changes; opening the schedule on another device does not change it. The preview shows the next runs in the saved zone.

Review the team's current tools and memory, then check the authorization box. **Save paused** stores a schedule without enabling automatic runs. **Run once** tests the saved request. **Enable schedule** starts recurring execution, and **Pause** disables it. The server must remain running. Results remain in the team conversation and History.

The existing routine registry and scheduler own these runs. They dispatch through the normal team supervisor, selected specialists, and selected child teams. Each run retains its schedule ID, revision, and delivery mode. The scheduler prevents overlap; stopping the team cancels its current work and child assignments.

The reviewed configuration includes team definitions and member execution settings throughout the selected hierarchy. Changes require another review before execution. Tool availability is rechecked at dispatch and each round. Removing or editing the schedule invalidates the active run's draft authorization. Unattended runs cannot recruit or change tool allocations.

Draft receipts identify the host-owned schedule authorization and remain bound to the exact Gmail action. Gmail sending and other capabilities requiring interactive approval are rejected for these schedules. Host commands, browser configuration, delegated agents, and recorded browser workflows require separate automation review and are not supported by this first team scheduling flow. Public research tools and existing permitted browser profiles remain available.

Verification covers specialist execution, persistence, overlap rejection, cancellation, configuration invalidation, draft receipt issuance and revocation, and denial of sending with draft evidence. Browser tests cover the stop control across phone and folded-screen sizes, retained composer input, draft defaults, explicit enable confirmation, and pause behavior.
