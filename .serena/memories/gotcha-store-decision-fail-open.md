# Two fail-opens when composing `SqliteEventStore` command decisions

Both found by adversarial review on `task-2f6ac0d1`, neither had a failing test before review, both
now guarded in `apps/daemon/src/bootstrap/bootstrap-ledger.ts`. Anyone building a second service layer
on `commitExpectedVersionDecision` will hit both.

## 1. A conflicting commit returns a decision, it does not throw
`commitExpectedVersionDecision` answers an expected-version mismatch by writing a
**`NO_BUSINESS_EFFECT` audit row** with `resultCode: "EXPECTED_VERSION_CONFLICT"` and returning a normal
`CommandDecisionResponse`. There is no exception.

Naive composition returns `ok: true` for it — authority claimed for a command that committed no
business effect. Reachable in production whenever a concurrent writer moves the aggregate head between
your ledger read and your commit (read-then-commit is check-then-act).

```ts
if (response.decision.effectDisposition !== "EFFECTS_COMMITTED") {
  return refuse(request.kind, response.decision.resultCode, "DURABLE_STORE");
}
```

## 2. The decision key does not include the command kind
`CommandDecisionKey` is `(commandId, principalId, projectId)`. **No kind.**

If you short-circuit on `getCommandDecision` for idempotent replay — and you must, because the pure
reducers reject an identical second request on `expectedVersion` before it can reach the store — then
reusing a `commandId` under a *different* kind hands back the earlier command's decision as an accepted
replay of the new one. The store's own command-id guard never fires, because your short-circuit
returned before any write.

```ts
if (existing.commandKind !== request.kind) {
  return refuse(request.kind, "BOOTSTRAP_COMMAND_ID_REUSED", "DAEMON_PREREQUISITE");
}
```

## Corollary for ledger folds
Count **all** decisions when asserting "no durable row was written" (audit rows must not hide), but fold
**only** `EFFECTS_COMMITTED` rows into aggregate state — otherwise a refusal satisfies a later
prerequisite. See `readDurableLedger`.
