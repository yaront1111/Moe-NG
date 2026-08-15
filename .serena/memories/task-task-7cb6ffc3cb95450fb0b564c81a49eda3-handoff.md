# Handoff: task-7cb6ffc3 — planning invariant test decomposition (commit a929e11)

Child 4/5 of the approved size exception (prop-2eaa632d). Split
`packages/core/src/planning/planning-invariants.test.ts` (432 lines) three ways:

| file | lines | holds |
|---|---|---|
| planning-invariants.test.ts | 129 | describe + the 7 property `it()` cases, unedited |
| planning-invariant-fixtures.ts | 88 | hashes, witness constants, lifecycle rank/terminal tables, xorshift32, expectDeepFrozen, perturb, summaries, finalizeWitness |
| planning-invariant-drivers.ts | 235 | runCommand, pickRunKind, runTrace, revisionCommand, revisionTrace, SEEDS, RunStep, the six `*_STEPS` pools, driveRun, runSeedPool, sealedRun, planReviewRun, approvedRevision |

Import graph is one-way: test -> drivers -> fixtures. No cycle.

## The split boundary is NOT the one the task description implies

The task text says fixtures owns "commands and traces" and drivers owns "valid-state
drivers/seed pools". Taking that literally creates an import cycle: `runTrace` calls
`runSeedPool`, which calls `driveRun`, which calls `runCommand`. The approved
implementationPlan step-2 names the acyclic split instead (traces and command builders
live with the drivers) and that is what shipped. If a future task re-reads the task
description and "fixes" the layering, it will reintroduce the cycle.

## Why drivers is 235 and not ~140

The plan predicted ~140. The driver range is 212 physical lines at HEAD before a single
import is written, so the only slack is the import block. Keeping it under 250 required
compact multi-name-per-line import specifiers (the repo has NO eslint config, so nothing
enforces one-name-per-line). If someone reformats those imports to one name per line,
drivers blows the 250-line rail. Rebalancing means moving whole functions across the
fixtures/drivers boundary — never trimming a seed or a case.

## One deliberate 105-char line

`export const RUN_APPROVAL_STATES: ReadonlySet<string> = new Set([...])` is left on one
long line rather than wrapped, so that stripping the leading `export ` leaves text
byte-identical to HEAD. That keeps the whole-body containment check below clean. Do not
"tidy" it.

## The verification that actually matters

Green proves nothing here — the suite was green before. See
`mem:pattern-qa-verifying-a-pure-refactor`. Two checks were run and should be re-run by QA:

1. Whole-body byte containment. Take each new file's text after its import header, strip a
   leading `export ` per line, and test `.Contains()` against
   `git show bcdc2f6:packages/core/src/planning/planning-invariants.test.ts` (blob
   `446691c0304f8c49025785294434d1058e32370c`). All three are CONTIGUOUS substrings,
   covering old lines 25-101 (fixtures), 102-314 (drivers), 316-432 (test) — no overlap,
   no orphan, old 1-23 was the import block. This subsumes every seed, roll modulus, trace
   bound (120), bearing set ([2,3,5]) and perturbation constant in one assertion.
2. Mutation. `perturb` made an identity -> the exact-hash refusal case goes red (1/7).
   `SEALED_STEPS` roll 3 -> 1 -> three cases go red (3/7). Both reverted and containment
   re-confirmed.

Summed assertion inventory across the three files equals the pre-split file: 48 `expect(`,
4 `expectDeepFrozen(`, 40 `.toBe(`, 5 `.toEqual(`, 2 `.toBeGreaterThanOrEqual(`, 7 `it(`,
1 `describe(`, 0 only/skip/todo.

## Verification

`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` -> exit 0,
14 files / 226 tests, identical to the pre-split baseline. Isolation run of the file alone,
twice: 7/7 both times.

## Repo-gate reds seen during this task, both foreign

- `packages/scheduler/src/package-boundary.test.ts` — transient, was task ca32f538's fixture
  header naming the scheduler path in prose; fixed by d2b1d77. See
  `mem:gotcha-scheduler-boundary-check-reads-comments`.
- `packages/testkit/src/foundation/foundation-gate-coverage.test.ts` — deterministic
  `ENOENT tests\fault\foundation\tsconfig.json`, hardcoded at line 37 of that test, absent
  at HEAD. Owner was mid-fix (untracked tsconfig.json appeared in-tree). Not attributable
  to the planning decomposition batch.

## Next

The closing "Planning source size guard" task becomes plannable once child 5/5 lands.
