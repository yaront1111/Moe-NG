# Store input decomposition implementation handoff

Task `task-bc7d265f680e4c1db2a08c3c61f47f5f` is in REVIEW.

- Commit `8618983` contains exactly the ten owned paths.
- `store-input.ts` is a 26-line facade preserving all 18 runtime exports by identity.
- New layers: primitives 109 lines, containers 104, commit 205, decision 112; each has a one-line `.js` bridge.
- Direct `store-input-decomposition.test.ts` is exactly 250 lines and adds 6 tests for stable errors, hostile containers, revoked proxies, evaluation order, defaults/duplicates/reserved IDs, copy isolation, deferred proposal reads, frozen keys, and shared byte-budget order.
- Mechanical comparison accounted for all 19 old function declarations; bodies match HEAD exactly except the approved `types.isProxy(value)` check before `Array.isArray(value)` in `snapshotDenseArray`.
- Exact gate passed after commit: `pnpm --filter @moe/store typecheck && pnpm --filter @moe/store test` (19 files, 118 tests).
- `store-input.js` stayed byte-identical (blob `800e3a28d1b954081348261bf879a7455d7e9191`); existing tracked tests and callers were untouched.
- Shared-index contention occurred with packages/core; foreign staged entries were explicitly unstaged without altering working bytes and the owner was notified in #workers.