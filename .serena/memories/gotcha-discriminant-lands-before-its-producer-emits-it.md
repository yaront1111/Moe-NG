# Gotcha: a union's discriminant can be typed before any producer emits it

A peer widened `RecoveryIncarnationBinding` into `GenesisIncarnationBinding | RestoreIncarnationBinding` with an `origin: "GENESIS" | "RESTORE"` discriminant and COMMITTED the contract, while the producers were still uncommitted work-in-progress.

Consequence for every consumer in the shared worktree: the discriminant exists in the TYPE but not in the RUNTIME OBJECT. `readAnchoredIncarnation` still returned the pre-union shape — real `backupGenerationDigest`, no `origin`.

So the obvious narrowing

```ts
if (anchored.origin !== "RESTORE") return REFUSALS.BINDING_MISMATCH;
```

typechecks perfectly and refuses EVERY legitimate binding at runtime. On task-f6cf8d16c2654641a92b0ee36924de0c that reddened 9 of my own ledger tests, and the failure reads like my guard is wrong rather than like the producer is incomplete.

## The form that survives both shapes

```ts
const anchoredGeneration =
  "backupGenerationDigest" in anchored ? anchored.backupGenerationDigest : null;
if (anchoredGeneration !== external["backupGenerationDigest"]) return REFUSALS.BINDING_MISMATCH;
```

`in`-narrowing satisfies the union without depending on a field the producer may not emit yet, and treating the absent field as `null` keeps the comparison fail-closed — a genuinely genesis binding still refuses.

## The general rule

When a shared discriminated union lands, do NOT assume the discriminant is populated at runtime. Check whether the PRODUCER is committed:

```sh
git status --porcelain -- <producer file>     # dirty = mid-flight
git log -1 --format='%h %s' -- <contract file>
```

If the contract is committed but the producer is dirty, narrow on a field you can prove exists, not on the tag. Revisit once the producer lands — but only with the consumer suite re-run, since the two forms are NOT equivalent while the producer is incomplete.

Related: `mem:gotcha-clean-package-reddened-by-foreign-uncommitted-contract`, `mem:guard-premise-detaches-while-green`.
