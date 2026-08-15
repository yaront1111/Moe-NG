# A replay must restate the ORIGINAL expectedVersion, not the current one

`packages/store/src/store-digests.ts:82` `identifyExpectedVersionRequest` hashes
`expectedVersion` INTO `requestSha256`, alongside projectId/principalId/commandId/commandKind/
targetAggregateId/requestBytes.

`DecisionTransactionStore.commitExpectedVersionDecision` dedupes on `requestSha256` ONLY
(decision-ledger-transaction.ts:103-108 and reconcileHistoricalDecision). So the store's command
dedupe runs BEFORE the expected-version check — you may safely pass a stale expectedVersion on a
replay — but only if the sha matches.

## The trap

The natural way to write an idempotent writer is to compute `expectedVersion` from the current
fold. On the FIRST arrival the aggregate is at 0, on the replay it is at 1. Same command, two
different shas, so the replay is refused as `IdempotencyConflictError` instead of returning the
original receipt. It looks like a dedupe bug in the store; it is not.

Fix used in `apps/daemon/src/coordination/recipient-registry.ts`:

    expectedVersion: decided?.previousVersion ?? (current === null ? 0 : current.version)

where `decided = store.getCommandDecision({commandId, principalId, projectId})`. Restate what the
first arrival claimed.

Corollary: `getCommandDecision` is also the only honest way to SKIP preconditions on a replay.
A "register requires ABSENT" precondition computed from the fold will reject the second arrival
of an already-decided register. Run preconditions only when `decided === null`.

Residual, accepted: if the prior decision was a `NoBusinessEffectDecision` its `previousVersion`
is null, so the retry falls back to the current version, mismatches, and refuses. Fail-closed.
