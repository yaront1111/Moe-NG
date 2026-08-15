# task-069853689ed643988cfec2d689f7edb7 (Scheduler supersession dispositions) — DONE, in REVIEW

Worker worker-767ae903, 2026-08-10. Two commits: `72d7fb5` (manifest edge) and `6fa5c77` (the slice).
Gate `pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test` exit 0, 39 files / 935 tests.

## THE BLOCK THAT KILLED TWO PRIOR SESSIONS IS CLOSED
This task was BLOCKED twice because `packages/scheduler` had no dependency edge to `@moe/core` or
`@moe/contracts` (TS2307 on both bare specifiers). Governor-42b952c9 authorised option (C) on human
direction: add both `workspace:*` deps to `packages/scheduler/package.json`, `pnpm install`, commit
ONLY that manifest plus `pnpm-lock.yaml`. Done at `72d7fb5`. `packages/scheduler/node_modules/@moe/`
now holds context, contracts, core. **`mem:gotcha-scheduler-has-no-core-or-contracts-dep` is now
STALE on its "it is deliberate" conclusion** — the boundary suite positively permits the import
(`package-boundary.test.ts:265` lists `import { decode } from "@moe/contracts";` in allowedContentCases).
The prose in `budget-measurement.ts:15` / `budget-reservation.ts:13` still says "no @moe/core import by
design"; that is now a per-module choice, not a package-wide wall.

## What landed (packages/scheduler/src/supersession/, 4 sources + 4 .js bridges + 1 test)
- `supersession-disposition-contract.ts` (232) — vocabularies, shapes, the frozen
  `SUPERSESSION_BOUND_DISPOSITION_FIELDS`, THE one `digestDispositions`, `compareDispositions`,
  `classOfKind`, `disposeFamily`, `sealDispositionSet`.
- `supersession-disposition-families.ts` (122) — attempt, effect, budget + `FAMILY_PRODUCERS`.
- `supersession-resource-disposition.ts` (111) — the resource family (drain + release + capacity).
- `supersession-dispositions.ts` (108) — orchestrator + `carryWaitProjection`.
Root publishes 6 runtime values; `index-surface.test.ts` count went **47 -> 53**.

## Four design decisions a reviewer will ask about
1. **The SET-level node parser is structural ONLY** (exact key set, kind in vocabulary, non-empty
   nodeKey, no duplicate kind/key). It deliberately does NOT validate attemptLifecycle,
   effectsTerminal, resource or budget — otherwise each family's refusal would be pre-empted by a
   generic `INPUT_INVALID` at the SET layer and the per-layer tests would be answered by an earlier
   guard. See `mem:refusal-test-answered-by-earlier-guard`.
2. **Consumer edge runs supersession -> admission-wait**, not the reverse. `carryWaitProjection`
   calls admission-wait's own `validateIntentionalWait` and binds the validated wait's
   `ownerNodeKey`. That satisfies DoD 5 while making it structurally impossible for admission-wait to
   gain scheduling authority. Its only change is the header comment.
3. **Digest coverage is a PRODUCTION behaviour**: `digestDispositions` returns `null` when a
   disposition carries an own key outside the bound list, and `sealDispositionSet` maps that to a
   refusal. An unbound field cannot escape the hash — it refuses the whole set.
4. **Nodes are sorted BEFORE production**, not only after. Production stops at the first refusal, so
   an unsorted pass would let input arrival order pick WHICH refusal the caller sees.

## Codes and layers (all four codes exist in @moe/contracts runtime-error-registry.ts)
`INPUT_INVALID`, `PLANNING_DISPOSITION_UNKNOWN`, `STALE_LEASE`, `SUPERSESSION_CONSEQUENCE_CHANGED`,
declared `as const satisfies readonly RuntimeErrorCode[]` so an invented code is a tsc error.
Layers are per-family (`SCHEDULER_SUPERSESSION_{SET,ATTEMPT,EFFECT,RESOURCE,BUDGET}`) so "which layer
refused" is separately assertable from core's `SUPERSESSION_KERNEL`.

## Disclosures QA should expect (all deliberate, all authorised in writing)
- `packages/scheduler/package.json` + `pnpm-lock.yaml` — governor-authorised, commit 72d7fb5.
- `packages/scheduler/src/admission/admission-wait.ts` — NOT in the owned-paths line but named
  file-and-line by DoD 5 and plan step 6. Comment-only: 7 insertions / 1 deletion, zero executable.
- The test file is 549 lines. The per-file cap binds PRODUCTION sources; plan step 3 says so.
- Repo-wide `pnpm -r --no-bail test` has ONE foreign red: `apps/control-room`
  `goals-board-ban.test.ts:97` — an untracked `board-j1-manifest.test.tsx` from task-667b1085 breaks
  its exact-file-listing guard. My diff touches zero files under `apps/`.

## Plan-text corrections for the next architect
- `@moe/contracts` attempt lifecycle is at `packages/contracts/src/runtime/runtime-vocabulary.ts`
  (the `runtime/` segment), `RUNTIME_LIFECYCLES.ATTEMPT`, 12 members ending
  SUCCEEDED FAILED CANCELLED SUPERSEDED RELEASED UNKNOWN. The plan named the wrong path.
- The plan's `EXPECTED_EXPORTS.length` literal of 36 was already stale at 47 when I edited.

Related: `mem:gotcha-vitest-blind-to-missing-js-bridge-only-probe-reddens`,
`mem:gotcha-scheduler-has-no-core-or-contracts-dep`, `mem:refusal-test-answered-by-earlier-guard`,
`mem:gotcha-git-diff-is-blind-to-untracked-paths`.
