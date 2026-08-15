# Two ports reading one record: the later guard can never refuse

Found 2026-08-11 wiring the daemon coordination adapter
(`task-4afcb06422ed4adb89430b7ea9758d7f`).

## The shape

`packages/coordination/src/coordination-service.ts` `checkAddress` asks two
questions in order:

1. `resolveRecipient(address)` — refuse `COORDINATION_RECIPIENT_UNKNOWN`
2. `resolveEffectBinding({effectId, now, sessionId})` — refuse
   `COORDINATION_TERMINAL_BINDING_INVALID`

Tempting wiring: point BOTH at the one durable record you have. Here that was
`RecipientRecord {effectId, generation, projectId, revoked, role, version}`.

It looks correct, every fact-only test passes, and the second refusal is
**dead code**. `resolveRecipient` (recipient-registry.ts:230) already tests
`record.effectId` against the address, so `{recipient known}` is a subset of
`{effect bound}` and the difference set — the only place guard 2 can fire — is
empty. A test naming the second code is answered by the first guard.

## The check, and it is cheap

List the fields the EARLIER guard reads. List the fields the later one would
read. If the later set is a subset, the later guard is unreachable — no test can
distinguish it, and the DoD clause naming its code is vacuous.

Do it in both directions before writing the port. Here only `version` was unread
(meaningless), and the other candidate axis — expiry at `now` — was already
enforced inside `readActiveSession` via `isSessionUsableAt` on the same clock,
so it was empty too.

## What to do about it

Not "wire it anyway and hope". Two honest options:

1. Find a genuinely independent durable source. If it does not exist, say so
   symbol by symbol.
2. **Fail closed**: return the typed NEGATIVE unconditionally. That makes the
   later refusal REACHABLE (the earlier guard passes, the later one refuses),
   grants nothing, and is what "unverifiable evidence stays UNKNOWN" already
   requires. A constant NEGATIVE is the opposite defect from a constant
   positive — the prohibition on stubs is about granting authority nobody
   attested.

Prove reachability in the test by asserting the earlier guard's POSITIVE answer
first (`resolveRecipient` returns `{known:true, role:"TERMINAL"}`), then the
composed refusal. Without that line the test cannot tell which guard answered.

Related: `mem:refusal-test-answered-by-earlier-guard`,
`mem:guard-premise-detaches-while-green`.
