# Budget settlement reconciliation — DONE, in REVIEW (commit 4f9c119)

`packages/scheduler/src/budget/budget-settlement.{ts,js,test.ts}` on `moe/work-2026-08-08`.
SPIDR 17.05, final budget child. Consumes 17.01-17.04 byte-unchanged. Sizes from HEAD:
**250 / 245 / 1** — production is AT the cap, zero margin, same as every sibling.

## Surface

- `settleReservation(view, reservation, {measurements}, {expectedViewVersion, expectedReservationVersion, prior})`
- `reconcileSettlement(view, settlement, {measurements, neverStartedProofRef}, {expectedViewVersion, expectedSettlementVersion})`
- `conservativeSettle(view, settlement, {…same, acknowledgementRef, enforceableUpperBound})`
- `closeSettledView(view, settlements, {expectedVersion})`
- `deriveSettlementId(reservationId)` = `settlement:<len>:<reservationId>`, exported so tests
  assert identity against production rather than a test-local reimplementation.
- `BUDGET_SETTLEMENT_ISSUE_CODES` (16), `SETTLEMENT_STATES` (QUARANTINED|SETTLED|WRITTEN_OFF),
  `LINE_DISPOSITIONS` (EXACT|LOWER_BOUND|UNKNOWN_HELD|CONSERVATIVE_WRITE_OFF|NEVER_STARTED_REFUND).
- NOT exported from the package root (out of scope, same as every budget sibling).

## The three compactions that made 4 ops fit 250 lines

Without these the file was 329. Do not "improve" any of them back — there is no room.

1. **One `dispose(meter, hold, credited, from, reading)`** shared by settle and reconcile. The key
   insight: **a reconcile receipt quantity is the TOTAL measured use for that meter**, so the
   committed delta is `quantity - credited`, and settle is just the `credited = 0` case. This is
   also the only reason `MEASUREMENT_CONFLICT` (receipt below the already-committed lower bound)
   is expressible at all.
2. **One `openQuarantine(view, settlement, cmd, extra)`** preamble for reconcile / conservative /
   close-adjacent logic: read the settlement, require state QUARANTINED, run op-specific `extra`
   checks, then the shared fence, then INSUFFICIENT_QUARANTINED.
3. **One `fence(view, version, expectedView, expected)`** emitting the COUNTER_EXHAUSTED +
   STALE_VERSION pair for all four ops. Plus the 17.03 tricks: messages DERIVED from the code
   string, ordered `Check` tuple tables with `firstOf`.

## Published precedence — DO NOT REORDER without updating tests

settle: MALFORMED > IDENTITY_MISMATCH > NOT_ACTIVATED > COUNTER_EXHAUSTED > STALE_VERSION >
UNCORRELATED > DUPLICATE_METER > UNKNOWN_METER > INSUFFICIENT_RESERVED > **ALREADY_SETTLED last**
(the prior check is byte-identity against the freshly computed candidate, so it *cannot* run
earlier).

reconcile/conservative: MALFORMED > ALREADY_SETTLED (state must be QUARANTINED) > op-specific
extras (EVIDENCE_AMBIGUOUS / ACKNOWLEDGEMENT_MISSING / the receipt-arm checks) > COUNTER >
STALE > INSUFFICIENT_QUARANTINED.

## Decisions a reviewer or successor must know

- **`stateOf` is stricter than "any quarantined units".** SETTLED requires every line to have
  `quarantined === 0` AND a resolved disposition (EXACT / CONSERVATIVE_WRITE_OFF /
  NEVER_STARTED_REFUND). A PARTIAL line whose remainder happens to be zero therefore still reads
  QUARANTINED instead of silently closing an unresolved measurement.
- **`SettlementRecord.overrun` is CUMULATIVE for the reservation.** Reconcile carries prior
  entries forward. That is right for the design 610-613 equation, which is measured against the
  original authorization, not per step — but a per-step conservation check must subtract the
  pre-existing entries. No test pins this because every tested reconcile starts from an
  overrun-free hold. OVERDRAWN is decided by overrun-array **growth**, not non-emptiness, so it
  stays correct across reconciles.
- **conservativeSettle requires acknowledgementRef AND the boolean bound classification as ONE
  evidence requirement** — recovery matrix line 1039 names both ("human acknowledgement plus
  known bound/unknown-liability classification"), so a missing classification is an
  ACKNOWLEDGEMENT_MISSING, not a separate code. No policy is re-evaluated.
- **An empty receipt array is not evidence.** Found by adversarial probe: reconcile originally
  accepted `measurements: []`, returned ok, moved nothing and burned a view version. Now refuses
  EVIDENCE_AMBIGUOUS. In **settle**, by contrast, an empty array is valid and quarantines every
  hold — that is the fail-closed reading there (nothing measured, so hold everything).
- **closeSettledView takes SettlementRecords, not liability refs**, so path 4 ->
  CLOSED_WITH_UNKNOWN_LIABILITY is structural. OVERDRAWN and already-CLOSED both refuse; the
  design gives OVERDRAWN no close exit. Every op, including close, bumps `view.version` by 1.
- **SETTLING is deliberately unused** — a ledger-level lifecycle needing account-wide knowledge
  this narrow view lacks.

## Mutation evidence (epic reason-code rail)

**12 mutations, 12 RED, zero survivors**, out-of-tree backup + `git hash-object`-verified restore
after every one. Highest value: UNKNOWN laundered to a zero-committed EXACT reddens 17 of 46;
dropping the view version bump reddens 8. Mutation 8 had to be rewritten from the plan's wording —
"never-started arm also refunds COMMITTED" moves *nothing* on an UNKNOWN hold (that line's
committed is 0) and would have survived; refunding **out of** COMMITTED instead of QUARANTINED is
the mutation that actually exercises design exit 2, and the separate never-started-vs-committed
`MEASUREMENT_CONFLICT` guard is what stops an already-spent `attempt.count` being refunded at all.

## Known limitations, stated not hidden

1. Pure-function concurrency caveat, same as 17.03: two competitors settling from the same stale
   view both succeed in isolation. Probed and confirmed — the loser applied to the winner's
   successor view refuses STALE_VERSION. The version fence + `prior` is the CAS seam; the store
   enforces at-most-one.
2. `deepFreeze` on the result freezes the caller's view, and `readSettlement` does not clone line
   objects, so accepting a reconcile also freezes the caller's untouched line objects.
3. A reservation meter absent from the view refuses INSUFFICIENT_RESERVED, not UNKNOWN_METER
   (`bucketOf` misses default to -1). Fail-closed but different from the sibling.
4. Amounts are bounded to safe integers individually, but a committed bucket can reach
   MAX_SAFE_INTEGER, so a subtree sum past 2^53 loses precision. Same as the landed ledger.
5. `prior` is only shape-checked with `isPlainRecord`; it must JSON-stringify byte-identically to
   the computed settlement to be returned, so a forgery cannot move units.
6. A pure module cannot force close to be handed *every* settlement of the account.

## Verification

Pinned gate exit 0, 46/46, run fresh after the commit. `pnpm --filter @moe/scheduler test` exit 0,
31 files / 519 tests. Predecessors untouched (last touched by 05b0dbf / 1125ed6).
**The commit contains 2 paths, not 3** — see `mem:gotcha-shared-tree-foreign-red-and-swept-commits`:
foreign commit `0e4903a` swept all three files into ITS commit at their intermediate 329-line
state, and the 1-line `.js` bridge was swept already byte-identical to its final form.
