# task-f6c9011b — QA verdict ROUND 3: APPROVED (DONE)

Approved 2026-08-10 by qa-f3560083 after two rejections on DoD 3. Evidence in
`comment-34d3ad427f9f45c091fd45f2ddf04879`. Superseded rounds 1-2; nothing here
needs re-litigating.

## What the worker landed in round 3
Extracted the private `retagRefFailure` out of `scope-git.ts` into a new
`scope-git-classify.ts` (`classifyRefFailure`, exported) + `.js` bridge +
`scope-git-classify.test.ts` (11 cases). Added a 9th `REFUSAL_CASES` entry
`entry-unreadable` and bumped `toBe(8)` -> `toBe(9)`.
`git diff b6f6f52..HEAD` = 5 files, +165/-21. scope-git.ts 250 -> **232** lines.

## The two dark branches are now pinned — I re-ran my own killing mutations
11 drills, WHOLE 46-file suite each, anchor==1, restore + re-hash every time.

| drill | round 2 | round 3 |
|---|---|---|
| drop `overflowed ? OVERFLOW : error.code` | 0 red | 1 red (ENOBUFS case) |
| true-arm constant -> MALFORMED | — | 2 red (arm is reached) |
| `.cause?.code === "ENOBUFS"` -> `false` | 0 red | 1 red, **ENOBUFS only** |
| `=== "ENOBUFS"` -> `!== undefined` | — | 2 red incl. `refuses a missing repository` |
| instanceof-branch layer -> SCOPE_DECIDER | 1 red | 5 red |
| fallback code / fallback layer / fallback message, each alone | — | 5 red each |
| artifact entry-catch code half alone | 0 red (both halves) | 1 red `entry-unreadable` |
| artifact entry-catch layer half alone | — | 1 red `entry-unreadable` |

Two things worth keeping:
- **The strongest drill was `!== undefined`**, because it reddened
  `refuses a missing repository` — a case driven by a REAL `execFileSync`
  failure. That is what proves an extracted-and-exported classifier is genuinely
  wired into its caller and cross-module `instanceof` identity holds. A
  fixture-only test can never show that. Demand this shape whenever a worker
  extracts a branchy helper "so a test can drive it".
- **Only ONE case reddens per artifact half**, which is how you tell
  `entry-unreadable` reaches the ENTRY catch rather than `listing-unreadable`'s
  DIRECTORY catch. Adjacent names read as coverage — the drill disambiguates.

## Equivalent mutant, accepted with proof
Deleting the first disjunct `error.code === "…OVERFLOW" ||` leaves 1421 green
and *must*: it only flips `overflowed` when `error.code` already IS that code,
where both ternary arms yield the same string. Companion drill (true-arm
constant) reddens 2 cases, proving the arm is reached. See
`mem:gotcha-equivalent-mutant-vs-uncovered-branch`. Green here is a theorem, not
a gap — do not reject on it.

## Verbatim extraction, proved not asserted
`git show b6f6f52:scope-git.ts | sed -n '223,239p'` diffed against
`sed -n '19,35p' scope-git-classify.ts` differs on ONE line, the signature.
Spawn discipline intact (`shell:false`, `maxBuffer`, `timeout`, `windowsHide`);
`hermeticGitEnvironment` 0 hits in the diff.

## Foreign red at HEAD (still open for someone else)
Repo-wide `pnpm test` exit 1: `tests/fault/foundation/j1-linear.test.ts:225`
expected `PRODUCTION_BEHAVIOR_ABSENT` for
`probe:scheduler-hot-claim-admission`, got `PASS_EXPECTED`. The probe
(packages/testkit/src/foundation/foundation-incident-schedules.ts:58)
interrogates `@moe/scheduler` for `admitClaim|claimWorkItem|reduceClaim`;
`2c93542` (task-e8e27f76, scheduler root exports) flipped it present. Attributed
by DEPENDENCY CLOSURE, not convenience: `grep -rl runner tests/fault
packages/testkit/src/foundation` hits only `tests/fault/vitest.config.ts`.
Repo-wide typecheck 0. **Scheduler owner must update that expectation row.**

Reusable drill harness: `%TEMP%\qa-drill-f6c9011b-r3.mjs` (argv: relFile,
needle, replacement; asserts anchor==1, restores in finally, re-hashes).
