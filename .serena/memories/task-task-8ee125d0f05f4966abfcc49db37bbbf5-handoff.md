# Scheduler claim-composition root surface — APPROVED / DONE

Commit `239aa4f`. QA `qa-812c17a0` approved 2026-08-09. Worker `worker-f8533806` had
`report_blocked` on a FOREIGN red; that blocker is gone and nothing was re-implemented.

## What shipped (exactly 2 owned paths)

- `packages/scheduler/src/index.ts` 81 -> 174 lines
- `packages/scheduler/src/index-surface.test.ts` new, 259 lines, 48 cases

Root namespace **17 -> 36 runtime keys** (19 claim-composition values) + **40 type exports**
(authority-kernel 10, `Fenced`, resource-model 10, budget-reservation 15, budget-contract 4).
Explicit named exports only — no `export *`, no aliases. Type exports live in a separate
`export type` block so they add zero runtime keys.

## QA-measured evidence (all re-run, not taken on report)

```
pnpm --filter @moe/scheduler typecheck && test && pnpm --filter @moe/daemon typecheck -> EXIT 0
scheduler suite: 32 files / 587 tests, 0 failures
POSITIVE  import('@moe/scheduler')                     -> ROOT_OK exports=36
                                                          reserveProviderSlot/fenceAuthority = function
NEGATIVE  import('@moe/scheduler/authority/lease-resource.js') -> ERR_PACKAGE_PATH_NOT_EXPORTED
```

Zero behaviour change proven by `git show --stat 239aa4f --` over `authority/`, `budget/`,
`package.json`, `pnpm-lock.yaml` -> EMPTY. No `.js` bridge touched. `package.json` exports map
still exclusive: `{".": "./src/index.ts"}`.

## Mutation drill run by QA (epic rail 6), both axes

| drill | result |
|---|---|
| delete `fenceAuthority,` from index.ts | 4 failed / 44 passed; failure NAMES the symbol: `publishes fenceAuthority on the package root as a function` |
| append `fenceAuthority as fenceAuthorityAlias` | 1 failed: `expected [ …(37) ] to deeply equal [ …(36) ]` |

Both axes load-bearing. Restored via a backup kept OUTSIDE git (not `git checkout`, not stash),
`git diff --quiet` clean after each.

Also proved the typecheck actually READS the test file rather than assuming it: injected
`const QA_PROBE: number = "not a number"` -> `src/index-surface.test.ts(261,7): error TS2322`.
`packages/scheduler/tsconfig.json` has `include: ["src/**/*.ts"]`, so `.test.ts` IS typechecked —
that is what makes the type-closure DoD compile-verified.

## Test-count arithmetic (do not misread this)

587 total − 48 (surface file measured alone) = 539 pre-existing, vs the worker's 519 baseline.
The +20 is entirely the UNCOMMITTED FOREIGN `packages/scheduler/src/package-boundary.test.ts`
(+203 lines, another task's WIP). `git log 239aa4f..HEAD -- packages/scheduler/src` is EMPTY.
See `mem:gotcha-test-count-drift-from-uncommitted-foreign-file`.

## Unblocks

`task-ba3a45f9` (daemon work services): `reserveProviderSlot` and `fenceAuthority` are now
reachable from apps/daemon off the bare root specifier. The runner half is `task-53680e91`.

## Notes worth keeping

- `ACQUISITION_STATES` / `ACQUISITION_FAILURES` const arrays are deliberately NOT root-exported;
  only their derived types (`AcquisitionState`, `AcquisitionFailure`) are. Correct restraint — the
  task description did not request them and an unrequested value would trip the addition axis.
- `AdmissionHumanApproval.decision`/`.validity` are inline `(typeof CONST)[number]` over
  non-exported consts, so there is no separate type name to export; a consumer names them through
  `AdmissionHumanApproval` and writes the literals. Not a closure gap.
- Budget trap: `cancelReservation` must run against the view `reserveForAdmission` RETURNED, not
  the one it consumed, or you get a correct `BUDGET_RESERVATION_INSUFFICIENT_RESERVED`.

Related: `mem:gotcha-workspace-exports-map-is-exclusive`,
`mem:gotcha-vitest-hides-missing-js-bridge`, `mem:convention-commit-by-pathspec-in-a-shared-index`,
`mem:gotcha-scheduler-boundary-test-matches-prose`.
