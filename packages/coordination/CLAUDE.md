# @moe/coordination

Typed, addressed, durably sequenced envelopes between authenticated sessions — and nothing
else. `src/index.ts` says it outright: this is deliberately **not** a chat, and nothing here
dispatches a command, mutates a lifecycle, forwards a credential, or grants authority. The job
only it does in the wider system is turning one hostile request record into one committed
mailbox event with a server-owned sequence, or into a refusal that names the layer that
answered. Advisory text and HANDOFF payloads are data that reach a mailbox and stop there.

## Seams

- Root export map is `./src/index.ts` only; there are no subpaths. The single production
  consumer is `apps/daemon/src/coordination/coordination-adapter.ts`, re-exported through
  `apps/daemon/src/foundation/foundation-surface.ts` section 6. No HTTP route dispatches it
  yet — `createCoordinationAdapter` is reachable from the daemon surface and its test only.
- `createCoordinationService(dependencies)` → `{ acknowledge, read, replay, send }`, frozen.
  The five dependencies (`authenticate`, `mailbox`, `now`, `resolveEffectBinding`,
  `resolveRecipient`) are all answered by the daemon adapter from committed records.
- `createDurableMailbox(store)` → `send`/`read`/`replay`/`acknowledge`/`lookup`. `store` is the
  structural `CoordinationEventStore` (four methods, `coordination-mailbox-reads.ts:19`), never
  the `SqliteEventStore` class — the package depends only on `@moe/contracts` and `@moe/store`
  types.
- `coordinationRequestDigest(endpoint, unsignedRequest)` is the public signer half of the
  verifier the service uses internally; `apps/daemon/.../coordination-presentation.ts` feeds its
  output into `sessionAuthorityRequestDigest`.
- `coordinationCapability(endpoint, sessionId, kind?)` mints the exact grant string. The daemon
  adapter's `capabilitiesFor` and `tests/security/transport-hostile-fixtures.ts` both derive
  grants through it rather than writing the format down.

## The model

- **Layer vocabulary is the refusal's address.** `COORDINATION_LAYERS` = ADDRESS,
  AUTHENTICATION, CAPABILITY, CORRELATION, DECODE, MAILBOX, STORE; 20 codes in
  `COORDINATION_CODES`. `refuse(code, layer, detail)` is the only constructor and is *not*
  exported from the index.
- **`send` order is decode → authenticate → capability → address → correlation → commit**
  (`coordination-service.ts:134`). Every hostile fixture in the security lane depends on that
  order being stable.
- **Sequence and timestamps are server-owned.** They are absent from
  `CoordinationEnvelopeFields` by design, and `hasExactOwnKeys` refuses any envelope carrying
  them. `sentAt`/`expiresAt`/`digest` live in event **metadata** (`encodeStamp`,
  `moe-coordination-stamp/1`), never inside the canonical bytes, so arrival time cannot perturb
  a digest.
- **Deduplication is exact by construction.** `sendCommandId` hashes mailbox + message id only;
  `messageEventId` hashes mailbox + message id + canonical bytes. Same id, same bytes →
  `DEDUPLICATED`; same id, different bytes → `COORDINATION_IDEMPOTENCY_CONFLICT`. The RACE arm
  in `enqueue` returns the **winner's** stamps read back from the ledger, never the loser's
  freshly minted ones.
- **Canonical JSON** (`canonicalJson`, `coordination-codec.ts:61`): sorted keys, no whitespace,
  `version` injected. `finish()` then re-decodes the canonical bytes through
  `decodeBoundedJsonBytes` as an independent size/Unicode gate.
- **Hostile-input reading never touches the prototype chain.** `coordination-shape.ts` is the
  whole fence: `isPlainRecord` (no proxy, no array, no exotic prototype), `readOwnDataProperty`
  (accessors rejected, never invoked), `hasExactOwnKeys`, `readBoundedList` (index-by-index, no
  iterator). `coordination-parts.ts` collapses absent/inherited/accessor fields to an `INVALID`
  symbol no validator accepts.
- **Ports admit only a frozen, exact, positive answer.** `readBinding` requires
  `Object.isFrozen` plus exactly `capabilities/ok/principalId/sessionId`; a thrown, partial or
  merely mutable answer is indistinguishable from no answer (that is what makes
  `forgedBinding` in the security lane a forgery rather than a malformation).
