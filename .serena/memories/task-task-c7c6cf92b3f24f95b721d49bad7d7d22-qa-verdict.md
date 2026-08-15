# QA verdict: retire scheduler-authority-lease absence entry — APPROVED

Commit `3944a9d`. Reviewed by qa-812c17a0 2026-08-09. Worker handoff:
`mem:task-task-c7c6cf92b3f24f95b721d49bad7d7d22-handoff`.

## Gates re-run by QA (not trusted from the summary)
- `pnpm --filter @moe/testkit typecheck` -> tsc clean.
- `npx vitest run --root . tests/fault/foundation/j4-replan-stale.test.ts` -> 1 file / 15 passed.
- `pnpm test` -> 159 files / 2870 passed / 1 skipped / 0 failed, EXIT=0.
- Baseline for comparison: 158 files / 1 failed / 2866 passed / 1 skipped.
  The J4 red that blocked task-2d1f94f9, task-49acb856 and task-97554aa4 is gone.

## The drill that actually decided this (reusable)
The worker's own drill mutated the *expected reason code*
(`AUTHORITY_STALE_EPOCH` -> `AUTHORITY_STALE_LEASE`). That proves the assertion
runs, but NOT that the refusal came from the epoch comparison rather than the
nearer `AUTHORITY_MALFORMED_INPUT` parse layer — a slightly malformed fixture
would kill that mutant too.

The stronger drill, and the one QA ran: neutralise the *input operand*, not the
expectation. Change `{ ...authority, epoch: lease.epoch - 1 }` to
`{ ...authority, epoch: lease.epoch }` and the row goes red at
`expect(stale.ok).toBe(false)` with `expected true to be false`. Because the
identical fixture is ACCEPTED at the current epoch, the fixture is provably
well-formed and the epoch is provably the sole discriminator. Prefer
input-operand mutation over expectation mutation when the production surface has
a nearer refusal layer that could be answering first.

Shared-worktree discipline held: `git rev-parse HEAD:<path>` captured first
(`270e5900`), one focused run per mutated window, restore verified by
`git hash-object` against that sha rather than by `git status`.

## The one thing that looked like a scope breach and is not
The commit DELETES `probe:scheduler-authority-lease`, while DoD item 1 says "no
other manifest row or probe definition is changed". That deletion is forced, not
creep: `packages/testkit/src/foundation/foundation-spec.test.ts:150` asserts a
BIJECTION — `expect([...claimed].sort()).toEqual([...probeRefs].sort())`, where
`claimed` is built only from rows whose outcome is `PRODUCTION_BEHAVIOR_ABSENT`.
Retiring the last ABSENT row that claims a probe orphans it and reddens that
guard. Plan step 3 pre-authorised exactly this ("unless a guard requires
otherwise"). Grep confirmed no other row referenced it.

Generalisable: in this manifest, retiring the final ABSENT row for a probe and
retiring the probe are a single atomic edit. A future reviewer seeing a lone
probe deletion should check the bijection guard before calling it scope creep.

## Other checks
- Executor reaches production through the foundation harness namespace
  (`tests/fault/foundation/foundation-harness.ts:22` imports
  `../../../packages/scheduler/src/index.js`) — the package ROOT index, so no
  deep-path import and no `package-boundary.test.ts` exposure. A bare
  `@moe/scheduler` specifier is NOT resolvable from the repo root
  (`mem:gotcha-bare-moe-specifier-unresolvable-from-repo-root`), so the harness
  is the correct published entry point here.
- Refusing layer pinned, not just the code: `toEqual` on the whole
  `securityRecord` (`aggregateKind: "LEASE"`, commandKind, leaseId, sourceState,
  expectedEpoch/observedEpoch).
- Positive control present, so the row cannot pass by refusing everything.
- `git show --stat 3944a9d` = exactly the two owned paths (36+/18-).
- Per-FILE cap fine: 231 and 201 lines. Task-level LOC is not a bar.
