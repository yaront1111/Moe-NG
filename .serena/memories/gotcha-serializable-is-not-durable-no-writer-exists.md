# "Serializable" is a property of the shape; "durable" needs a WRITER — grep for one

Found 2026-08-09 on `task-304aa634` (recovery incarnation succession), which blocked on it.

The plan said: "load its durable `RecoveryIncarnationBinding` from the store". The architect
had verified — correctly — that `RecoveryIncarnationBinding` is fully serializable: every
field is a string, nothing is a handle, it survives `JSON.stringify` intact. That is true
and load-bearing. It is also not durability.

```sh
grep -rn "incarnationRef|IncarnationBinding" --include=*.ts packages/ apps/
# minus the contract, the mint service and index.ts: ZERO hits
```

**Nothing in the repo ever writes one.** `createRecoveryIncarnationService(port)` takes no
store and references none (`recovery-incarnation.ts:63-65`). The only durable commandKind
in the daemon was `reconciliation.decide`.

## The general check

This is `mem:decision-recovery-incarnation-webcrypto-handle-boundary` / the governor's
"symbol presence is not capability fitness" lesson pushed one layer out:

| Question | What answers it |
| --- | --- |
| Does the symbol exist? | grep the name |
| Is it reachable from the package root? | import probe |
| Can its VALUE cross a process boundary? | read the contract for lifetime (WeakMap, handle) |
| **Does anything actually PERSIST it?** | **grep for a WRITER — a commandKind, a commit call** |

The last row is the one that looks satisfied when the type is clean. A serializable shape
reads as "ready to be stored"; only searching for the write call site tells you whether the
row is ever created. Grepping the TYPE finds definitions and consumers, which is exactly
the population that makes it look present.

## Why it mattered rather than being pedantry

The tempting workaround — accept the predecessor binding from the CALLER and verify it —
passes every check while proving nothing. A caller mints a throwaway incarnation, hands
over its perfectly self-consistent binding, and existence + self-proof + fingerprint
recompute all succeed against an incarnation that never existed in the project. Green
suite, zero guarantee. Same family as
`mem:gotcha-fixture-derived-from-export-under-test-hides-every-assertion` and
`mem:gotcha-self-derived-universe-cannot-check-itself`: when the subject supplies its own
evidence, verification is theatre.

Related: `mem:gotcha-dependency-gate-uncommitted-siblings`,
`mem:pattern-guard-the-case-list-not-just-the-cases`.
