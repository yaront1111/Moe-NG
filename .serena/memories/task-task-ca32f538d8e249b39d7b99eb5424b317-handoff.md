# Planning run test decomposition — reopened once, fixed, back in REVIEW

Task `task-ca32f538d8e249b39d7b99eb5424b317` on `moe/work-2026-08-08`.

## What shipped

`packages/core/src/planning/planning-run-reducer.test.ts` (514 lines, 32 `it()`) split three ways:

- `planning-run-test-fixtures.ts` (NEW, 156 lines) — verbatim move of baseline lines 18-153.
  Exports exactly 19 symbols: `hash`, `SUBMISSION_HASH`, `HASHES`, `READINESS`, `RESUME`,
  `RECOVERY`, `EFFECT_TERMINAL`, `REVISION_SEAL`, `REFUSAL`, `PLAN_APPROVAL`, `REVISE`,
  `ACTIVATION`, `CANCELLATION`, `finalizeWitness`, `state`, `commandFor`, `expectError`,
  `expectIllegal`, `accepted`. Private (still consumed internally, so `noUnusedLocals` holds):
  `PLAN_HASH`, `GRAPH_HASH`, `QUALITY_HASH`, `DEPENDENCY_HASH`, `BUDGET_HASH`, `POLICY_HASH`,
  `CLAIM`, `RELEASE`, `SUBMISSION`, `summaries`, `SEALED`.
- `planning-run-reducer.test.ts` (228 lines) — 20 cases: creation and readiness (4), ownership (4),
  submission (5), submission finalization (7).
- `planning-run-authority.test.ts` (NEW, 180 lines) — 12 cases: approval and activation (7),
  cancellation and concurrency (5). Owns the `RUNTIME_LIFECYCLES` /
  `PLANNING_RUN_COMMAND_KINDS` / `PLANNING_RUN_TRANSITIONS` imports because the version-ceiling
  and exhaustive kind-by-lifecycle matrix live there.

Zero production files touched. `packages/core/src/index.ts` untouched and references neither new file.

## QA reject #1 and the fix — read this before touching the header comment

The split itself was verified flawless (QA reproduced the reconstruction proof independently:
25591 chars both sides, 32 `it()` multiset-equal, zero duplicates). The reject was **one line of
prose**.

Fixture line 4 read ``Mirrors `packages/scheduler/src/test-fixtures.ts`: ...``. That turned the
repo red: `packages/scheduler/src/package-boundary.test.ts:42-43` regex-tests **raw whole-file
contents** with `/(?:@moe\/scheduler\/|scheduler[\\/]src[\\/])/u`, so accurate prose naming the
path is indistinguishable from a deep import. 1 failed / 13 passed, violation list = this file
alone. Full detail: `mem:gotcha-package-boundary-test-matches-comments`.

Fix in `d2b1d77`: reworded to "Mirrors the scheduler package's own test-fixtures module",
reflowed across the same five comment lines so the file stays 156. Comment prose only —
`git diff` is 5-/5+ entirely inside the leading block comment, zero executable bytes, so the
reconstruction proof still holds. Boundary test red -> green proven both directions.

**Do not re-add the path to that comment.** The scheduler-side regex is the durable defect but is
not this task's path; raised separately for the scheduler owner.

## Process lesson that caused the reject

The plan named only `pnpm --filter @moe/core ...` as verification. A cross-package content scan
living in `@moe/scheduler` is invisible to that gate by construction. **Run `pnpm test` once before
completing and attribute foreign red by path.** Also `mem:gotcha-shared-tree-repo-gate`.

## Import sets are load-bearing

`tsconfig.base.json` sets `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`. So each half must import EXACTLY what it uses and type imports must
say `import type`. Reducer half needs only value `reducePlanningRun` + type `PlanningRunCommand`.
Authority half additionally needs `PlanningRunLifecycle` and `PlanningRunState`. Getting this wrong
fails `tsc`, which is why the typecheck half of the gate is the real import check.

## Verification (post-fix, fresh)

- Named gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` — exit 0,
  14 files / 226 tests. Unchanged from pre-reject, so the reword cost nothing.
- Full repo `pnpm test` — exit 0, 114 files / 1583 passed / 1 skipped.

First full-repo run showed 1 failed / 113 passed, but the red was foreign and transient:
`packages/testkit/src/foundation/foundation-gate-coverage.test.ts` hit
`ENOENT ... tests/fault/foundation/tsconfig.json` while that file was still `??` untracked —
another worker was mid-write in the shared tree. Its `OWNED_DIRECTORIES` are
`packages/testkit/src/foundation` + `tests/fault/foundation`, no overlap here. Re-run was green.
**Expect this class of transient red on any full-repo gate in this epic** — attribute by path
before believing you broke something.

## Commits

- `5a57b2a` swept all three files under another task's message
  (`mem:gotcha-shared-index-commit-capture`); not reverted, per the epic rail.
- `d2b1d77 fix(task-ca32f538d8e249b39d7b99eb5424b317): reword fixture header off the scheduler path`
  — the reword, 1 file, committed by explicit pathspec, `git show --stat` confirms one owned path.

QA should review the split with the range diff, not `5a57b2a` (22 files, mixed ownership):

```
git diff bcdc2f6..HEAD -- packages/core/src/planning/planning-run-reducer.test.ts \
  packages/core/src/planning/planning-run-test-fixtures.ts \
  packages/core/src/planning/planning-run-authority.test.ts
```

## Proof technique that made this cheap

Do NOT hand-transcribe describe blocks. Slice them out of the committed baseline with Node and write
the owned paths directly, then prove it by RECONSTRUCTION — see
`mem:gotcha-verbatim-test-split-reconstruction-proof`. That single check subsumes name-multiset,
assertion, loop, and ordering checks.

## If a follow-up reopens this

Baseline oracle is `bcdc2f6:packages/core/src/planning/planning-run-reducer.test.ts` (514 lines,
32 `it()`). The prerequisite type facade is `mem:task-task-866713137aee4794a51973fe4e6e3f44-handoff`.
`planning/` carries no `.js` shims (only `identity/` does), so new modules there need none.
