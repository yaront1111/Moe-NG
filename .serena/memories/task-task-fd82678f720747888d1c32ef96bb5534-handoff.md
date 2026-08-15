# Foundation control-room shell — QA APPROVED (2026-08-08, qa-f4052923)

Reopen #1 fix verified and approved. Commits: `83144cc` (scaffold, 9 owned paths) +
`c46965c` (gate isolation fix, exactly `fixtures.ts` + `scaffold.test.tsx`, +48/-31).

## The blocking hole is closed, and I proved it with mutation, not reading

Prior reject: `const live = true` in `fixtures.ts:186` left the suite 24/24 green, because
every blocked canonical fixture ALSO carried zero commands. Fix adds
`MUTATION_BLOCK_ISOLATION` — one snapshot per blocking leg, each built so every OTHER
condition permits mutation:

1. DISCONNECTED + non-empty cached commands + refresh false
2. CONNECTED + non-empty commands + refresh true
3. CONNECTED + empty commands + refresh false

Four mutations run by QA on `snapshot()` (out-of-tree `cp` backup, `git hash-object`
verified restore each time, final hash identical to `69170bf…`):

| mutation | result |
|---|---|
| `const live = true;` | 1 failed / 24 passed |
| drop connection leg (`!requiresAffordanceRefresh`) | 1 failed / 24 passed |
| drop refresh leg (`connection !== "DISCONNECTED"`) | 1 failed / 24 passed |
| drop length check (`mutationsEnabled: live`) | 1 failed / 24 passed |

Every leg is individually load-bearing. Tautology at the old `:175` is gone — replaced by
a fixed exhaustive `Record<FixtureConnectionState, boolean>` (CONNECTED/LAGGING true,
DISCONNECTED/HISTORICAL false) that does not re-derive production's expression. Case list
is guarded: `length).toBe(3)` plus per-fixture shape assertions, so no vacuous loop and no
silent reorder.

## Gates I re-ran

- `pnpm --filter @moe/control-room typecheck && pnpm --filter @moe/control-room test`
  -> exit 0, 1 file / 25 tests. Matches the worker's claim exactly.
- Boundary suites that scan `apps/**` contents: `packages/scheduler/src/package-boundary.test.ts`
  + `packages/testkit/src/foundation/foundation-spec.test.ts` -> 2 files / 33 passed. New
  fixture strings trip nothing.
- Root `pnpm typecheck && pnpm test` -> RED, **provably foreign**: the only failure is
  `packages/scheduler/src/budget/budget-measurement.test.ts` importing a non-existent
  `./budget-measurement.js`. That file is UNTRACKED (`??`) — another agent's red-phase TDD
  work in flight in this shared tree. 1662 passed / 1 skipped otherwise; zero
  `apps/control-room` entries in the failure output. Not attributable to this task.
- Files: fixtures 245, kernel 186, main 29 (all <=250); test 272 (<400). Tracked paths under
  `apps/control-room` are exactly the 8 owned sources; working tree clean.

## Scope note left open for the architect

DoD 1-3 still read as if this record owned the shell frame + J1 board slices, which the
approved plan re-pointed to sibling `task-04673fd0` (BACKLOG) in a pre-split. The split is
sound and the remainder has a home; this record's DoD text was never re-pointed. Approved on
the split scope, as the prior review already accepted. Do not read the approval as evidence
that the J1 board default or graph-free operability shipped here — it did not.

Related: `mem:pattern-one-fixture-per-predicate-leg`,
`mem:gotcha-assertions-detached-from-their-subject`,
`mem:gotcha-mutation-testing-restore-safety`.
