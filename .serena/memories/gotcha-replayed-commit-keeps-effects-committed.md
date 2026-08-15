# Gotcha: `EFFECTS_COMMITTED` does NOT mean "this call wrote it"

Found 2026-08-09 on `task-39fe2da5` while composing `@moe/store`'s
`commitExpectedVersionDecision` into the daemon's continuation command.

`CommandDecisionResponse` (packages/store/src/store-contracts.ts:131) is:

```ts
{ decision: CommandDecisionRecord; disposition: "DECIDED" | "REPLAYED"; historical: boolean; ... }
```

On a REPLAY (same `key.commandId`), the store returns the **historical** decision. That
record's `effectDisposition` is still `"EFFECTS_COMMITTED"`, because it describes the
ORIGINAL commit. So this check cannot tell a fresh write from a replay:

```ts
if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return CONFLICT; // NOT ENOUGH
```

The bug it produced: a second continuation naming the same successor with a DIFFERENT safe
handoff returned `ok: true` describing a binding that was never written. Durable state was
fine (append-only held); the RETURN VALUE lied.

## The fix that keeps idempotence

Compare the returned `resultBytes` against the bytes you proposed:

```ts
if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") return CONFLICT;
if (!sameBytes(response.decision.resultBytes, bytes)) return CONFLICT; // different payload, same id
return BOUND; // identical bytes -> the one action retried verbatim, still bound
```

Identical bytes must stay a success: a crash between issuing and observing the command
reissues it, and turning that into an error would make retry unsafe. Different bytes under
the same command id is a genuine collision and must refuse.

`restart-reconciliation.ts` avoids the same trap differently — it short-circuits on byte
equality BEFORE committing and derives `expectedVersion` from the stored row's version, so
a converged reclassification gets a new command id (`...:v2`) rather than replaying v1.

Related: `mem:task-task-39fe2da5307d42beaa49365d89508503-handoff`.
