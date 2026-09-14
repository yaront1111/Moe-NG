# Review workflow visibility and task scope

## Problem and intended behavior

An exhausted coding review can offer another attempt without showing the reported
issues. A previous successful approval can also remain attached to the same node
when a newer review requires its own decision. Coding briefs describe assigned
criteria but omit their neighboring owners and dependency edges, making it harder
to distinguish task acceptance from a later phase check.

This change makes the evidence for a review decision visible, binds local decision
results to the offered review version, and gives compiled coding tasks an advisory
map from their own sealed plan. It does not resolve product questions or change an
approved assignment.

## Implementation

1. In `apps/control-room/src/v2/approvals/needs-you-escalation.ts`, join an escalation
   offer to its exact node and review version. Carry the existing bounded findings
   summary only when that join is current. Missing, stale, and unreadable summaries
   remain explicit states.
2. In `needs-you-escalation-findings.tsx` and `needs-you.tsx`, render the reported
   severity, rule, subject, and detail before the decision controls. Treat all
   finding content as text. Disable review decisions while their summary cannot
   be matched to the offer. Separate result slots by offered review version so a
   late response cannot mark a newer review allowed.
3. In `apps/daemon/src/orchestrator/compiled-plan-context.ts`, derive a frozen map
   from one admitted sealed graph. Include its goal, planning run, graph hash,
   assigned node key, criterion owners, and dependency directions. Validate the
   graph and joins; missing, ambiguous, or oversized context returns `UNKNOWN`
   with no partial map. Limit the complete serialized context to 16,000 bytes.
4. In `compiled-node-source.ts`, add that map to the existing coding brief without
   changing assigned criteria, test commands, or approved-source reads. Keep a
   physical `compiled-plan-context.js` bridge for packaged Node entrypoints.
5. In `agent-mission-text.ts`, explain that broader validation belongs after its
   contributors. A contradictory assignment requires exact findings and reviewed
   replanning. Every assigned criterion and required check remains mandatory.

## Verification

- Model and render regressions in `needs-you-escalation.test.tsx` cover current,
  stale, missing, and unreadable findings, safe text rendering, disabled controls,
  and separate decision versions.
- `live-needs-you.test.tsx` covers a deferred old response arriving after polling
  exposes a newer review. Update direct fixtures and the exact consumer inventory
  in `goals-home.test.tsx` for the added test consumer.
- `compiled-node-context.test.ts` exercises a durable approved plan, exact graph
  identity, reused keys in other goals and runs, ambiguous and missing joins,
  bounded output, frozen results, and unchanged event horizon and assigned tests.
- `apps/daemon/src/projects/project-compiled-node-mission.test.ts` preserves exact
  environment and configured-command expectations while checking the complete
  sealed context added to the assembled project mission.
- Mission regressions retain required checks and approved document reads. Load
  the physical helper bridge with the normal Node runtime.
- Run all required repository gates and the full Control Room suite. Build from
  the committed source and smoke-test the resulting Windows package separately
  from any running user project.

## Remaining workflow work

Coding-stage product questions still need a durable question and answer lifecycle.
An answer should bind to the project, approved contract and graph, node, question,
and current review. It must enter subsequent worker context without silently
granting another attempt or changing acceptance criteria. Scope changes require
reviewed replanning; an approval to retry is not an answer to a product question.

Repeated full contract and design reads can also be reduced with a complete,
source-pinned context projection. Design filtering needs structured bindings;
keyword guesses cannot establish that global constraints were retained.
