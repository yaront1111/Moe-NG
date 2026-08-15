# A coherent activation fixture cannot be hand-written

`@moe/runner`'s `parseActivationGrant` requires `isDigest(grantId)` — a hex64 —
and `validateActivationCommit` additionally requires

    grant.grantId === deriveGrantId(intent.intentId, activationDigest)
    activationDigest === canonicalDigest(activationDigestInput(intent, attempt,
                          initialGrantBinding(intent.intentId, wrapperIdentity)))

**`canonicalDigest` is NOT exported from the runner root.** `deriveGrantId`,
`activationDigestInput` and `initialGrantBinding` are, but without the hash
function they cannot be closed, so there is no public way to compute a matching
pair by hand.

Consequence: any daemon test that needs a record which survives
`validateActivationCommit` must PRODUCE it through the published
`activateEffect`, handing in a complete request:

```ts
activateEffect({
  intent: { ...armed, state: "ARMED", version: 6 },      // leaseBinding = the lease
  attempt: { ..., state: "LAUNCH_REQUESTED", version: 7 },
  claim: { claimId, intentId, wrapperIdentity, lockIdentity, claimedAt },
  tombstone: null,
  leaseProof: { leaseToken, epoch, authorityHashRef, ownerSessionRef, expectedVersion },
  wrapperIdentity, lockIdentity,
  observedGraphEpoch: intent.expectedGraphEpoch,
  desiredState: intent.desiredState,
  dependencyWitnesses: [],
  observedRuntimeDigest: intent.runtimeObservationDigest,
})
```

The returned `ActivationCommit` carries `{intent, attempt, grant,
activationDigest, activationVersion}` with the successors already bumped
(intent 6->7, attempt 7->8), so `predecessorIntentVersion: 6` /
`predecessorAttemptVersion: 7` satisfy df298's `+1` reader check.

`fenceMirroredLease` must pass, so the proof must match the intent's
`leaseBinding` on token, epoch, authorityHashRef, ownerSessionRef and
`expectedVersion === lease.version`, and the lease state must be ACTIVE.

## The trap this hides

`apps/daemon/src/activation/activation-ledger-fixtures.ts` (df298, test-tier)
uses `GRANT_ID = "grant-0001"`. That record encodes and decodes fine — the codec
only checks `typeof grantId === "string"` and non-empty — but it does NOT parse
through `parseActivationGrant` and can never be COHERENT. Reusing it for
anything that reaches the runner parsers gives a fixture that is legal at the
layer you are looking at and illegal at the layer you are testing. Same shape as
`mem:qa-deviation-fixture-must-be-valid-at-earlier-layers`, one layer up.
