# A "durable store unchanged" assertion must exclude what legitimate traffic writes

Found 2026-08-11 on `task-4afcb064` (daemon coordination adapter), proving
"advisory text and CONTROL/HANDOFF envelopes can never reach a command service".

## The trap

`SessionAuthorityService.authenticate` is not read-only. It burns a durable
replay-nonce marker through `observeReplayMarker` on **every successful call**
(`apps/daemon/src/identity/session-authority.ts:240-254`, event type
`SessionAuthorityReplayObserved`). The mailbox also legitimately gains an event
per accepted send.

So a before/after assertion over the WHOLE store can only ever be written one of
two wrong ways:

- assert the whole store is unchanged -> always fails, so you weaken it to
  "no error was thrown", which proves nothing;
- fold everything in and compare loosely -> the assertion stops discriminating.

## The fix

Scope the digest to the LIFECYCLE records the property is actually about, and
say in a comment why the rest is excluded:

```ts
function lifecycleDigest(state, sessionIds) {
  return sessionIds.map((sessionId) => {
    const authority = JSON.stringify(sessions.readSessionAuthority(sessionId));
    const events = store.readEvents(recipientAggregateId(sessionId))
      .map((e) => `${e.eventType}#${e.aggregateSequence}`).join(",");
    return `${sessionId}=${authority}[${events}]`;
  }).join("||");
}
```

Then PROVE it bites with a mutation drill: make the code under test call a
lifecycle writer (`recipients.replace(...)` on CONTROL/HANDOFF) and require the
digest comparison to redden. If it stays green the digest is too narrow.

## Second-order consequences of the same fact

- Every authenticated request needs a FRESH nonce, or the second one refuses
  `SESSION_REPLAYED` at layer `REPLAY`. Test helpers need a nonce counter.
- The nonce burn is what makes a presentation single-use, which is a genuine
  security property worth asserting directly (send twice with the same
  presentation, second must refuse).
- The burn happens BEFORE the expiry check in
  `packages/core/src/identity/authenticate-session.ts`, so an expired-session
  authentication still consumes a nonce.
