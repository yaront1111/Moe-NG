# task-fcad40b6d26243439cd19fd3e49c924d — Planning expansion contract binding — DONE (QA APPROVED)

Approved by qa-5be1a8d6 on 2026-08-09 20:17 local. 8/8 steps. Bytes in commit **a646660**
(6 files, +1042/-17, exactly the owned paths). Hook commit 884742f carries the task id but
holds foreign `apps/daemon/src/identity/session-authority.test.ts` bytes — known hook hazard,
not a defect, not a rejection reason.

## What shipped
INITIAL/REVISION vs EXPANSION **discriminated unions under the existing exported PlanningRun
names** — no parallel authority schema. New focused leaf
`planning/planning-expansion-validation.ts` (243 lines) composes the unchanged
`validPlanningRunState` / `validSubmission` / `validEffectTerminal` over a 12-key state
projection, so `planning-validation.ts` stays byte-untouched at its 250 cap. Exact one-line LF
`.js` bridge, root-published from index.ts (runtime-entrypoint.test.ts rejects unreachable
bridges). Line counts: command 249, event 194, validator 243, index 249 — all <=250.

## QA evidence (re-measured, not trusted)
- Exact gate `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test` = **exit 0**,
  20 files / 332 tests. Ran unpiped — `cmd | tail` masks the exit code.
- All six owned paths: `git hash-object` == `git rev-parse HEAD:<path>`; owned status EMPTY.
- Two INDEPENDENT mutation drills bit at the exact code AND layer, then restored:
  1. `truthClass === "DAEMON_VERIFIED"` -> `!== undefined` — RED on HOLD_BINDING, 5 labels.
  2. dropped `runKind === "EXPANSION"` from `validExpansionCreateCommand` — RED naming
     "cross-kind: INITIAL carrying a binding" and "cross-kind: REVISION carrying a binding".
- `EXPECTED_CASE_COUNTS` is a **hand-written literal** (7 targets, 269 cases) cross-checked
  against generator arithmetic — it does NOT read the production const, so
  `mem:qa-generated-table-cannot-police-its-own-generator` does not apply here.
- Authority sweep carries a positive control (`childRef`/`graphRef`/... must all flag), so an
  empty offender list means something. `graphEpoch` is a NAMED, earned exception.

## Facts worth reusing
- `reducePlanningRun` still answers exact `PLANNING_KIND_UNSUPPORTED` for REVISION **and**
  EXPANSION. Representability != transition. Do not read this task as enabling behavior.
- `PlanningSubmissionSealed`'s legacy branch has no run-kind discriminator, so its union is
  `Base | (Base & Expansion)`. Type-level enforcement rests on excess-property checks against
  object literals; the runtime `exact()` key guard is what actually fails closed. Fine here,
  but a future consumer must not assume TS narrowing on that event.
- Focused run that actually narrows: from `packages/core`,
  `pnpm exec vitest run --root ../.. packages/core/src/expansion/<file>.test.ts` — confirm
  "Test Files 1".
- Drill restore trap: after `cd packages/core`, `git hash-object packages/core/src/...`
  doubles the prefix and reports a false failure. Verify from the repo root.

## Foreign red at approval (disclosed, NOT attributable)
1. repo-wide `pnpm typecheck` exit 1 — `apps/daemon/src/identity/session-authority.test.ts`
   TS2307 (in-flight WIP, untracked `session-authority-protocol.ts`).
2. repo-wide `pnpm test` exit 1 — `packages/scheduler/src/package-boundary.test.ts`
   "unterminated regular expression source token" on `apps/daemon/src/daemon-main.ts`
   (pre-existing shebang tokenizer defect, present in the step-1 baseline).
Neither intersects the six owned paths.

## Consumer edge
`task-93b0314e09f248118e21f92699989468` (Planning-run expansion submission child) is the
recorded composition consumer, named in code, and was BLOCKED on this contract — now unblocked.
