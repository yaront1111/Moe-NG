# task-eb9ff081 handoff — package-wide `.js` runtime bridges for `@moe/runner`

**DONE, committed `160215a`**, 46 files, +202 insertions, all `create mode`, zero foreign
paths, zero `.ts` modified. Branch `moe/work-2026-08-08`.

## What landed

45 one-line bridges `export * from "./<name>.ts";` (LF, trailing newline) plus
`packages/runner/src/runtime-entrypoint.test.ts` (157 lines, 3 tests).

**The defect is fixed.** `packages/runner/src/index.ts` — the package's own declared entry
point — previously died `ERR_MODULE_NOT_FOUND` under plain Node while 852 vitest tests
stayed green. Now `import("@moe/runner")` through the real exports map resolves with
**66 exports, 0 undefined bindings**. `task-ba3a45f9` can take the daemon dependency.

## The one judgement call — read this before reviewing

DoD 1 spells the bridge exclusion as a suffix list. Five supervisor modules match none of
those suffixes and still must not be bridged: `race-harness`, `race-scenarios`,
`race-restart-scenarios`, `race-steps`, `race-world`. Full reasoning and the rule that
replaces the suffix heuristic: `mem:gotcha-test-tier-modules-have-no-test-suffix`.
I took rail 5's principle over DoD 1's enumeration and flagged it in #general
(`msg-2df8d3f6`) before committing. Bridging them to satisfy the letter would commit five
files that provably cannot load — failing DoD 3 and DoD 4 to satisfy DoD 1.

## Evidence (a green suite is NOT evidence here)

- Plain-Node probe, three controls: positive `import("@moe/runner")` 66 exports / 0
  undefined; regression control `@moe/scheduler` + `@moe/store` bridges still load;
  negative control both `*-test-fixtures.js` paths still raise the **literal**
  `ERR_MODULE_NOT_FOUND`.
- All 45 entry points probed in **separate** Node processes (ESM cycles resolve per entry
  point): `FAILED=0 UNDEFINED_BINDINGS=0 zeroExport=0`.
- Byte audit over all 45: `MISSING=0 UNEXPECTED=0 BADCONTENT=0 CRLF=0`, `UNEXPECTED`
  computed from both ends.
- Mutation drill 3 operands, 3 killed, 0 survived — **whole-test granularity**, and each
  drill also killed a second test (breaking a bridge reddens the static audit AND the
  runtime probe; bridging a fixture reddens the audit AND the negative control). Restores
  verified by grep, not assumed.
- Gate `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` exit 0,
  **26 files / 855 tests**, up from **25 / 852**.
- Repo-wide `pnpm test`: 1 failed / 2869 passed / 1 skipped, 159 files. Baseline was
  1 failed / 2866 passed / 158 files → delta is exactly my +1 file / +3 tests. Zero
  regressions.

## Still blocking others, NOT mine

`tests/fault/foundation/j4-replan-stale.test.ts` fails at HEAD. The probe entry is
declared at `packages/testkit/src/foundation/foundation-fault-schedule.ts:168`
(owner `task-18c7921f`): it says `PRODUCTION_BEHAVIOR_ABSENT` for
`probe:scheduler-authority-lease` while `fenceAuthority` IS exported from
`packages/scheduler/src/index.ts`. Ratchet firing as designed. Any task whose gate is the
repo-wide `pnpm test` cannot reach exit 0 until its owner flips that one entry. Has now
stalled three workers.

## For whoever adds the next runner module

The module count moved **three** times during this task's life: description said 41, plan
measured 44, disk said 52 non-test `.ts` at sweep time. Re-derive it; never trust a
recorded number. Add the sibling bridge in the SAME commit — `runtime-entrypoint.test.ts`
will now redden if you don't.
