# Graph revision supersession transition — worker handoff (DONE)

Implemented by worker-901cc711, 2026-08-09. Base ref `8946b02d0708bfc86e8e067ff8ed34a93bddbc43`.
QA reviews by base-ref diff: `git diff 8946b02..HEAD -- <the 11 paths>` (+426/-38).
My commits: `a3335ed`, `0ff900a`. The other 8 owned files reached HEAD inside FOREIGN whole-tree
commit `5172b3e` (task-4d226307 "Workspace manifest hygiene"), which swept them mid-task.

## What shipped
`graph.supersede` is now the only authority-moving transition out of `ACTIVE`.
`GraphRevisionState.graphEpoch` is required and durable (in `STATE_KEYS`, so `exact()` rejects a
state missing it). `supersede()` in the reducer is ~12 lines and adds NO policy: it hands
`decideSupersession` the LIVE binding and re-shapes the refusal layer. Predecessor keeps the epoch
it was activated at; the `+1` travels in the `GraphRevisionSuperseded` event's successor binding.

## The two things that would have shipped broken without mutation drills
Both drills SURVIVED first time. Neither was caught by a green 338-test suite.

1. **The predecessor comparison had quietly detached.** Drill: make the reducer pass
   `command.supersession.expectedPredecessor.revisionId` instead of `state.revisionId` into the
   kernel. Suite stayed fully green. Every drift case I had written was being refused by the
   SUCCESSOR binding (`monotonic()` checks `next.predecessorRevisionId === current.revisionId`),
   never by `samePredecessor()`. Fix: a test whose `expectedPredecessor` AND `successor.predecessor*`
   AGREE WITH EACH OTHER on a foreign revisionId / content hash / epoch — self-consistent, so only
   comparison against live state can refuse it. **Generalisation: when two guards can refuse the
   same input, a drift test proves nothing about which one fired. Make the input consistent with
   everything except the guard under test.**
2. **Nothing pinned the epoch placement rule.** Drill: `validGraphEpochPlacement` accepts 0 for
   ACTIVE — zero tests reddened. Fix: 7 malformed states (ACTIVE@0, SUPERSEDED@0, DRAFT@1,
   ACTIVE@-1, ACTIVE@1.5, ACTIVE@NaN, ACTIVE@undefined) each asserted to return exactly
   `UNKNOWN_ERROR`.

## The production `layer` discriminant is load-bearing
`RuntimeError` has no `source` field (`runtime-error-factory.ts:20-31` validates then DROPS it), and
both supersession codes carry `NO_KEY` details — so the refusing layer is UNOBSERVABLE without it.
`GRAPH_REVISION_LAYER` is declared in `graph-revision-contract.ts` (NOT results.ts as the plan said —
results already imports the contract, so declaring it there would invert the dependency) and set
once inside `rejected()`. Drilling it to `"SUPERSESSION_KERNEL"` reddens **20 tests**, because
`expectError` in the fixtures asserts it on every refusal in both reducer suites.

## The invariant suite was VACUOUSLY GREEN and would have stayed that way
`planning-invariant-drivers.ts` built `"graph.supersede": { witness: refusal }` — malformed, refused
`REVISION_REBOUND` every time, so the random walk never once reached SUPERSEDED and
`REVISION_TERMINAL.has(source)` never fired. Green suite, zero coverage. Fixed by passing the walked
state into `revisionCommand(kind, version, roll, current)` and building a real input via the shared
`supersessionInput` fixture. **I then PROVED it non-vacuous** by collecting every lifecycle the walk
reaches across all 5 seeds and asserting `observed.has("SUPERSEDED")` — permanent, so the sweep can
never silently stop generating supersede cases again. `REVISION_TERMINAL` lost `"ACTIVE"`;
`REVISION_RANK` needed no change (SUPERSEDED 4 > ACTIVE 3 already).

## 11th file, outside the plan's 10 owned paths — read before judging scope
`packages/testkit/src/schedule/schedule-universe-tables.ts` (+3/-2). Admitting supersede from ACTIVE
reddens `tests/property/schedule/schedule-coverage.test.ts` on two assertions, and that red is
attributable to MY diff, which the path-attribution rail forbids excusing as foreign. Add
`revSupersede: edge(REVISION, "ACTIVE", "graph.supersede", "SUPERSEDED")`, drop `"graph.supersede"`
from `NEVER_LEGAL_COMMANDS.GRAPH_REVISION`, delete the now-false comment. Disclosed in
`comment-59969aa6df154215a664a542057186b7`. **Anyone else changing a `*_TRANSITIONS` table in
packages/core must sync this manifest — it is not discovered by any package-scoped gate.**

## Verification
`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` -> exit 0, Test Files 22 (up
from 20 at baseline, so not narrowed), Tests 359. Repo-wide `pnpm test` 208/208 files, 3960 passed.
Repo-wide `pnpm typecheck` exit 1 on ONE foreign line:
`apps/daemon typecheck: src/identity/session-authenticator.test.ts(8,3): error TS6133: 'OPENER' is declared but its value is never read.`
The scheduler package-boundary shebang red the plan predicted is GONE — do not copy that warning forward.

## Disclosed design gap, NOT a defect
Activation sets `graphEpoch = 1` literally, so a SUCCESSOR revision's own activation does not yet
land at predecessor epoch + 1. DoD 2 only requires the supersede RESULT to emit that binding, which
it does. Closing the successor's own activation belongs to `task-069853689ed643988cfec2d689f7edb7`.
Putting the epoch on `GraphActivationBinding` would be purer but reaches `bindingShape`,
`sameBinding`, `BINDING_KEYS`, the APPROVAL/ACTIVATION fixtures and planning-run's `RUN_ACTIVATION`.

Final sizes (grep -c ''): contract 188, reducer 237, validation 127, results 86, test-fixtures 177,
reducer.test 219, supersession.test 196, invariant-drivers 244 (tightest), invariants.test 144,
invariant-fixtures 89, schedule-universe-tables 212.
