# `packages/runner/src/recovery/` composes the supervisor; it re-derives nothing

Established by `task-52ec1406` (Crash reconciliation services), commit `cec2b65`.

## The package fence that forces the shape

`@moe/runner` depends on `@moe/contracts` ONLY. It cannot import `@moe/scheduler` or `@moe/store`.
So every lease fact arrives as the in-package **structural mirror** in
`supervisor/effect-shape.ts` (`MirroredLeaseRecord`, `MirroredLeaseProof`, `parseMirroredLease`,
`parseMirroredProof`), never as a scheduler import. `@moe/contracts` IS available, which is how
recovery names exact operations from `RUNTIME_COMMAND_KINDS` instead of inventing command strings.

Also: `packages/scheduler/src/package-boundary.test.ts` scans every source under `packages/` for an
internal scheduler PATH — a comment spelling one out trips it exactly like an import. Name the
package, never the path.

## What the supervisor already owns — do not rebuild it

- `restart-reconstruction.ts` `reconstructAfterRestart` — re-derives one legal state from durable
  records after a crash, returning `RESTART_POST_STATES` (ACTIVE_ADOPTED, TOMBSTONED, DRAINING,
  TERMINAL_PROVEN, RECONCILE_ONLY, SUSPECT, UNKNOWN).
- `drain-reconciliation.ts` `resolveDrainRow` — the design 786/787 cross-product.
- `drain-disposition.ts` `upgradeDisposition` / `isMonotonicDisposition` — drain monotonicity,
  "enforced at ONE source" per its own header. Delegate; do not re-derive.
- `lease-mirror.ts` `fenceMirroredLease` — the lease fence with `LEASE_MIRROR_STALE_EPOCH` etc.
- `effect-kernel.ts` — `EFFECT_STATES`, `SUPERVISOR_ERROR_CODES`, `supervisorFailure`.
- `drain-table.ts` — `RESOURCE_FACTS` = PROVEN_RELEASED | ACTIVE | UNKNOWN, the three-valued
  lattice recovery's `PREDECESSOR_RELEASES` is pinned string-identical to.
- `effect-test-fixtures.ts` — `makeIntent/makeLease/makeProof/makeClaim/...`; `activateEffect(
  makeActivationRequest())` yields a coherent commit to seed crash fixtures from.

## What recovery adds, and only this

The two questions a crash raises that the supervisor does not answer:

1. **May ownership move?** `ownershipProven` requires a STRICTLY higher epoch AND a different lease
   token. A proof at the held epoch is the crashed process's own authority replayed. Note this is
   deliberately NOT `fenceMirroredLease`, which demands epoch EQUALITY — that fence proves "you hold
   the current authority", which is the wrong question for a transfer.
2. **May a late observation speak?** An `observedEpoch` below the durable lease epoch is REFUSED
   (`RECOVERY_STALE_OBSERVATION_REFUSED`), never merged and never silently dropped.

Refusals carry `code`/`layer` as UNIONS of the recovery and supervisor vocabularies, and
`carriedFailure()` passes a delegated supervisor refusal through VERBATIM. Restamping the layer
would erase which surface refused, which is what epic rail 6 asks a test to distinguish.

## Two rules worth keeping

- **No clock, no randomness, anywhere in the subtree.** The absence is the mechanism: with no
  quantity that grows while nothing happens, timer-based ownership theft is unwritable rather than
  merely untested. `presenceLooksLive` is parsed but consulted NOWHERE.
- **The outcome vocabulary is closed and has no `RESUMED` arm.** "Nothing silently resumes" is a
  fact about what `classifyCrash` CAN return, not a check someone must remember to run.

Related: `mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion`,
`mem:gotcha-redundant-operand-mutants-survive-inside-one-guard`.
