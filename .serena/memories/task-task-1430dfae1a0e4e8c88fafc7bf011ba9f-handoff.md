# task-1430dfae1a0e4e8c88fafc7bf011ba9f — architect handoff

Daemon stream command identity + server timing observations. Plan submitted (7 steps, 6 files) at HEAD `7dbf9ba`.
SPIDR slice 1 of 3 from task-1eeb2dcc; siblings task-371c80bd (live consumer edge) and task-bcae0b7e
(decision-effort observations) stay BACKLOG until this lands.

## The blocking question the task demanded be answered first: NOT BLOCKED
`SubscriptionPage.events` is `readonly StoredEvent[]` (subscription-contracts.ts:105-109), and
`StoredEvent` (store-contracts.ts:151-172) already declares **`commandId` REQUIRED** plus an optional
`decisionTrace {commandId, commandKind, principalId, projectId, requestIdentityVersion, requestSha256}`.
Command and principal identity already reach the seam. **No `packages/store` edit, no store task.**

Two measured ABSENCES that decide DoD 3's shape:
- **No session id, no run id** anywhere on StoredEvent or decisionTrace (`metadata` is opaque bytes the
  seam must not parse) → emit as an explicit not-provided UNKNOWN with code + layer, never omit, never `""`.
- `decisionTrace` is genuinely absent for non-decision events — event-read-decode.ts:113-150 returns the
  event without it when all decision columns are null, and raises STORE_CORRUPT only on a *partial* trace.
  So "source lacks a principal" is reachable against a real store, not a synthetic fixture.

## Design constraint that decides everything
StreamEvent is a STRUCTURAL VIEW a real StoredEvent must stay assignable to. So:
- StreamEvent gains ONLY source-provided fields (`commandId`, `decisionTrace?` with fields typed plain
  `string` — a literal type is assignable to `string`, not the reverse).
- The daemon-observed reading lives on **WireEvent only**, added during encode. Requiring it on StreamEvent
  would break assignability and force the forbidden store edit.
- Step 3 adds a compile-time guard: a fixture typed as `StoredEvent` (type-only import from the bare
  `@moe/store` root — legal; the header forbids importing the store's *subscription* surface, not the root)
  must be assignable to StreamEvent, so future rot fails typecheck instead of forcing a store change.

## Other decisions
- New closed vocabularies (observers, clocks, unknown codes). `EVENT_STREAM_REFUSAL_CODES` stays byte-
  identical at 3 members and is asserted **disjoint** — an absent identity is not a frame refusal (DoD 4).
- Clock is an OPTIONAL third param with a frozen module-level default, because http-listener.ts:116 calls
  `readEventPage(port, request)` and a required param ripples into every listener/adapter fixture.
- **One seam reading per frame encode**, stamped on all events, asserted with a counting observer double
  (`calls === 1` for a 10-event page). Ten readings from one clock invite a consumer to diff them — the
  exact silent clock comparison rail 3 forbids.

## Measured trap
`apps/daemon/src/index-surface.test.ts:418` pins `Parameters<typeof daemon.readEventPage>` with
`toEqualTypeOf` — **any** signature change, including an optional third param, reddens it. Owned on purpose.
Export table at :185-186 / :224-227 needs a row per new runtime export. `runtime-entrypoint.test.ts:47/97`
only checks `typeof === "function"` and is unaffected.

Line counts: event-stream-contract.ts 177, event-stream.ts 182 (both have headroom under 250; split the
observation vocabulary into `event-stream-observation.ts` + bridge if the contract crosses).
Gate: `pnpm --filter @moe/daemon test && pnpm typecheck` — root `pnpm test` skips apps/**.
