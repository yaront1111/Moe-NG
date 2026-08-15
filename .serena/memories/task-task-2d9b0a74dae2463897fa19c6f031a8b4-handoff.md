# task-2d9b0a74dae2463897fa19c6f031a8b4 handoff

- Status: REVIEW.
- Commit: `7f31a4d` (`feat(store): add schema v3 projection tables`), exactly 8 owned paths; still reachable from current main.
- Implementation: byte-exact frozen `SCHEMA_V2_OBJECT_SQL`; v3 manifest overrides domain_events to append defaulted `domain_schema_version`, keeps AUTOINCREMENT, and adds projections/inbox_receipts/event_subscriptions/cursor_generations without AUTOINCREMENT. Schema/public manifest versions are v3; internal v2 manifest constant supports the intermediate leg. Migration accepts v1/v2, exact-validates each source, refuses populated/newer stores with stable codes, excludes project binding from the v2 emptiness count, recreates empty domain_events, and finalizes v3 transactionally.
- Tests: new 200-line migration suite covers fresh exact v3/DDL, v1 two-leg, bound-empty v2, populated v1/v2 refusal, too-new refusal, and deterministic schema bytes. Existing test edits are version literals only, including the announced third fresh-store pin.
- Fresh final exact gate: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` exited 0 with 20 files / 124 tests passed.
- Fresh repository delivery gate: `pnpm typecheck && pnpm test` exited 0 with 109 files / 1549 tests passed, 1 skipped.
- Adversarial final review: v2 manifest body changed only by export rename; nine non-domain v3 strings are identical references; only historical ledgers use AUTOINCREMENT; integrity/conformance/event append stayed clean; commit diff and owned status are clean.
- Earlier shared-tree block was correctly resolved without foreign edits after policy task commit `4e8ac7c` restored the root gate.