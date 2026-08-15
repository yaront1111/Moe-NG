# Planning run contract decomposition — DONE (commit 3431a56)

Task `task-866713137aee4794a51973fe4e6e3f44` implemented and committed on `moe/work-2026-08-08`.

## What shipped

`packages/core/src/planning/planning-contract.ts` (was 369 lines) split into three files:

- `planning-command-contract.ts` (216 lines) — intent side. `PlanningRunKind`,
  `PlanningRunCommandKind`, private `PlanningRunCommandBase`, all witnesses/proofs,
  `NodeSummary`, `PlanRevisionHashes`/`PlanRevisionSeal`, twelve concrete commands,
  `PlanningRunCommand` union. Only import: `import type { RuntimeTruthClass } from "@moe/contracts"`.
- `planning-event-contract.ts` (163 lines) — observation side. `PlanningRunLifecycle`,
  `PlanningRunFacets`, `PlanningRunState`, `PlanningRunSuccessorData`, private
  `PlanningRunEventBase`, eleven events, `PlanningRunEvent` union, accepted/rejected/typed-
  UNSUPPORTED results, `PlanningRunReducerResult`. Imports `RUNTIME_LIFECYCLES` (value form,
  used only in `typeof`), `RuntimeError`, and eight command-leaf types via
  `./planning-command-contract.js`.
- `planning-contract.ts` (63 lines) — type-only facade, two `export type { ... } from "./<leaf>.js"`
  blocks pinning all 51 names explicitly. No wildcard, no imports, no runtime export.

Dependency direction: event leaf -> command leaf -> `@moe/contracts`. Neither leaf imports the facade.

## Invariants any future change must keep

- The 51-name set is triple-pinned: baseline `bcdc2f6`, the facade, and the untouched
  `packages/core/src/index.ts` `export type` block (lines ~65-117). Adding a leaf export does NOT
  widen the public surface unless the facade names it — that is deliberate.
- All 7 consumers are type-only (`index.ts` uses `export type`; `planning-validation.ts`,
  `planning-results.ts`, `planning-run-submission.ts`, `planning-run-reducer.ts`,
  `planning-run-reducer.test.ts`, `planning-invariants.test.ts` use `import type`). Nothing outside
  `packages/core` imports planning-contract.
- Because nothing loads `planning-contract.js` at runtime, moving the `RUNTIME_LIFECYCLES` value
  import into the event leaf is unobservable. If someone later adds a *runtime* export to a leaf,
  re-check this.

## Verification

`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` exit 0 — 12 files, 221 tests.
No test edited. `git show --stat 3431a56` = exactly the three owned paths.

See `mem:gotcha-byte-identical-refactor-proof` for the verification technique used here.
