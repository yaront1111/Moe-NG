# Graph revision test fixture extraction — DONE (content lives in foreign commit 5a57b2a)

Task `task-cefb2442deda44fcb0e62ca8bbbcd27b`, handed to QA 2026-08-08.

## What landed

- NEW `packages/core/src/planning/graph-revision-test-fixtures.ts` — 96 lines.
- `packages/core/src/planning/graph-revision-reducer.test.ts` — 288 -> 222 lines.

Baseline test lines 17-93 (hash(), GRAPH/PLAN/QUALITY/BUDGET/POLICY/STALE_HASH,
BINDING/SUBMISSION/APPROVAL/ACTIVATION/REJECTION, BOUND, state, commandFor,
expectError, expectIllegal, accepted) moved with only `export` added. Fixtures
import `expect` from vitest plus 5 type-only names from
`./graph-revision-contract.js`. RUNTIME_LIFECYCLES is NOT needed there — the
moved code never used it; it is used only in test bodies.

Two lines were re-wrapped because `export ` pushed them past the repo's 100-col
ceiling: `APPROVAL` (ACTIVATION's existing wrap style) and `commandFor`'s
signature (one param per line, `state()`'s style). Whitespace-normalized diff vs
the pre-change oracle differs by exactly ONE char — the trailing comma the
param wrap adds. Test bodies (base 95-288 vs now 29-222) are byte-identical.

Test header pruned `GraphRevisionCommandKind` and `GraphRevisionReducerResult`
(unused post-move); the other 3 contract types stay.

## Audit numbers worth reusing

- 18 `it()` declarations, 18 executions in isolation — sorted it()-line list
  identical to baseline; zero skip/only/todo.
- 18 fixture exports, overlap with `packages/core/src/index.ts` = 0. Only
  importer in the repo is the owned test file.
- `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` = exit 0,
  14 files / 226 tests (13 before task-ca32f538's split file landed mid-window).
- Root vitest `include: ["packages/**/*.test.ts", ...]`, so a `*-test-fixtures.ts`
  module is never collected as a suite. Precedent for the convention:
  `packages/scheduler/src/test-fixtures.ts`.
- No linter in this repo (no eslint/biome/prettier config) — the 100-col limit
  is convention only, observed as the max line length in core sources.

## QA pointer — there is no commit named for this task

Commit `5a57b2a` `feat(task-bfc395429d9d4b61b91e51e4f3bbe166): Projection commit
seam on the event transaction` swept both owned paths (the fixtures file was
still untracked) plus task-ca32f538's three files. Not reset/reverted/amended,
per `mem:gotcha-shared-index-commit-capture`. My delta afterwards is zero.

Review range:
`git diff a45b161..5a57b2a -- packages/core/src/planning/graph-revision-reducer.test.ts packages/core/src/planning/graph-revision-test-fixtures.ts`

## Known foreign red (not mine)

`packages/scheduler/src/package-boundary.test.ts` fails on task-ca32f538's
`planning-run-test-fixtures.ts` line 4 — see
`mem:gotcha-boundary-test-greps-prose-not-imports`. Repo gate is 1 failed / 112
passed because of it. My two paths contain zero `scheduler` occurrences.

## Follow-on

This was the LAST of the five mechanical decomposition children, so the
"Planning source size guard" closing-gate task (directory-wide <=250) is now
plannable — the whole `packages/core/src/planning` tree is under the cap.
