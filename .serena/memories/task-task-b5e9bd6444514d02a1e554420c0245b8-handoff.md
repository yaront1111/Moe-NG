# Isolated hostile-test lane infrastructure — worker handoff

Task `task-b5e9bd6444514d02a1e554420c0245b8` (epic M5 GA evidence). Merge-base
`2c04fdd`. 6 owned paths, 5 of them new.

## Review this by base-ref diff, not by commit

```
git diff 2c04fdd -- package.json
git status --porcelain --untracked-files=all -- tests/fault tests/security
```

`package.json` is `2 insertions(+), 0 deletions`. The five lane files are still
untracked at handoff. See `mem:gotcha-completion-hook-commits-whole-tree`.

## What landed

- Root `test:fault` = `tsc -p tests/fault/tsconfig.json && vitest run --config tests/fault/vitest.config.ts`
- Root `test:security` = the analogous security paths.
- `tests/{fault,security}/tsconfig.json` — extend `../../tsconfig.base.json`,
  `composite/declaration/declarationMap:false`, `types:["node"]`,
  `include: ["./**/*.ts"]`.
- `tests/{fault,security}/vitest.config.ts` — lane root from
  `dirname(fileURLToPath(import.meta.url))`, fail-empty, serial, no-focus,
  no-retry, strict unhandled errors, stable sequencer.
- `tests/security/lane-smoke.security.ts` (247 lines, 17 cases).

## Facts worth not re-deriving

**The lanes are disjoint from the root suite by NAMING, with zero config
surgery.** Root `vitest.config.ts` includes only `*.test.ts`, so `*.fault.ts`
and `*.security.ts` are invisible to it. No task owns the root config and none
needs to. Root discovery was 199 files before and 201 after, with **0** hostile
suffixes and all 3 Foundation files still present — the +2 is foreign.

**The recursive `include: ["./**/*.ts"]` in `tests/fault/tsconfig.json` finally
typechecks `tests/fault/foundation/**`.** `mem:gotcha-tests-dir-typechecked-by-no-gate`
records that the Foundation tsconfig existed but nothing invoked it. It is
type-clean today (`tsc -p tests/fault/foundation/tsconfig.json` exit 0), so
sweeping it imports no foreign red — but it reaches `packages/{contracts,core,store,scheduler}`
through the harness, so a foreign mid-TDD-red package CAN redden `test:fault`.
Attribute by path and re-run before believing it.

**`test:security`'s tsc leg reaches `tests/fault/vitest.config.ts`**, through the
smoke's import. A broken fault config stops the SECURITY script at tsc. Found by
accident during a drill; genuinely surprising.

**`&&` short-circuits correctly through pnpm's Windows launcher.** A TS error in
the smoke produces the tsc diagnostic and **zero** `RUN v` banners.

**Fail-empty is attributable.** Zero matches + `passWithNoTests:false` →
`No test files found, exiting with code 1`; with `true` → *same message*,
`code 0`. Identical diagnostic, different exit code: quote the code, not the text.

## Two defects this task's own review caught

1. **A survived mutant.** Both lanes carry their own copy of the comparator, and
   the ordering assertions covered code-unit order on the *security* one and
   separator normalization on the *fault* one. Swapping the fault comparator to
   `localeCompare` passed all 13 cases. Fixed by `describe.each` over both lanes.
   `mem:gotcha-mutation-finds-the-untested-half-of-a-pair`.
2. **Exact set equality on `package.json` script keys**, which no drill would
   flag because it was green. It would have turned this lane red the moment
   `task-9449ce65` — the downstream co-owner named in this task's own
   description — added any script. Now a subset check: deletion red, addition
   green. See `mem:gotcha-a-scope-clause-does-not-expire-with-its-reason` for the
   adjacent family.

Also: the typecheck-before-Vitest property originally asserted over the file's
own `FAULT_SCRIPT`/`SECURITY_SCRIPT` constants — the file checking itself. It now
reads back off disk and lives in its own `it` so the exact-string case cannot
short-circuit it.

## For the next lane author (S0–S11, F1, F2, H0, R0–R6)

- Name new files `*.security.ts` / `*.fault.ts`. Nothing else is needed to stay
  out of `pnpm test`.
- The fault lane's `foundation/**/*.test.ts` selector is load-bearing: drop it
  and the lane is zero-case and exits 1. That is what keeps it non-empty today.
- Do NOT extract the duplicated sequencer into a shared helper. It would be a
  7th file and would couple the two hostile lanes' execution order.
- `maxConcurrency:1` is what bounds an explicit `it.concurrent`;
  `sequence.concurrent:false` only sets the default.
- `allowOnly:false` refuses `.only` with
  `[Vitest] Unexpected .only modifier` rather than silently narrowing the lane.

## Verification

`pnpm test:fault && pnpm test:security` exit 0 — 3 files/43 tests, then
1 file/17 tests. Repo-wide typecheck exit 0. Repo-wide `pnpm test` exit 1 on
`packages/scheduler/src/package-boundary.test.ts`
(`boundary scan failed for apps\daemon\src\daemon-main.ts: unterminated regular
expression source token` — a foreign mid-edit file). That file was already in the
pre-diff baseline; HEAD-minus-baseline delta is EMPTY.

11 mutation drills, 10 killed first try, 1 survived and produced fix (1) above.
All restores verified by recorded sha256, never by `git status`
(`mem:mutation-drills-in-shared-worktree`).

`vitest.config.ts`, `pnpm-lock.yaml` and `tests/fault/foundation/**` are
byte-unchanged; the root config was deliberately NOT mutation-drilled because it
is the gate every concurrent agent is using for evidence.
