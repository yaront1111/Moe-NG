# Worker handoff: Canonical goals board (task-c8b625ddf39c4225903e34284a3affcb)

Worker `worker-023d39fd`. All 8 steps done. Gate `pnpm --filter @moe/control-room typecheck && pnpm --filter @moe/control-room test` exit 0, **25 files / 369 tests** (step-1 baseline was 16 / 221; the delta is my 3 files / 45 tests plus the recovery+doctor sibling files that landed concurrently).

## Shipped (9 declared paths, all present)

| file | lines |
|---|---|
| `goals/supplied-actions.tsx` | 64 |
| `goals/goals-home.tsx` | 248 |
| `goals/goals-home.test.tsx` | 343 (20 tests) |
| `board/board-contract.ts` | 105 |
| `board/board-card.tsx` | 85 |
| `board/board-surface.tsx` | 249 |
| `board/board-layout.css` | 77 |
| `board/board-surface.test.tsx` | 399 (19 tests) |
| `board/goals-board-ban.test.ts` | 156 (6 tests) |

`goals-j1.tsx` (SHA `37590E48…F34580`) and `board-j1.tsx` (`49DC3A41…472170`) are byte-identical to the pre-task state.

## Design decisions a reviewer will ask about

- **Placement, never a phase fold.** Each card carries `sourceAggregate` (opaque), an exact `phase` fact, and a separately supplied `placement: plan|ready|executing|review|accepted|terminated|null`. The corpus deliberately contains two cards spelling `READY` in different aggregates/lanes and one card with phase `EXECUTING` placed in `plan`. `placement: null` goes to `cr.board.unmapped`, never guessed.
- **Ready collapse is authoritative-only.** `isCollapsed = !loading && loadedEmptyColumns.includes(col) && lane.length === 0`. Absence of data is unknown; unknown never collapses. `isCollapsed()` is computed once in `BoardSurface` and passed to `Column` AND used for the keyboard's visible-lane set, so the two cannot drift.
- **`SuppliedActions` is the only mutation control.** Reads `useGating()` once, filters on strict `targetAggregateId` equality plus an optional caller-requested kind (narrow only, never widen), uses `actionsEnabled` verbatim, reuses the shell's `actionTestId`, and hands back the ORIGINAL frozen `NextAllowedCommand`. `NextAllowedCommand` has no reason and no audience field — so a missing command is ABSENT, not a guessed refusal, and the UI may not classify `work.*` / `step.*` itself.
- **Presentation contracts, not wire DTOs.** No rich goal/board response schema exists; the generated client has compat-gated request builders and the live adapter narrows responses to generic `ViewRecord`. Nothing here parses daemon JSON.
- **Goal creation prefill comes only from supplied policy** (`creation.budget` / `creation.risk` / `creation.riskOptions`). The ban test forbids the literals `"50"` and `"normal"` in canonical production so the J1 client-authored default cannot come back.

## Test ids worth knowing

`cr.goals.row.{goalId}`, `cr.goals.link.{goalId}`, `cr.goals.list|filter|search|skeleton|empty|asof|form|create|policynote`, fact ids `goal.{goalId}.<16 suffixes>`.
`cr.board.column.{col}`, `cr.board.column.{col}.collapsed`, `cr.board.empty.{col}`, `cr.board.card.{nodeId}`, `cr.board.actions.{nodeId}`, `cr.board.unmapped|terminated|columns|columnjump|joinstrip|frontier|asof|skeleton`, `cr.board.filter.terminated`, fact ids `node.{nodeId}.<23 suffixes>`, `frontier.{LANE}.{summary|cursor|graphepoch|idlecapacity|readiness}`, `join.{joinId}.{summary|inputs}`.

## Gotchas for the next agent

- **`cr.board.card.silence.{nodeId}` shares the `cr.board.card.` prefix** (spec §2.2's own id). Anything counting cards by that prefix must exclude it — the tests do.
- Card title is `cr.board.cardtitle`, deliberately NOT `cr.board.card.title`, for the same reason.
- A blank `nodeId` renders as `cr.board.card.UNKNOWN` via `readIdentity`; duplicates render twice (index-qualified React keys). Nothing is deduped or dropped.
- `board-surface.tsx` imports `./board-layout.css`, which needs the `/// <reference types="vite/client" />` line at the top or tsc raises **TS2882**. The ban test asserts the type-reference set is exactly `["vite/client"]` so that line cannot become a hole in the import scan.
- CSS assertions read the file from `process.cwd()` (= `apps/control-room` under the app-scoped vitest run) because jsdom does not evaluate viewport media queries.

## Mutation proof (step 7)

8 one-at-a-time mutants, all KILLED, all restored byte-exact by SHA-256. Each drill ran its named test unmutated first and required a `Tests N passed` line, so no drill could pass against a filter matching nothing. Covered: target-filter removal, placement relocation, missing-fact upgrade to `DAEMON_VERIFIED`/`0` (board and goals), renewal/activity silence merge, terminated-default inversion, loaded-empty Ready guard removal, horizontal-navigation row-0 bug.

One real defect found and fixed in review: the column-jump control returned early on an empty lane, so picking an empty column silently did nothing and the select snapped back. Cursor now moves regardless.

## Known, deliberate, not defects

- The creation draft does not re-seed when policy defaults change mid-session (re-seeding would destroy operator input).
- Two supplied commands of the same kind against the same aggregate produce two identical `cr.action.*` ids; React keys on `commandId` so both render. Hiding one would hide a real affordance.

## Commit situation — read this before auditing history

Eight of the nine files were swept into HEAD by **other agents' whole-tree commit hooks** before this task reached its commit step: `a6e46f6` (the three goals files), `5a63049` (board-contract, board-card), `2735f2b` (board-surface, board-layout.css, board-surface.test.tsx, goals-board-ban.test.ts). Only the post-sweep column-jump fix remained, committed by explicit pathspec as **`82f4a35`**. So `git show --stat HEAD` for this task shows ONE file — that is not a partial delivery. See `mem:mutation-drills-in-shared-worktree` and `mem:gotcha-test-count-drift-from-uncommitted-foreign-file`.
