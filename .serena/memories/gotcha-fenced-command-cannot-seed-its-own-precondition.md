# A fenced command cannot seed the history a test needs *behind* that fence

To test "genesis refuses a store carrying authoritative history but no ACTIVE binding" I first seeded
with `openDefaultSession(store)` (session-test-fixtures.ts). It failed:

```
Error: session.open setup failed: SESSION_RECOVERY_BINDING_UNAVAILABLE
```

`session.open` is ITSELF fenced on the ACTIVE recovery binding, so it cannot write history to a store
that has none. That is a wrong-reason RED — the test errors in setup rather than exercising the guard.

## What works

Commit a BUSINESS decision straight through the store seam, and assert it landed:

```ts
const response = store.commitExpectedVersionDecision({
  commandKind: "project.register",
  committedResultBytes: bytes,
  correlationId: "corr-genesis-history",
  decidedAt: "...",
  events: [{ eventId: "evt-genesis-history", eventType: "ProjectRegistered", payload: bytes }],
  expectedVersion: 0,
  key: { commandId: "cmd-genesis-history", principalId: "operator-local", projectId: PROJECT_ID },
  requestBytes: bytes,
  targetAggregateId: "agg-genesis-history",
});
expect(response.decision.effectDisposition).toBe("EFFECTS_COMMITTED");
```

Two constraints, both load-bearing:

1. **Do NOT use `recovery.incarnate`.** `hasAnchoredIncarnation` would then be true and
   `ensureGenesisRecoveryBinding` returns DEFERRED *before* it reaches the installer — the guard under
   test goes silently unexercised and the test passes while proving nothing.
2. **Assert the commit.** Epic rail 6: a generated/seeded case must assert it was actually generated.
   A seed that quietly committed nothing makes the refusal unreachable and the test vacuous.

## Generalisation

Before reaching for a high-level fixture to build a precondition, check whether that fixture depends on
the very invariant you are trying to violate. When it does, drop one layer to the durable seam — and
pick a command kind that does not trip a *different* early-return on the path you are testing.
