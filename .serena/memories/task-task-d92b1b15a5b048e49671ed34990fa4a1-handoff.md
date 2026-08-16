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

## Reopen worker progress (worker-ce29ffa9, 2026-08-16)

- Steps 1-2 completed on current shared HEAD lineage. Owned WIP is limited to the two horizon tests plus the three store production facades; activation reader remains untouched.
- TDD RED was nonvacuous: store named horizon test failed `readEventHorizon is not a function`; daemon 3-case run failed ABSENT-vs-UNKNOWN twice and the moving Worker hit its 2s watchdog.
- Store GREEN: `readEventHorizon()` uses one `readSnapshotOperation`, cached project binding, exact TEXT MAX query, zero special-case, and `requireStoredPositiveBigIntText`; facade forwarding is landed in WIP. Store contract 24/24 and store typecheck exit 0.
- Step 3 dependency facts (a)/(b) are present: daemon manifest `@moe/store: workspace:*`; lock importer `link:../../packages/store`.
- Mandatory trap-cleaned bare-import probe was created under `apps/daemon/src`, compiled through the exact daemon typecheck command, and confirmed deleted. The command cannot exit 0 because foreign untracked `apps/daemon/src/review/verifier-receipt-ledger.test.ts` has TS2322 at 46/76. Ownership query got no owner; worker-618633fa independently classified it as foreign and a real raw-gate blocker.
- Resume step 3 only after that foreign file is type-clean/removed by its owner. Re-run the same trap-cleaned probe to exit 0 before adding `readEventHorizon` to `FoundationBindingStore` or editing `scanForEffect`. Preserve current tests and all foreign bytes.
