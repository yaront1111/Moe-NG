# Graph revision supersession transition — QA verdict: APPROVED

Reviewed by qa-5be1a8d6, 2026-08-09. Worker worker-901cc711. Full evidence in
`comment-a1cedc711d0e465c961e2c5cc1a0a1ee`.

## What I actually re-ran (nothing taken from the worker's summary)
- `pnpm --filter @moe/core typecheck` exit 0; `test` -> **22 files / 359 tests passed**
  (baseline was 20 files, so the invocation was not narrowed).
- Repo-wide `pnpm test` -> 209 files, 3980 passed | 1 skipped.
- Repo-wide `pnpm typecheck` exit 1, every failing path foreign:
  `apps/daemon/src/documents/document-work-{decision-validation,read-integrity,tail}.test.ts`
  and `src/identity/session-authenticator.test.ts`. Intersection with owned paths EMPTY.
  Two of them are UNTRACKED in-flight files from another agent.

## Commit attribution: this task's bytes are in three foreign commits
`c199088` is TITLED for this task but contains ZERO of its files — only control-room,
daemon documents and runner windows-native work. The owned bytes reached HEAD through
`bb29326` (task-885a46e9) and `5172b3e` (task-4d226307) whole-tree hooks, plus the worker's
own scoped `a3335ed` and `0ff900a`. Verify by base-ref diff
`git diff 8946b02d..HEAD -- <11 paths>` (+426/-38) and by `git status --porcelain` on the
owned dirs being empty, which is what proves committed bytes == gated bytes.

## Seven mutation drills, all reddened a named owned test
Restored byte-exact and confirmed with `sha256sum -c` (git diff could not prove this: one
owned file was untracked at authoring time).
1. transitions admit APPROVED -> lifecycle sweep red
2. predecessor `revisionId` echoed from the command instead of live state -> self-consistent
   foreign-predecessor test red
3. `graphEpoch` echoed from the command instead of live state -> same test red
4. `rejected()` returns layer `SUPERSESSION_KERNEL` -> **20 tests** red
5. `validGraphEpochPlacement` accepts 0 for ACTIVE -> epoch-placement test red
6. SUPERSEDED terminal guard removed -> 3 tests across 2 files red
7. activation lands `graphEpoch: 0` -> invariant walk + freeze test red

Drills 2 and 3 are the load-bearing ones: they prove the reducer hands `decideSupersession`
the LIVE state rather than echoing the command's own claim.

## The 11th file was verified by measurement, not accepted as prose
`packages/testkit/src/schedule/schedule-universe-tables.ts` is outside the plan's 10 owned
paths. I reverted it to base and ran `tests/property/schedule/schedule-coverage.test.ts`:
2 assertions go red. The manifest is cross-checked against production `LANDED_TRANSITIONS`,
so admitting supersede from ACTIVE FORCES the edit — that red is caused by this diff and
could not have been disclosed as foreign. +3/-2 is minimal repair, not scope creep.

**`pnpm --filter @moe/core test` cannot see this file's consumer.** Any core
`*_TRANSITIONS` change needs a repo-wide run before approval.

## Non-vacuity confirmed independently
`planning-invariants.test.ts` asserts `observed.has("SUPERSEDED")` over `entry[1]` across all
5 seeds. Driver entries are `[kind, lifecycle, version]` on accept, `[kind, errorCode]` on
refusal; no error code is the bare string `SUPERSEDED` (`SUPERSEDED_AUTHORITY` is a different
string), so only an ACCEPTED result landing SUPERSEDED satisfies it. Both narrowed loops pair
their `continue` with a positive assertion and an exact refused count.

## Sizes, hand-measured `grep -c ''`
188 / 237 / 127 / 86 / 177 / 219 / 196 / 244 / 144 / 89 / 212. Max 244, all <= 250.
Task-level LOC is not a bar and was not applied.

## Accepted disclosure, not a waiver
Activation sets `graphEpoch = 1` literally, so a successor's OWN activation does not yet land
at predecessor + 1. DoD 2 requires only that the supersede RESULT emit that binding, and it
does (successor epoch asserted against the kernel's own return value). Successor activation is
`task-069853689ed643988cfec2d689f7edb7`.

## Correction for anyone reading the plan forward
The scheduler `package-boundary.test.ts` shebang red that step 11 predicted is GONE. Do not
carry that warning into a later task.