- **Ack monotonicity is re-checked inside the retry loop**, and the commit's `expectedVersion`
  is the same version the cursor was derived from (`persistAck`, `AckState`). A fresher CAS
  token would let a stale ack walk the cursor backwards.
- **Ambiguity survives.** `mapStoreError` maps `OUTCOME_UNKNOWN` → `COORDINATION_OUTCOME_UNKNOWN`
  and never to success or plain failure. A RESPONSE whose reply-target lookup *refuses* returns
  that refusal; only a true `null` earns the permanent `COORDINATION_REPLY_TARGET_MISSING`.
- **Expiry is reported, not filtered.** An `EXPIRED` delivery keeps its sequence so a consumer
  acknowledges it explicitly instead of the cursor skipping a hole.
- **`COORDINATION_FORBIDDEN_FIELDS`** (19 names: `apiKey`…`token`) is enforced at *every*
  nesting depth of `data`, code `COORDINATION_FORBIDDEN_FIELD`. Refusal details name the field
  and never quote the value, so a refusal cannot become an echo channel.
- `COORDINATION_CONTROL_KINDS` is closed and deliberately non-lifecycle: ATTENTION_REQUESTED,
  CAPACITY_REPORTED, HEARTBEAT, MAILBOX_DRAINED, REPLAY_REQUESTED.

## Gotchas

- **`src/index.ts` has no `.js` bridge and must not get one** — every other module does.
  `coordination-entrypoint-smoke-worker.mjs` imports `./index.ts` directly under
  `--experimental-strip-types`; a new module without its sibling bridge fails only there.
- That worker carries **two hand-written goldens**: `exportedNames` (15 runtime exports,
  sorted) and `leakedNames` (`refuse`, `digestBytes`, `canonicalEnvelopeBytes`,
  `decodeCoordinationEnvelope`, `decodeStoredEnvelope`, `mailboxAggregateId`, `readBinding`,
  `sendCommandId`, `createMailboxReader`, `SqliteEventStore`). Adding or leaking an export reds
  `coordination-integration.test.ts:305`.
- `tests/security/boundary-roster.security.ts` pins `"packages/coordination": 1` and rosters
  `COORDINATION_LAYERS` on the `transport` axis. A second `export const *_LAYER(S)` here reds
  the security lane; the scanner matches `^export const [A-Z0-9_]+(LAYERS|LAYER|BOUNDARIES)`.
- The vocabulary test asserts every axis is frozen, unique **and sorted**. Adding a code or a
  role out of alphabetical order reds `coordination-suite.test.ts:160`.
- `COORDINATION_LIMITS.maxHandoffEntries` (32) is reused as the bound for *any* array inside
  `data` (`decodeJsonList`), not just handoff lists — the name undersells its reach.
- Identifiers are printable ASCII, no space (`isIdentifier`), so a session id with a hyphen is
  fine but one with a space or a combining mark is refused at DECODE.
- `digestBytes` length-frames each part with a big-endian u64 header, so a new digest input must
  be appended as its own part; concatenating into an existing part silently changes nothing
  structurally but breaks signer/verifier agreement.
- `tests/integration/release/release-version-surfaces.test.ts:20` pins this `package.json`.
- The daemon adapter mints SEND grants only for candidate targets holding a live committed
  recipient record; changing `coordinationCapability`'s format moves both the grant and the
  check, which is why nothing writes the string literally.

## Testing

- Whole folder: `pnpm --filter @moe/coordination test` (it runs `vitest run --root ../..
  packages/coordination/src`, i.e. the repo-root config).
- One file, from the repo root:
  `pnpm vitest run packages/coordination/src/coordination-suite.test.ts`.
- `coordination-suite.test.ts` (1255 lines) drives the service over
  `SqliteEventStore.openEphemeralForProjectTest`; `coordination-integration.test.ts` uses a real
  on-disk store under `os.tmpdir()` and proves durability **across a store close/reopen**, plus
  the strip-types entrypoint smoke.
- Outside coverage: `pnpm test:security` (`transport-hostile-fixtures.ts` builds the service
  with a throwing Proxy mailbox — proof that admission refused before any durable call, and
  `boundary-roster`), `apps/daemon/src/coordination/coordination-adapter.test.ts` for the five
  ports against real session authority, and `apps/daemon/src/index-surface.test.ts:280`, which
  asserts the daemon deliberately does **not** re-export this package's vocabulary.
