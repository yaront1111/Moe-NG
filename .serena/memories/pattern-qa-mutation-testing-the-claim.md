# Pattern: mutation-test the specific claim, not the suite

Six reviews on 2026-08-07 (admission, planning-contract split, foundation spec, policy
approval, StoredEvent B1). A green suite proved nothing in three of them; a targeted
mutation decided every case. Cost is ~2 minutes per mutation.

## Method

1. Name the single claim the DoD rests on ("the ratchet fires", "typecheck is the
   export sentinel", "the value round-trips", "children can't relax a rule").
2. Break exactly that mechanism in the production code — one line.
3. Run the focused suite. Red means the coverage is load-bearing. **Green means the
   task is not done, however many tests pass.**
4. `git checkout -- <single file>` to restore, re-run, confirm green and tree clean.

Restoring: `git checkout -- <path>` on an already-committed, unmodified file is safe.
Never reset/stash — the epic rails forbid them and the tree is shared with live agents.
Check `git status --porcelain` after: other agents' in-flight edits will show up in the
same package and must not be touched.

## Mutations that paid off

- Absence probe: added a real export name to the probe's list -> the schedule flipped
  PRODUCTION_BEHAVIOR_ABSENT to PASS_EXPECTED and the test went red. Proved the ratchet
  reads live export surfaces rather than echoing a declared outcome.
- Facade re-export: deleted one name from the facade -> `TS2305` at 3 sites including
  the root barrel. Proved "the typecheck is the public-export sentinel".
- Pinned digest: flipped one hex char -> 2 tests red. Proved the digests are enforced.
- Round-trip: made the decoder return a constant instead of reading the column, then
  made the INSERT bind a constant instead of the per-row value -> 3 tests red each.
  Proved the value survives the DB, rather than being echoed in memory.
- Policy relaxation: stripped the `requiredFactIds` shrink clause -> 6 tests red across
  3 files. Proved a re-review fix was real.

## Also write your own probe, not just mutations

A mutation proves existing tests are load-bearing. A **fresh probe against the public
entry point** finds what the tests never reach. On the admission review that is what
exposed the fail-open: both modules read as correct in isolation, and only calling
`admitGraph` directly with the task's own fixtures showed it admitting AGENT_REPORTED
necessity with zero issues. Use the task's own fixture helpers so the probe is not
arguing about setup, print the result with `console.log`, then delete the probe and
confirm `git status --porcelain` is clean.

## Non-vacuity

For property/seed sweeps, check the generator actually emits the shape under test.
A 320-seed sweep that never generates the case passes vacuously. Good fix seen here:
`expect(shrunk).toBeGreaterThanOrEqual(5)` with the observed count in a comment — a
canary against a silent generator retune.

## Related

`mem:gotcha-admission-entry-point-fail-open`,
`mem:pattern-verifying-type-facade-refactors`,
`mem:gotcha-tests-dir-outside-every-gate`
