# The supervisor lease mirror is NOT verdict-identical to `fenceAuthority`

Found 2026-08-09 building the cross-package drift test
(`apps/daemon/src/work/work-races.test.ts`, task-49acb856).

`packages/runner/src/supervisor/lease-mirror.ts` clones design-749 because
`@moe/runner` depends only on `@moe/contracts`. The clone matches
`packages/scheduler/src/authority/lease-fencing.ts` on check ORDER, codes,
messages, the counter ceiling, `isCount`, `isDigest`, `oneOf`, and every
hostile-shape guard (`exactRecord` / proxy / accessor / prototype are
byte-equivalent between `effect-shape.ts` and `runtime-shape.ts`).

**One asymmetry, and a drift test written as blanket equality will go red on
it:**

| | scheduler `isRef` | mirror `isRef` |
|---|---|---|
| non-empty string | required | required |
| `<= 400` chars | no | YES |
| well-formed + NFC | no | YES (`isNormalizedText`) |

So a lease token holding a lone surrogate, a non-NFC `ownerSessionRef`, or a
401-char `leaseId` is FENCED by the authority and MALFORMED by the mirror.

## How to test it honestly

Partition the table, do not trim it. Declare each row `EQUAL` or
`MIRROR_STRICTER`:
- `EQUAL` rows assert same decision, same mapped code, AND same message.
- `MIRROR_STRICTER` rows assert authority ACCEPTS and mirror REFUSES.
- One whole-table invariant asserts the reverse never occurs — mirror accepting
  what the authority refused is the fencing bypass. Assert the examined counter
  equals the table length so a zero-case sweep cannot pass.

## The message is what pins check order

Four distinct causes share `AUTHORITY_STALE_LEASE` (token, authority hash,
session, record version). A clone with a REORDERED fence still answers the
right code on any input that violates only one condition, so single-cause rows
stay green. Include rows that violate TWO conditions at once and assert which
one decides: token+epoch, epoch+hash, hash+session, session+version,
version+state, malformed+staleToken, ceiling+staleToken. Proven: swapping the
mirror's hash and session checks turns exactly the hash+session row red and
nothing else.

Code mapping (hand-written, both closed vocabularies):
`LEASE_MIRROR_MALFORMED`<->`AUTHORITY_MALFORMED_INPUT`,
`_STALE`<->`AUTHORITY_STALE_LEASE`, `_STALE_EPOCH`<->`AUTHORITY_STALE_EPOCH`,
`_SUPERSEDED_AUTHORITY`<->`AUTHORITY_SUPERSEDED_AUTHORITY`. Map an unknown
mirror code to `UNMAPPED:<code>` so a newly added code fails loudly instead of
comparing equal to nothing.

`LEASE_KINDS` / `LEASE_STATES` / `MAX_AUTHORITY_COUNT` are NOT runtime exports
of `@moe/scheduler` — only the `LeaseKind` / `LeaseState` TYPES are. Pin
vocabulary parity with `Record<LeaseState, MirroredLeaseState>`: it demands one
key per scheduler member and one mirror member per value, so a state added on
either side turns `pnpm --filter @moe/daemon typecheck` red.

Related: `mem:task-task-49acb856ec064b2ea528450d15744ee9-handoff`.
