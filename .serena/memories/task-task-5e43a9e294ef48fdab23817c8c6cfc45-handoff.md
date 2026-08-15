# Handoff: task-5e43a9e294ef48fdab23817c8c6cfc45 (Foundation daemon ingress surface)

## Status
**BLOCKED at planning** 2026-08-09 by architect-cb476f76. No plan submitted. Escalated to
@governors (no live architect). Detail posted to #general msg-fe5e73d8f8f0466f8897e429c7103bce.

## Why (measured, not read from the description)
Zero of five hard dependencies DONE; four of six required surface families absent on disk.

| Dependency | Status |
|---|---|
| task-5855a9c6 recovery continuation binding | WORKING (in flight) |
| task-6cbff010 attempt dispatch | BLOCKED |
| task-44d4873e verification receipt dispatch | BLOCKED |
| task-8f9305b9 review-qualified goal closure | BLOCKED |
| task-4afcb064 coordination adapter | PLANNING |

Six families DoD 1 demands at the `@moe/daemon` root:
1. **review — PRESENT.** `runReviewCommand` `review/review-services.ts:177`,
   `readReviewLedger` `review/review-read-model.ts:153`. index.ts exports `REVIEW_HANDLERS`
   (:172) + contract/ledger types (:186, :198) but **not** the two executables. Only publishable one.
2. **recovery continuation — PRESENT BUT IN FLIGHT.** `recovery/continuation-service.ts` exists;
   task-5855a9c6 is editing those exact files now.
3. **attempt dispatch — ABSENT.** `work/` has only claim, ingress, kernel, lease, lifecycle,
   slot-ceiling.
4. **verification receipts — ABSENT.**
5. **review-qualified closure — ABSENT.** `goals/` has only `goal-services.ts`.
6. **coordination ops — ABSENT, 3 links deep.** `apps/daemon/src/coordination/` does not exist.
   Chain: task-4afcb064 <- task-04e43674 <- task-21713cf1 <- task-b4f12e63.

## Why no narrowed plan
DoD item 2 requires **exact root namespace SET EQUALITY**. That is unwritable four families short —
you cannot assert the complete set while omitting four. Publishing review-only satisfies *none* of
the DoD, not part of it. Project rail Clause 2 forbids the narrowing independently. Did not create
prerequisite tasks: all five already exist on the board; more would be silent duplicates.

## Corrected premise for whoever re-plans this
Description says `apps/daemon/src/index.ts` "is already 249 lines". **`grep -c ''` measures 317** —
67 past the 250 target *before* this task adds anything. So the scoping premise ("extract
foundation-surface.ts rather than grow index.ts past target") is wrong: index.ts must itself be
split. That is a materially larger job than the description buys. Re-scope, do not just re-promote.

## Sequencing hazard
`task-8470a860` is in flight against `apps/daemon/src/index.ts` and `index-surface.test.ts` — two of
this task's five owned paths. `task-5855a9c6` is in flight against `recovery/continuation-service.ts`,
which family 2 must publish. Re-promoting before both land puts three agents in the same files in
one shared working directory (epic rail 2).

See `mem:decision-set-equality-dod-cannot-be-partially-satisfied`.
