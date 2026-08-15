# QA verdict task-386fcb4c — @moe/core `.js` runtime bridges: **APPROVED**

Reviewed by `qa-017ee6b6` 2026-08-09 against commit `3e7081d`. Every number in the
worker's evidence was **re-derived independently**, not read back. Handoff:
`mem:task-task-386fcb4c6d0241289f177cec9a3010e8-handoff`.

## What I re-ran myself (not trusted from the summary)

- **Independent reachability audit** (my own walker, not the test's): `nonTest=34`,
  `runtimeReachable=30`, `bridgesOnDisk=30`, `MISSING=0`, `UNEXPECTED=0`,
  `holes=[]` (every reachable target is a real `.ts`, so the closure did not stop
  short). `excludedNonTest` = exactly the four planning modules.
- **Committed-BLOB byte sweep** (`git show HEAD:<path>`, not the worktree):
  `SWEPT=30 BAD=0` — each file's length independently computed from its OWN
  basename, `cr=0`, last byte `0a`, content string-equal to
  `export * from "./<own-name>.ts";`. Mis-targeted bridges cannot survive this.
- **Sweep self-test**: fed the checker a CRLF file outside the repo, it said BAD.
  A sweep that has never failed is not evidence (`mem:gotcha-bash-tool-mangles-dollar-quoted-cr-pattern`).
- **Plain-Node probe**, Node v24.16.0, repo root: POSITIVE 39 exports / 0 undefined;
  REGRESSION scheduler 36, store 26, runner 66; NEGATIVE **all four** test-only paths
  raise the literal `ERR_MODULE_NOT_FOUND`. CONSUMER `import("@moe/core")` from
  `apps/daemon` cwd through the real exports map: 39 / 0.
- **Gate**: `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0,
  **16 files / 239 tests** (was 15 / 235; the new file holds exactly 4 `it`s, so the
  delta is arithmetically consistent).

## Four mutation drills — I ran them, all killed

Epic rail 6 says verify a failure-path test by mutating the production surface.

| Drill | Result |
|---|---|
| delete `project/project-reducer.js` | 2 red (Node probe + audit `missing`) |
| bridge `planning-invariant-drivers.js` | 2 red (audit `unexpected` + test-only guard) |
| flip `goal/goal-reducer.js` to CRLF | 1 red (audit `wrongContent`) |
| bridge `planning-run-test-fixtures.js` (**the negative control's own subject**) | 3 red, incl. the `ERR_MODULE_NOT_FOUND` assertion itself |

Drill 4 is the one that matters most: it proves the reason-code assertion is live
rather than a second layer answering first. Each restore verified by BYTES plus a
re-green run — `git status` alone cannot confirm a restore here
(`mem:mutation-drills-in-shared-worktree`).

## Zero behaviour change, proven across the whole task span

`git diff 5d77dde HEAD -- packages/core/**/*.ts` lists ONE file: the new
`runtime-entrypoint.test.ts`. `index.ts` untouched. `packages/core` has not drifted
since `3e7081d`.

## Noted, NOT a rejection reason: `a6e46f6`

`a6e46f6` is an automated **whole-tree wrapper commit** titled with this task's id
and Title (capitalised "Add"; the worker's own is lowercase "add"). It sweeps 65
foreign files — control-room, daemon, context, review, `tests/runtime`, `.moe` board
state. It contains **zero `packages/core` files**, so it did not touch this
deliverable. The worker's own commit `3e7081d` is pathspec-clean: 26 `.js` + 1 test,
no foreign path. Same pattern exists for other tasks (`c699422`/`5d77dde` for
`task-e17da1c9`), so it is harness behaviour, not worker behaviour. Full write-up:
`mem:gotcha-wrapper-whole-tree-commit-mislabels-task-ownership`.

Also expected: the test shows as **M** not **A** in `3e7081d` because foreign
whole-tree `c699422` swept the in-progress file first.

Related: `mem:gotcha-core-bridge-set-needs-reachability-not-name-or-closure`,
`mem:gotcha-vitest-hides-missing-js-bridge`.
