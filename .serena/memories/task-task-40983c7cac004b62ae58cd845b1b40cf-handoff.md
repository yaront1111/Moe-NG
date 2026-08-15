# task-40983c7c — foundation fault-ratchet probe patterns repaired

Commit `f9875bd`, branch `moe/work-2026-08-08`. Two files, both under
`packages/testkit/src/foundation/`. `pnpm test:fault` 2 failed | 41 passed -> 43 passed.

## What changed
Three bare-noun patterns in `foundation-incident-schedules.ts` narrowed to
capability-specific alternations, each with a comment naming the collision:

| probe | was | now (abridged) |
|---|---|---|
| contracts-distribution-handshake | `Distribution\|DISTRIBUTION` | `(?:[Vv]erify\|[Cc]heck)(?:Distribution\|_distribution)\|...\|[Dd]istribution(?:Handshake\|Compat)\|...` |
| scheduler-hot-claim-admission | `Claim\|CLAIM` | `(?:[Aa]dmit\|[Rr]educe)(?:Claim\|_claim)\|...\|[Cc]laim(?:Work\|Admission)\|...` |
| core-release-handoff | `Handoff\|HANDOFF` | `[Rr]elease(?:With)?Handoff\|[Ww]orkHandoff\|[Hh]andoffTransition\|...` |

Untouched (measured 0/0): `core-terminal-release` (the exemplar),
`scheduler-timer-reentrancy`, `core-review-assignment`. No row flipped to
PASS_EXPECTED; no production symbol renamed.

New file `foundation-incident-probe-precision.test.ts` (198 lines) enforces the
invariant in BOTH directions — see `mem:gotcha-absence-probe-narrowing-fails-silently`.

## The measurement correction QA should carry
The task description's collision counts (17/2/1) were text-grepped and are wrong.
Runtime truth: 6/1/0. See `mem:gotcha-export-probe-must-be-measured-at-runtime`.
Consequence: `probe:core-release-handoff` was never about to flip —
`ExpansionHandoffBinding` is a TYPE. Narrowed anyway as fragility repair, and the
inline comment says exactly that. Do not let a later reader "re-confirm" the
1-match figure and conclude the measurement drifted.

## Still open — the next instance of this defect
`CATALOGUE_PROBES` in `foundation-fault-schedule.ts` are the same bare-noun shape:
`Attempt|ATTEMPT` (@moe/core), `Dispatch|DISPATCH` (@moe/core),
`[Aa]cknowledg|ACKNOWLEDG` (@moe/store). All measure 0 runtime / 0 type-only as of
2026-08-11, so nothing is red — but a task landing attempt-execution, dispatch or
outbox-acknowledgement vocabulary hits the same no-owned-path trap that cost
task-2411ed9c an escalation. My invariant test is scoped to
`FOUNDATION_INCIDENT_PROBES` per DoD 6; widening it to `FOUNDATION_ABSENCE_PROBES`
would close the class. Raised in #general; no task filed.

## Constraints on any future edit to these patterns
`foundation-spec.test.ts` already pins two things, both in the testkit gate:
- :171-183 every non-null pattern must match at least one of its OWN
  `absentExportNames` (then asserts `${name}FromAnotherAuthor` fires).
- :185-191 no probe may fire on `["historicalRuntimeResult", "PlanningReleased",
  "GraphPreviewResult"]` — case sensitivity is load-bearing.

## Authorisation
No governor registered (`list_workers`, 6 workers, none). Edited the mandatory
design-18.3 ratchet on this CRITICAL task's own authority per its plan.
