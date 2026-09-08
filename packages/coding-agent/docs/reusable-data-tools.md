# Reusable data tools

An agent should learn a source once, then reuse tested extraction code without asking a model to parse the same page on every run. Workspace data tools implement this using declarative recipes over existing Pi readers. They do not load generated JavaScript.

## User flow

1. Assign **Create reusable data tools** and the needed reader to the agent or team member. Configure provider credentials once in Settings → Connections.
2. Ask the agent to read the source, identify stable fields and register a reusable reader. `data_tools` lists existing recipes before creating another.
3. Registration calls the assigned reader and validates the sample. Only a successful extraction enters the workspace catalog.
4. Assign the returned saved tool and its source reader to each intended agent through team tools or the existing chat tool-allocation flow. Registration never assigns either grant.
5. Use `configure` to derive a separately named configuration with different defaults. It reuses the saved extraction and validates the new source. Later versions never change existing assignments.

Example request: “Use our configured Firecrawl connection to inspect this exact public page. If it contains the requested data, save a reusable reader that returns the price and source. Then propose assigning it to the flight researcher.” A blocked source cannot produce a validated reader.

## Contract

`data_tools` supports `list`, `register`, `configure`, and `run`. Registration supplies `recipe` and optional sample `values`. Configuration supplies an existing `tool`, `configuration: {id, name, defaults}` and optional sample `values`. Defaults merge over the original configuration. Sample values are not persisted.

Recipes specify an id, name, description, source reader, non-secret defaults, overridable input names, a JSON `recordsPointer`, fields and minimum/maximum record counts. A field has a name, JSON pointer and scalar type. Optional literal prefix/suffix markers extract one unambiguous value from text. JSON pointers follow RFC 6901; empty means the current root.

For `page_read`, a simple text field uses pointer `/text`. For Firecrawl, inspect the actual returned JSON first; Markdown is typically at `/data/markdown`. No generated regular expressions or executable scripts run in this layer.

Supported readers: `page_read`, `firecrawl_scrape`, `feed_read`, `flight_search`, `flight_status`. Readers retain their existing credentials, URL restrictions, quotas and request behavior. Browser interaction remains in the existing browser workflow system.

Runtime tools are named `saved_data_<id>_v<version>` and accept `{values: {...}}`. Every call invokes the source and revalidates the result. The source may return cached data; retained source timestamps distinguish evidence age from execution time. Missing fields, incorrect types, ambiguous markers, unexpected row counts and explicitly truncated sources fail. Schema validation does not verify factual correctness.

State lives in `<agentDir>/serve/data-tools/registry.json`. Writes are serialized and atomic. Source response bodies and sample inputs are not saved. Credentials belong in existing connections, never recipe defaults. Registry access is workspace-scoped; it is not a multi-user secret store.

## Validation and limits

Automated tests cover persistence, immutable versions, configuration reuse, scoped execution, team catalog discovery, source revocation, malformed and changing data, and a faux-model chat through ServeHost that registers and executes a reader. No paid inference or flight API calls are required.

This provides deterministic extraction after a successful sample, not automatic repair of changing websites. Complex pagination, arbitrary browser recipes, scheduling extraction-specific health checks, and semantic price verification are outside this first implementation. Models still choose appropriate sources and interpret the structured results.
