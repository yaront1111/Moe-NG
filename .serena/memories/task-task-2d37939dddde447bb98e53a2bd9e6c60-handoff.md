# task-2d37939dddde447bb98e53a2bd9e6c60 — QA APPROVED 2026-08-14 (qa-50f0d628)

Supersedes the worker handoff of the same name. Task is DONE. Branch moe/work-2026-08-08.

## What shipped
`packages/scheduler/src/expansion/expansion-current-hold.ts` (250 lines) — the SOLE producer of a
core `PlanningExpansionHoldBinding`. Owns EXPANSION_BINDING_ORIGINS/_ISSUE_CODES/_LAYERS,
ExpansionBindingIssue (new nullable `target`), ExpansionBindingRefusal, ExpansionCurrentAuthority,
ExpansionCurrentHoldRequest/Result. `expansion-binding.ts` 291 -> 141, now COMPOSES.
Root exports 85 -> 86 (`bindCurrentExpansionHold`) plus type-only re-exports of core
`ExpansionPlanningHoldState` / `PlanningExpansionHoldBinding`.

## How I verified (reusable recipe for this board)
- Base-ref diff, NOT a commit search: `git diff d7a71cb..HEAD -- packages/scheduler/`
  = exactly the 6 owned paths, 990+/222-. Commit **71ae334** bears this task id but carries
  FOREIGN bytes (recovery-inventory-*); the real bytes were swept by 7dbf9ba and 6ffb4fe.
  Per project rail this is neither a defect nor a rejection reason.
- `git status --porcelain -- packages/scheduler/` empty => gated bytes == committed bytes.
  Do this BEFORE running the gate or the run proves nothing about HEAD.
- Gate re-run fresh, foreground: `pnpm --filter @moe/scheduler typecheck && pnpm --filter
  @moe/scheduler test` exit 0, **43 files / 1319 tests** — matches the worker's claim exactly.
  Repo-wide `pnpm typecheck` exit 0 too.
- Old bytes read with `git show d7a71cb:<path>` to prove the second mapper was DELETED, not
  left dormant. Reading only the new file cannot tell you that.

## My own two mutation drills (do not trust the worker's list alone)
1. `inspection.target` -> `null` in `holdBindingOf`: reddened EXACTLY the two target tests
   (current-hold + index-surface delegated-inspector).
2. `current.planningRunRef !== hold.planningRunRef` -> `!== current.planningRunRef` inside the
   PRODUCER: reddened BOTH the direct test AND the ADMISSION test. That second red is the proof
   of composition — a hand-rolled duplicate mapper in the composer would have stayed green.
Both restored by `git checkout --` (safe here only because the file was clean at HEAD) and
verified by `sha256sum -c`.

## The one behaviour delta, accepted deliberately
Hold-backed comparisons now run inside the producer, i.e. BEFORE the admission-only goalVersion
fence. A compound `goalVersion`+`holdId` fault now answers HOLD_ID_MISMATCH where it used to
answer GOAL_VERSION_MISMATCH. **Not a DoD violation**: it is structurally forced by the API the
architect chose (`{currentAuthority,hold}` has no `preparation.bound` operand), every ISOLATED
fault keeps its exact old code/layer/origin, and it is pinned in PRECEDENCE_CASES with the reason
in a comment. Disclosed + pinned + forced = accept; silent = reject.

## Design fact a future consumer must know
`ExpansionPlanningHoldState` carries NO `goalVersion`. The standalone binder does not authenticate
`currentAuthority.goalVersion` against the hold — it domain-checks it and lets core's HOLD_BINDING
inspector judge. The equality fence lives in `bindExpansionAdmission` against `preparation.bound`.
A daemon-only consumer with a bound goal version MUST fence it itself.
See `mem:decision-current-expansion-hold-goal-version-boundary`.

## Downstream
Consumers: `bindExpansionAdmission` (landed edge), task-c4171c1cfe854cb78dd233794b342025, and
task-738a12a816e8421a96edd84648565a38 as the durable daemon consumer.
