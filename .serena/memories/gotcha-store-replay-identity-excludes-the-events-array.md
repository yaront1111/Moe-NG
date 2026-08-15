# A @moe/store command replay does NOT cover what you are writing

`commitExpectedVersionDecision` decides replay by comparing `historical.requestSha256`
(`decision-ledger-transaction.ts:126`). That hash comes from
`identifyExpectedVersionRequest` (`store-digests.ts:82-95`) and covers exactly:

    identity version, projectId, principalId, commandId, commandKind,
    targetAggregateId, expectedVersion, requestBytes

The `events` array and `committedResultBytes` are **outside it**.

So an adapter that pins `commandKind` and `expectedVersion` constant, and derives
`targetAggregateId` from a couple of record fields, leaves EVERY OTHER FIELD OF THE
PAYLOAD free to drift. A second call under the same key with byte-identical
`requestBytes` but a completely different event payload replays *cleanly*, and the
store is right to do so — it was asked whether the same COMMAND ran, not whether the
same BYTES were written.

## The failure this produces

Return the caller's own record on the REPLAYED branch and you hand back durable
authority for something never committed. Reproduced on a real file-backed store:

    ok=true | disposition=REPLAYED | returnedGrantId=grant-NEVER-COMMITTED
           | durableEventId=grant-0001 | eventCount=1

Drift that CHANGES the derived aggregate is refused (IDEMPOTENCY_CONFLICT), which is
why probing that variant first gives false confidence. The hole is drift that keeps
the derived aggregate identical.

## The fix

On REPLAYED, read the derived aggregate back and answer from the DURABLE bytes,
through the same production reader a recovery caller would use. Compare by CANONICAL
DIGEST, not field by field — one digest covers every field and cannot silently omit
the one that drifted. Disagreement needs its OWN stable code (here
`ACTIVATION_LEDGER_REPLAY_DIVERGED`, `storeCode: null`); reusing the store's
conflict code would claim the store refused when it did not.

Do NOT read on the COMMITTED branch: the store just wrote those exact bytes, and
reading unconditionally destroys the `calls === ["commitExpectedVersionDecision"]`
assertion that proves you never reached for an apply callback.

Related: `mem:gotcha-replay-test-that-reuses-one-input`,
`mem:gotcha-nul-separator-in-derived-identifier`
