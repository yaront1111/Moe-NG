# Event ledger decomposition implementation handoff

Task `task-286d40ce6867423bae972c07d127d466` is in REVIEW.

- Commit: `3883250` (`refactor(store): decompose event ledger`), exactly nine owned paths.
- `event-ledger.ts` is now a 7-line compatibility facade over `EventTransactionStore`.
- New internal inheritance layers: transaction -> recovery -> append -> outbox -> event read model, each with a one-line `.js` strip-types bridge.
- `EventAppendStore.writeCommitEffects` remains protected for decision-ledger reuse.
- Preserved receipt -> project scope -> event -> nested outbox -> digest finalize -> aggregate head -> COMMIT order, bigint positions, replay/conflict precedence, and OUTCOME_UNKNOWN poisoning.
- Physical line counts: facade 7, transaction 75, recovery 48, append 239, outbox 80, bridges 1.
- Read-only characterization blobs remained byte-identical: core `1afeafd26c55ed7051652c285734f2ca646a84ba`, recovery `1941cb504b43320c3e4aebae5d59ec06f47834e0`, ambiguity `34a63898b9cb5ae14249f4a51a45b88cc4c7ccbb`.
- Exact verification passed: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` (18 files, 112 tests). Additional `pnpm verify:store` passed recursive workspace typechecks and 112 tests.
- Owned paths were clean after commit; foreign shared-tree WIP was preserved.