# task-d92b1b15a5b048e49671ed34990fa4a1 architect handoff

Approved six-step/eight-file reopen plan at HEAD `e9b379681545ed38da88da17c76f477db4f03191`.

Fresh measurements:
- All eight owned paths were clean.
- Prior d92 behavior is committed in `2e688c9`: replay filters to activation events and preserves digest comparison; real file-backed literal 6,500-event BOUND and late-second-match ambiguity tests already exist.
- `activation-ledger-reader.ts` still has the rejected unbounded `for (;;)`; a production-surface advancing fake timed out (`timeout` exit 124).
- No `readEventHorizon` exists. Add it via `EventReadModelStore` -> `DecisionLedgerCore` -> `SqliteEventStore`, using `readSnapshotOperation`, binding assertion, and lossless `CAST(COALESCE(MAX(global_position),0) AS TEXT)`.
- Daemon edge already exists in manifest + lock; after API lands, a trap-deleted in-app bare `@moe/store` probe must typecheck.
- Capture H exactly once and scan contiguously through it. Explicit QA contract: gaps, >H, premature end, or `hasMore=true` at H => literal `UNKNOWN / FOUNDATION_BINDING_SCAN_INCOMPLETE / FOUNDATION_ACTIVATION_BINDING`; thrown horizon/page => EVIDENCE_UNREADABLE. H=3 moving fake must stop after one horizon read and three pages; deleting the guard must watchdog-timeout/red.
- Preserve exactly-one activation, no early success, tail replay, >6,400 reach, and late ambiguity.
- Collision: `task-69c2c9e7ee084afea16c2b2ff935f459` owns the same four store files. Architect/governor were messaged to serialize it after d92 DONE.
- Near hard caps: reader 335 lines, sqlite-event-store 368; keep compact and <400.

Exact final gate and mutation drills are embedded in the approved plan. Performance/index follow-up remains `task-16d5bc3a10864351adf5be10dfa7df00`.