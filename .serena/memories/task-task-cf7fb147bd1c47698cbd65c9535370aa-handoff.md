# task-cf7fb147 recovery inventory coordinator handoff

## Delivered
- Added `apps/daemon/src/recovery/effect-inventory.ts` + LF `.js` bridge: selects the installed recovery binding/anchor, validates configured coverage through the existing record builder, collects sources, joins items, builds the canonical reconciliation record, persists it through `recordRecoveryReconciliation`, reads it back, and holds UNKNOWN authority with exact upstream provenance.
- Added `effect-inventory-collection.ts` + bridge: imports and CALLS `collectRecoveryInventory` and `createRecoveryInventoryRegistry` from the bare `@moe/runner` root. This is the durable consumer edge for archived parent task-0325dcf7ee744123b40cf583230c7b6a's node inventory family. Node proof rows bind `report.inventoryDigest`, which transitively binds item facts and source proof digests.
- Added `effect-inventory-join.ts` + bridge: deterministic canonical join to existing restored intent; exact current-incarnation/key-epoch match may ADOPT, proved ended/released items become ABSENT, prior-incarnation and orphan items QUARANTINE, uncertainty remains UNKNOWN. It exports frozen empty `historyInsertions` and `repeatRequests`.
- Added two focused suites: `effect-inventory.test.ts` and `effect-inventory-join.test.ts` (16 tests total). They pin literal six proof classes, literal seven populations, exact many-to-one mapping, coordinator precedence for omitted/duplicate/unknown/extra class sets, persisted UNKNOWN, exact coordinator/upstream code+layer, all three dispositions, no history/repeat for orphan, and deterministic shuffled output.

## Important decisions/evidence
- DoD 6's wording is SIX proof classes plus SEVEN populations, not seven proof classes. `PROVIDER_PROCESS_LAUNCH_LOCK` covers both effect-lock registration and provider-run populations through `RECOVERY_CLASS_POPULATION_ROWS`; no proof was duplicated.
- DoD 4 was verified as already implemented by task-e33747f982e0452a9f9d784fd1cb914d: `activation-ingress.ts` reads `readActivationEmbargo` at line 299 before `claimStage` at line 303; this task did not edit `apps/daemon/src/activation/**`.
- Dependency edge verified before implementation: daemon manifest and lock importer declare `@moe/runner`; a compiled positive bare-root probe passed and a missing-export negative control failed TS2305; probe removed in the same command.
- Mutation drills all reddened on target assertions and byte hashes restored: inverted embargo/UNKNOWN branch, empty enumerator, current-incarnation adoption qualifier, required class set, and retained upstream code.
- Production line counts: collection 241, join 244, entry 113; entry functions are 25 and 39 lines. All bridges are exact one-line LF.
- Focused verification fresh: 2 files / 16 tests pass; owned entry compile exit 0. Full daemon test later passed 89 files / 1820 tests.

## Shared-tree/commit provenance
- Measured base before work: `9d60091`. Foreign whole-tree commit `cdd53e4` (task e33747f9) swept the eight owned inventory paths. Do not amend/reset/recommit to claim those bytes; QA should review `git diff 9d60091..HEAD -- apps/daemon/src/recovery/effect-inventory*`.
- Post-sweep legitimate hardening commits are `8ad396a` (test union narrowing) and `cfe24c0` (split persistence helper to keep functions <=50).

## Terminal gate state at handoff
- Human continuation re-audit found the two ownerless blockers repaired by commit `65a3241` without this task touching those paths. The exact named gate was then run fresh against stable HEAD `18f09644026dfd70778eb7baf1f6b4499b1dbfb7`: `pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon test` exited 0, with typecheck clean and 89 test files / 1823 tests passing. HEAD was identical before and after the run.

See also `mem:gotcha-recovery-inventory-ledger-exact-request-envelope`.