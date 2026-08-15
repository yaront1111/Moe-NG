# Gotcha: an append-only / byte-identity assertion keyed on COMMAND KIND is one write away from vacuous

Found 2026-08-09 on `task-39fe2da5` (J3 restart reconciliation + continuation), by the
step-7 mutation drill. The drill SURVIVED on the first attempt — suite stayed fully green
while the production code wrote straight into the record it was supposed to leave alone.

## The setup

`reconcileOnRestart` writes one row per attempt on aggregate
`restart-reconciliation:<attemptRef>` under command kind `reconciliation.decide`.
`evaluateContinuationCommandBytes` must APPEND a successor binding on an aggregate of its
own and never touch the attempt's. The test captured "the attempt's history" as:

```ts
decisions(store).filter((e) => e.commandKind === RESTART_RECONCILIATION_COMMAND_KIND)
```

## Why it was vacuous

The mutation pointed the continuation's write at `restart-reconciliation:<attemptRef>`.
That row landed on the attempt's aggregate — but carried the CONTINUATION's command kind
(`work.resume`), so the kind filter excluded the very row that edited history. Green.

The read-back-through-the-decoder assertion missed it too: `decodeRecord` rejects bytes
whose `schemaVersion` is not the reconciliation one, so the injected binding was silently
skipped and the map still returned the original record. BOTH assertions agreed, and both
were wrong.

## The rule

An append-only property is about a TARGET, not about a kind or a schema. Key the snapshot
on `targetAggregateId`, and get that id from production rather than restating the prefix:

```ts
// exported from restart-reconciliation.ts
export function reconciliationAggregateId(attemptRef: string): string { ... }

const id = reconciliationAggregateId(attemptRef);
decisions(store).filter((e) => e.targetAggregateId === id)
  .map((e) => [e.commandKind, e.currentVersion, [...e.resultBytes]]);
```

Include `commandKind` in the compared tuple — a foreign-kind write onto the aggregate is
exactly the case the kind filter used to hide. After the fix the identical mutation gave
`Test Files 1 failed | 25 passed`, red on the byte-identity test by name.

## Generalisation

Any "X was not modified" assertion that filters durable rows by a property the MUTATION
CONTROLS is decorative. Filter by the identity of the thing being protected. Same family
as epic rail 6's "assertion that has quietly detached from the thing it was written for".

Related: `mem:mutation-drills-in-shared-worktree`,
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`.
