# Handoff: task-f837ce45 Session coordination fabric (@moe/coordination)

Delivered 2026-08-08 by worker-e46fb0dc. Commits `2428083` (feature) and `bee5159`
(NUL-byte fix), both exclusively `packages/coordination/**`.

Gate: `pnpm --filter @moe/coordination typecheck && pnpm --filter @moe/coordination test`
-> exit 0, 2 files, 40 tests. Repo-wide `pnpm typecheck` also green.

## Shape

| file | role |
|---|---|
| `coordination-contracts.ts` | versions, scope, vocabularies, limits, envelope union, result unions, `coordinationCapability` |
| `coordination-shape.ts` | strict hostile-input readers (`isPlainRecord`, `readOwnDataProperty`, `hasExactOwnKeys`, `readBoundedList`) |
| `coordination-parts.ts` | address / advisory / handoff / bounded-JSON data decoding + forbidden-field scan |
| `coordination-codec.ts` | canonical bytes, sha256 `digestBytes`, envelope decode, stored decode |
| `coordination-mailbox-ids.ts` | deterministic aggregate/command/event ids, stamps, store-error mapping |
| `coordination-mailbox-reads.ts` | ack cursor, entry lookup, delivery build, paging + gap detection |
| `coordination-mailbox.ts` | send / acknowledge / read / replay / lookup over the store port |
| `coordination-ports.ts` | injected port types + the only answer shapes that authorize |
| `coordination-service.ts` + `-input.ts` | the four endpoints, auth/capability/address/correlation gates |
| `index.ts` | curated surface: exactly 14 runtime exports |

## Load-bearing design decisions (do not "simplify" these)

1. **Server stamps live in event METADATA, never in canonical bytes.** `sentAt`/`expiresAt`
   are stamped at storage. If they entered the canonical envelope, a retry at a later time
   would hash differently and dedupe would break. This is the whole reason dedupe works.
2. **`sendCommandId` derives from mailbox + messageId ONLY; `messageEventId` derives from
   mailbox + messageId + canonical bytes.** So a resend always hits the same durable command
   slot, and the eventId match is what proves the bytes were identical. See
   `mem:gotcha-store-commandid-digest-includes-expectedversion` for why the naive approach
   fails.
3. **Single-consumer mailbox.** The ack aggregate is derived from the mailbox aggregate, and
   the mailbox owner is the authenticated session. There is no caller-supplied `consumerId`,
   deliberately — it would be a capability hole.
4. **`lookup` is O(1) via `getCommandReceipt` + `receipt.currentVersion`**, not a mailbox scan.
   Works because each send commits exactly one event, so `currentVersion` IS the sequence.
5. **Ack monotonicity is re-checked inside the retry loop**, not once before it. Checking once
   lets a concurrent higher ack be walked backwards.
6. **Shape failures and size failures get different codes.** `readBoundedList` reports
   `tooLong` separately; a prototype-tampered/accessor/sparse list is `INPUT_INVALID`, only a
   genuine over-count is `LIMIT_EXCEEDED`. Conflating them makes a smuggling attempt read as a
   harmless size complaint.
7. **Every stable code is reachable.** `COORDINATION_VERSION_UNSUPPORTED` was removed during
   adversarial review because nothing could emit it. Keep that property.

## Ports a consumer must supply

`authenticate` (must return a **frozen** exact `{capabilities, ok:true, principalId,
sessionId}`), `resolveRecipient` (frozen `{known:true, role}`), `resolveEffectBinding` (frozen
`{bound:true, effectId, sessionId}` matching the query exactly), `now`, `mailbox`.
Anything unfrozen, partial, extra-keyed, thrown, or UNKNOWN is treated as no answer.
Wiring to `@moe/core`'s `authenticateCommand` is a follow-up: the port is intentionally
structural so coordination does not import the identity implementation.

## Follow-ups left open (not in scope, not defects)

- No relay consumes the `coordination.mailbox` outbox topic yet; drafts accumulate as pending.
- Nothing wires the real identity seam to the authenticator port yet.
- `@moe/core` is declared as a dependency per the plan but is not imported (ports only).

Related: `mem:gotcha-coordination-workspace-links-without-lockfile`,
`mem:gotcha-literal-control-bytes-in-generated-source`,
`mem:gotcha-store-commandid-digest-includes-expectedversion`.
