---
name: spec-build
description: Create a durable delivery specification and bounded agent work packages for large research, planning, implementation, or explicitly multi-agent requests. Use before coordinating two or more agents; do not use for ordinary work Pi can complete directly or for one bounded delegation.
---

# Spec build

Keep Pi as the user-facing supervisor. Use this skill only when the work needs a durable specification or more than one delegated agent.

## Route the request

- Complete ordinary questions, inspections, and small changes directly in Pi.
- Delegate one bounded goal directly to the best single agent.
- For an explicit agent team, multiple agents, dependent workstreams, or a large delivery, create the specification and delegate it once to `pi-coordinator`.
- Do not expose internal agent chatter in the main conversation. Report compact progress and let the user open an inspector when desired.

## Create the specification

Write `.pi/specs/<short-name>.md` inside the current project. Do not overwrite an unrelated specification. Include:

1. outcome and non-goals;
2. observed context and assumptions;
3. security, path, compatibility, and operational constraints;
4. acceptance criteria and required validation;
5. shared interfaces or decisions every work package must preserve;
6. work packages with stable ids, objective, inputs, dependencies, allowed files or systems, expected evidence, and suitable agent capabilities;
7. integration and final-review steps.

Work packages that can modify the same files or external state must be dependent, not parallel. Make missing authority or user decisions explicit instead of letting an agent infer them.

## Delegate the specification

Invoke `pi-coordinator` as one subagent and provide the absolute specification path, project directory, and requested final deliverable. The coordinator owns execution order, capacity limits, retries, and synthesis. Pi remains responsible for validating the returned evidence and communicating the result.

If `pi-coordinator` or the subagent tool is unavailable, keep the specification and explain that coordination could not start. Do not silently replace the governed workflow with uncontrolled parallel calls.

## Completion

Do not claim completion from a launch acknowledgement. Require terminal child states, acceptance-criterion evidence, unresolved issues, and artifact paths. Update the specification with the final outcome after the coordinator returns.
