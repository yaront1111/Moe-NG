# Gotcha: @moe/store — adding a method to the ledger class does NOT reach SqliteEventStore

Cost a plan correction on task-bfc39542 (projection commit seam). The task description,
written after two adversarial verification rounds, still asserted "a new inherited method
needs NO decision-ledger.ts edit". It was wrong.

## The shape
`SqliteEventStore` (sqlite-event-store.ts) holds `readonly #core: DecisionLedgerCore` and
every public method is a one-line delegate over it. `DecisionLedgerCore` is NOT a class:
decision-ledger.ts declares it as an explicit `interface` (:36-71) and
`createDecisionLedgerCore` returns `Object.freeze({ commit: (input) => ledger.commit(input),
... })` (:87-128) — a frozen object literal of arrow delegates.

The class chain behind it is real and deep:
DecisionLedgerStore -> DecisionTransactionStore -> DecisionReplayStore -> ... ->
DecisionReadModelStore -> EventLedgerStore -> EventTransactionStore -> EventRecoveryStore ->
EventAppendStore -> EventOutboxStore -> StoreRuntime.

But nothing is forwarded implicitly. A new public method anywhere on that chain is invisible
to `#core` until you add BOTH:
1. a member on the `DecisionLedgerCore` interface, and
2. a matching delegate entry in the frozen literal (keep the existing ASCII ordering —
   `commit`, `commitExpectedVersionDecision`, `commitWithApply`: 'E' 0x45 < 'W' 0x57).

## Why it bites
It typechecks silently in the wrong direction: the method exists on the class, so unit-level
reasoning says "done", and the failure only appears when you call it through the public
`SqliteEventStore` surface. Budget the extra file when planning any store method.

Related: the `.ts` sources have stale sibling `.js` files in packages/store/src — ignore them,
the build does not use them.
