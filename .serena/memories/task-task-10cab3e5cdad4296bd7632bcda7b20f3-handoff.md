# Fair scheduler production — worker handoff (worker-767ae903, 2026-08-10)

DONE -> REVIEW. Commit `3e03279`. Gate `pnpm --filter @moe/scheduler test` = 41 files / 1047 tests,
exit 0 (step-1 baseline was 39 / 935).

## What landed
`packages/scheduler/src/fairness/`:
- `fairness-rotation.ts` (248 lines) — the WDRR engine.
- `fairness-rotation-input.ts` (250) — total validators only. Split from the engine purely to hold
  the 250-line target; a single file landed at 281.
- `fairness-aging.ts` (224) — compatible-opportunity aging.
- `fairness-rotation.test.ts` (57 cases), `fairness-aging.test.ts` (26), three LF `.js` bridges.
Plus `index.ts` (12 values + 6 types), `index-surface.test.ts`, `package-boundary.test.ts`.

## The objective names a source that does not contain the subject
The task objective says implement WDRR "from the corrected DEVELOPMENT_ONLY reference". It is not
there — `grep -rnw -E "WDRR|deficit|resourceQueue|ResourceQueue"` over
`packages/testkit/src/scheduler-fairness` returns nothing, and there is no `Ring` identifier.
Source of truth is the LANDED CONTRACT, which delegates rotation/deficit/aging to this task **by
name** at `fairness-ring.ts:12-20`. Do not re-derive from the reference. See
`mem:gotcha-a-task-objective-can-name-the-wrong-source`.

## Design decisions a reviewer will want justified
- **Order derived from `resourceId`** (compareStrings), never array position. `entries` is the flat
  union of all queues with no implied order BETWEEN queues (`fairness-ring.ts:54-58`); order WITHIN
  a queue IS its FIFO order and is honoured.
- **Round credits every non-empty queue, including capacity-blocked ones.** Classic DRR: blocking is
  transient, dropping credit turns a short block into lost share. This is the ONLY reason the
  round-advance overflow site exists — do not "simplify" it away or drill (c) loses half its target.
- **Residual carry, reset on empty.** A selected head spends one unit; the remainder moves to the
  next head; an emptied queue DROPS it (textbook DRR reset — stops an intermittent queue banking
  share it never used).
- **At most one round advanced per call.** Termination argument, not convenience: after one advance
  every non-empty queue holds >= its weight (the boundary refuses weight < 1 for a queue), so a
  second advance could only mean everything is blocked = idle, not stall.
- **Ceiling checked BEFORE the forced-head path.** A forced head at the ceiling REFUSES. Otherwise
  forcing is an unlimited cap bypass.

## Three guarded accumulation sites, not one
`safeAdd` ceilings at `MAX_AUTHORITY_COUNT`, NOT `Number.MAX_SAFE_INTEGER` — see
`mem:gotcha-overflow-guard-must-match-the-validator-ceiling`. Sites: round advance, residual carry,
and **summed in-flight units** (128 capacity records x ~9e15 each leaves the safe range). That third
site was in neither the plan nor my own test list; I found it writing the boundary.

## Two fail-opens found by adversarial self-review, after green
1. `bypassesToForced` is exported from the package ROOT. `indexOf` answers -1 for a class outside the
   ladder -> `(-1+1)*8` = ZERO bypasses = forced for free. Unreachable via `ageWorkItem`, trivially
   reachable by an untyped consumer. Now returns the maximum.
2. `readCapacities` accepted records for resources the ring does not declare, and their
   `inFlightUnits` were summed into the per-dimension ceiling. Now REFUSED — paired with the UNKNOWN
   used for a MISSING record: same code `UNDECLARED_RESOURCE`, disposition distinguishes verdict from
   absence. See `mem:convention-same-code-different-disposition-for-absence-vs-verdict`.

## No issue code can be minted from a consumer module
`FairnessContractIssueCode` is a closed union over a frozen tuple in `fairness-contract.ts`, which
this task does not own, and `makeFairnessIssue`/`unknownFairness` take that type. Two non-obvious
mappings, each commented in place: `UNDECLARED_RESOURCE`+UNKNOWN for a missing capacity record, and
`DISPATCHABILITY_UNOBSERVED` for a forced head that is not dispatchable (the only dispatchability
member of the tuple).

## Foreign state at handoff — all disclosed, owned intersection EMPTY
- `adapters/jetbrains` TS18003 — the whole directory is UNTRACKED with an empty `src`.
- `apps/daemon/src/recovery/recovery-key-provider*` TS2339/TS6133 — untracked, in flight.
- `tests/fault/foundation/j1-linear.test.ts` "incident:hot-claim-loop-on-gated-work" — a RATCHET that
  flips to PASS when a probed export lands. Proven foreign by reverting my `index.ts` and re-running:
  still red. Trigger is pre-existing `validateBypassClaim` (index.ts:104, task-e8e27f76) matching
  `/Claim|CLAIM/u`. See `mem:gotcha-fault-schedule-ratchet-flips-when-a-probed-export-lands`.
- Commit `fec9488` (task-14ab762d) is a foreign whole-tree commit that swept my in-progress modules.
  Not amended, not reset. Committed bytes verified == gated bytes for all 11 files.

## Plan claims that were STALE — re-measured, do not carry forward
The plan told me to disclose a known baseline red in `package-boundary.test.ts` (shebang tokenizer).
It is FIXED at HEAD (that file skips a leading `#!` at :147-156) and the baseline was fully green.
Disclosing a nonexistent red is fabricated evidence in the opposite direction.
