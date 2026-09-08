# Flight fare research

In Settings > Connections, configure and enable **SerpApi Google Flights** using your API key from https://serpapi.com/manage-api-key. The existing encrypted vault stores the key. Do not put it in an agent card or chat.

Assign **Research flight fares** to an individual agent or team member. The supervisor can discover `serpapi-flights:flights.search` and propose it through the existing team tool flow. New team builders see `flights.search` in the read-capability catalog. Configuration and assignment are separate: agents do not automatically receive all configured connections.

Example request: “Research JFK to LAX for my specified travel dates and passenger count. Compare complete round trips and explain baggage and fare restrictions.”

The `flight_search` tool supports one-way and round-trip airport searches, passenger counts, cabin, airline and stop filters, and excluding basic economy. Supply an outbound result's `departureToken` with the same trip parameters to retrieve return choices. It does not book tickets. Observed fares and aircraft models are not live flight status or confirmed tail numbers; verify airline fare conditions and price basis before claiming a match.

Each connection key has a conservative local cap of 250 attempted searches in a rolling 31-day window, shared across agents in the settings directory. Reservations persist across server restarts, and failed requests count. Identical requests reuse a ten-minute in-memory cache. This local cap is distinct from SerpApi's billing period and does not track use by other applications or machines. Provider quotas still apply. Usage records contain only timestamps and a hashed key identifier.

Tests use simulated responses; a real account key and live query are needed to validate actual route coverage.

## Flight status and arrivals

Configure **Aviationstack** in Settings > Connections using `AVIATIONSTACK_API_KEY`, review and enable it, then assign **Flight status and arrivals** (`aviationstack:flights.status`). Enter credentials from the host's localhost interface or authenticated HTTPS; plain LAN HTTP intentionally disables credential editing.

The `flight_status` tool accepts an IATA flight number (for example `AA123`) or a departure/arrival airport. It returns current provider records, including reported dates, times, flight identifiers and aircraft details when available. Pagination is explicit: each additional page is another request. It does not perform future schedule searches or guarantee aircraft registration availability. Missing fields remain unknown. The free API advertises 100 requests per month: https://aviationstack.com/pricing/.

The local cap is 100 attempts per rolling 31 days per key/settings directory, persisted across restarts. Identical lookups cache for two minutes. Failed attempts count conservatively. This is suited to occasional lookups, not continuous tracking. HTTPS is required; if the provider rejects a feature or quota, the agent receives setup guidance rather than fabricated status or an insecure HTTP retry.

## General search resilience

All agents using one host's SearXNG tool share a bounded queue: at most 20 pending calls, one active request, at least five seconds between request starts. Identical requests share cached results for five minutes. Cache and queue state reset on host restart. A request has a 20-second fetch timeout and a streamed 2 MB response limit. Partial results retain upstream failures; zero results with engine failures produce an actionable error and a 60-second service cooldown. This does not clear upstream blocks. SearXNG's own per-engine suspension remains authoritative.

Use dedicated flight tools first. An assigned browser can be an alternative; no browser authority is granted automatically, and fallback execution still depends on the agent selecting its available tool. Firecrawl can read known source URLs even if search is unavailable.

Operators can tune their SearXNG Docker configuration to disable HTTP retries and increase suspension periods for CAPTCHA, access-denied, and rate-limited engines. Pi's pacing reduces requests but does not guarantee upstream availability.

## Other tracking sources

- OpenSky provides aircraft positions and identifiers, but its current terms require a written license for operational API integrations: https://opensky-network.org/about/terms-of-use. Do not assume unrestricted free production use.
