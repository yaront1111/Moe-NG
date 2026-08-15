# QA verdict — task-aedcd01ad9 (successor graph activation at predecessor epoch + 1)

**APPROVED** by qa-ed8ebade. Commit `e3040ad`, 6 files, all under
`packages/core/src/planning/`. Full evidence in `comment-0fc0927033394ccb850904e36ed972e5`.

## What I re-ran (nothing taken on trust)

- `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` -> exit 0,
  **24 files / 369 tests** (baseline 23/363).
- Repo-wide `pnpm typecheck` all Done; repo-wide `pnpm test` **215 files / 4047 passed /
  1 skipped**. No foreign red existed, so path attribution never had to be argued.
- `grep -c ''`: contract 209, reducer 240, validation 156, fixtures 210, succession.test 184,
  invariant-fixtures 89, reducer.test 219 (unchanged). All <= 250.
- `git status --porcelain -- packages/core/src/planning/` empty and
  `git diff e3040ad..HEAD -- <planning>` empty, so committed bytes == gated bytes even though
  HEAD had moved to a foreign commit (`3bdc925`, task-f6c9011b) before I looked.

## The five drills, run by me

All reddened a named test in an owned file; `git checkout --` restored each, status empty after.

- **(a) is the load-bearing one.** Revert `graphEpoch: activation.graphEpoch` to the literal `1`
  -> `expected 1 to be 2` on `next.graphEpoch`, i.e. DURABLE STATE. The event assertion stayed
  green, because the kernel already emitted epoch + 1 before this task. A DoD-3 test reading the
  event would have passed against unmodified production.
- (b) initial rule `=== 1` -> `>= 1`; (c) successor `=== pred+1` -> `> pred`;
  (d) delete the reducer's self-succession check.
- **(e) drop `"succession"` from `SUCCESSION_ACTIVATION_KEYS`** -> reddens the POSITIVE test
  ("expected false to be true"), not just refusals, proving the optional-key tuple is
  load-bearing. It also flipped the rebound test to
  `expected 'ILLEGAL_TRANSITION' to be 'REVISION_REBOUND'` — that test discriminates WHICH guard
  answered, not merely that something refused.

## Why DoD 1 being absent was not a rejection

The goal-side epoch advance is **task-3d5a72fea6db45cfb8df748b58b6aae4** (BACKLOG on disk,
description records the split). The split was mandated by this task's own rail 2 above 10 files,
executed by the architect in plan step 1 + planningNotes, and forced by headroom
(goal-reducer.ts 247 / goal-validation.ts 245 against a 250 cap). Rejecting would punish a worker
for obeying an approved plan they could not lawfully exceed. **Generalisable:** when the task's
`definitionOfDone` array and the approved `implementationPlan` disagree on scope, check whether a
RAIL forced the re-scope and whether the named sibling task actually exists on disk. Both true
here. Neither alone is enough.

## Accepted disclosed limit

A pure aggregate cannot confirm the predecessor named by `succession` exists at the claimed epoch;
a witness lying about `predecessorGraphEpoch` validates. Cross-aggregate binding is the daemon's
atomic transaction, and the production path derives the binding from the kernel-emitted
`GraphRevisionSuperseded` event — which the test consumes rather than hand-building. The binding's
own epoch still fails closed below 1.

## Follow-up for whoever takes the sibling

The epoch chain is NOT end-to-end live until task-3d5a72fe lands: `goal-reducer.ts:39/40` still
admits `goal.activate_initial_graph` from `DRAFT` only, so the goal's `graphEpoch` can still only
ever be 0 or 1. This task made the graph-revision side able to *receive* an epoch; nothing yet
*issues* a second one.

See `mem:gotcha-refusal-case-answered-by-a-later-guard`.
