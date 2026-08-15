# Decision read-model decomposition (packages/store)

`DecisionReadModelStore` (was 553 lines) is now a 165-line coordinator class over
three internal modules. Landed as commit a92f1b5. Unlike the sibling event-read
split (`mem:decision-event-read-model-decomposition`), which used an inheritance
chain, this one uses **pure functions + a narrow context object** — the class
still extends `EventLedgerStore` directly.

- `decision-read-sql.ts` (106) — the six decision SQL statements as constants.
  `STORED_COMMAND_DECISION_SELECT_COLUMNS` is the shared 30-column list; the
  by-key and by-position statements compose from it plus their distinct WHERE.
  All six are byte-identical to the pre-split originals (proven, see below).
- `decision-read-decode.ts` (319) — `decodeStoredCommandDecision(row, ctx, flag)`
  plus the `DecisionDecodeContext` interface. Body moved verbatim.
- `decision-read-pages.ts` (67) — `materializeDecisionCursorPage(...)` returning
  `{ hasMore, items, nextCursor }`. The class still calls `this.page(...)` itself,
  so page freezing stays on the class.
- Each has a committed `.js` shim (`export * from "./<name>.ts";`). None of them
  reaches `index.ts`; there are zero importers outside `packages/store/src`.

## Invariants that must survive future edits

- **`liveBindingAlreadyValidated` is an explicit PARAMETER, never part of ctx.**
  It is `true` only on the paging path (`loadByPosition` closure) and `false` on
  the by-key and startup-scan paths, and it gates `assertLiveProjectBinding`
  inside `loadReceipt`. Folding it into ctx silently changes corruption-check
  semantics and NO existing test observes the drift.
- **`materializeDecisionCursorPage` must be called from inside
  `readSnapshotOperation`.** The candidate query is passed as an inline argument
  precisely so query + per-position loads + `assertReadPageCursors` share one
  `BEGIN DEFERRED`. Hoisting the query out splits the snapshot invisibly to the
  single-connection test suite.
- **`DecisionDecodeContext` has exactly 5 members**: projectId,
  requireStoredVersion, loadReceipt, assertAggregateTail, loadRejectionAuditRow.
- Ctx is built fresh per decode call from arrow closures over protected ancestor
  methods, so it late-binds through the prototype chain (a concurrent refactor of
  an ancestor cannot stale-snapshot it). `projectId` is captured by value, which
  is safe only because it is `protected readonly`, assigned once in
  `StoreRuntime`'s constructor — do NOT cache the ctx on the instance if that
  ever changes.
- Error messages and check ORDER inside the decoder are **not test-observable**
  (tests match `DurableStoreError` codes only). Verbatim movement is the sole
  guard; rewording or reordering breaks the "stable errors" rail undetectably.

`requireStoredVersion` must be declared on ctx as a generic arrow
(`<const Version extends string>`) or the literal version types stop flowing into
the `StoredCommandDecision` literal fields and typecheck fails.
