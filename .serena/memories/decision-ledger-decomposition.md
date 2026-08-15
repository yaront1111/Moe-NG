# Decision ledger decomposition (packages/store)

`decision-ledger.ts` (was 539 lines) is now a 126-line compatibility facade.
Landed as commit `9c87dc6`. Unlike the sibling read-model split
(`mem:decision-read-model-decomposition`, pure functions + ctx), this one mixes
**both** shapes: an inheritance chain for the stateful transaction/replay layers
and pure functions + narrow ctx objects for canonicalization and persistence.

Chain: `EventLedgerStore` -> `DecisionReadModelStore` -> `DecisionReplayStore`
-> `DecisionTransactionStore` -> `DecisionLedgerStore`.

- `decision-ledger-canonical.ts` (236) — request/metadata/proposal snapshots,
  `identifyDecisionRequest`, `planDecision`, `lockedDecisionProposal`,
  `commitAcceptedDecisionEffect`, `commitRejectedDecisionEffect`. Effect writers
  take `DecisionEffectContext { assertAggregateTail, writeCommitEffects }`.
- `decision-ledger-record.ts` (183) — both decision SQL statements,
  `writeCanonicalDecision` over `DecisionRecordContext { prepare }`.
- `decision-ledger-replay.ts` (55) — `DecisionReplayStore` with only
  `protected reconcileHistoricalDecision` (moved verbatim).
- `decision-ledger-transaction.ts` (201) — `DecisionTransactionStore` with
  `commitExpectedVersionDecision` control flow.
- Each has a committed one-line `.js` shim. None reaches `index.ts`; zero
  importers outside these four modules.

## Invariants that must survive future edits

- **Reserved-namespace and project-scope checks must stay BETWEEN
  `snapshotDecisionRequest` and `identifyDecisionRequest`.** Folding the snapshot
  and identity derivation into one call would let digest work throw ahead of the
  `INVALID_INPUT` reserved-namespace rejection. No test catches the reorder.
- **`commitAttempted` must be set BEFORE `exec("COMMIT")` and both must stay
  inside the transaction try.** It lives on a per-call mutable `DecisionAttempt`
  object so `commitAndRespond` and the catch share one value. If COMMIT succeeds
  without acknowledgement, `commitAttempted && !isTransaction` is the only signal
  that distinguishes OUTCOME_UNKNOWN (poison) from an ordinary rolled-back
  failure. `transactionEndedAfterCommitAttempt` must be computed BEFORE the
  rollback attempt.
- **`toCommandDecisionResponse` stays inside the try**, as at HEAD — moving it
  out changes how a post-COMMIT failure classifies.
- **`lockedDecisionProposal` must use `??`**, never re-snapshot unconditionally:
  caller bytes are hostile and must be read at most once per path.
  `plan.proposalFailure` is consulted ONLY on the accepted branch — if the locked
  version moved, the stored failure is intentionally ignored.
- Effect selection uses explicit `if/else` with a named `effect`, not
  argument-position evaluation, so the write order is not implicit.
- `identifyDecisionResult` is computed once in `writeCanonicalDecision` and
  shared by the insert bind and the pending record.
- Error messages and check ORDER are **not test-observable** (suites match
  `DurableStoreError` codes only). Verbatim movement is the sole guard.

## Proof techniques that worked here

Beyond the diff-vs-HEAD trick in `mem:gotcha-verbatim-move-refactor-proof`, a
**string-literal set diff** is the cheapest way to prove no stable error text was
reworded across a split into many files: collect every `"..."` and `` `...` ``
from the HEAD file and from the union of the new files, then report
`head - new` and `new - head`. Filter to length > 12 and drop `./`/`node:`
prefixes to suppress import noise. Remaining false positives are backtick-regex
spans across import statements — verify those individually.
