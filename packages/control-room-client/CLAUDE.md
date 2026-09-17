# @moe/control-room-client

The browser-side half of the daemon wire: a **generated** envelope-building surface plus
the hand-written gates, transport and crypto that guard it. Its job in the wider system is
to make it impossible for the control room to *mint* authority — every command identity
field is copied from a daemon-issued `NextAllowedCommand`, and the whole generated surface
is unreachable until a compatibility gate admits the build. Nothing here validates a field
the daemon's decoder already owns, and nothing here re-codes a daemon refusal.

## Seams

- Root export map is `src/index.ts` only; two subpaths exist for the daemon:
  `@moe/control-room-client/contract-digest` (`canonicalContractSurface`,
  `deriveContractDigest`) and `.../contract-pins` (`GENERATED_CONTRACT_DIGEST`).
- `createCompatGate(report: unknown)` / `admitByWireProtocol(v: unknown)` →
  `ControlRoomClientSurface` (`commands`, `queries`, `errors`, `pins`, `telemetryKinds`,
  `wireProtocolVersion`). `apps/control-room/src/live/live-config.ts` and
  `live-handshake.ts` are the real callers.
- `createControlRoomTransport(options)` → `sendCommand`, `readEventPage`,
  `acknowledgeEventPage`, `readDocumentDossier`.
- `buildGoalBriefCommand` / `buildGoalWithSourceCommand` — the two typed command edges
  (`v2/goals/live-goal-create.ts`, `v2/approvals/replan-successor-*.ts`).
- `generateSessionKey`, `openSessionRequestDigest`, `signSessionChallenge` for pairing.
- Consumes only `@moe/contracts`. It must never import `apps/daemon`:
  `EventPageRequest` / `EventAcknowledgeRequest` are re-declared structurally for that reason.

## The model

- **`src/generated/generated-client.ts` is committed output.** Regenerate with
  `pnpm --filter @moe/control-room-client generate`; `generator/generate.ts` is a pure
  function of the `@moe/contracts` runtime registry (sorted lists, LF only, no clock).
- **Affordance-anchored commands.** A caller supplies only `correlationId`, `payload`,
  `requestDigest`, `sessionCredential`; `commandId`, `expectedVersion`,
  `targetAggregateId` and the three optional hashes come from the affordance. A builder
  whose `commandKind` does not match the affordance returns `INPUT_INVALID`, never an
  envelope. Query builders carry no authority and cannot fail.
- **Two pins, two scopes.** `contractDigest` covers only the runtime-*enumerable* surface;
  envelope key drift is invisible to it and is caught instead by the type-level
  `CommandEnvelopeKeyCoverage` / `QueryEnvelopeKeyCoverage` `AssertNever` tripwires (they
  break `pnpm typecheck`, not a test). `GENERATED_WIRE_PROTOCOL_VERSION` is *composed* as
  `command+query+errorRegistry` version, never written down.
- **Gates fail closed to one shared frozen refusal.** `DISTRIBUTION_MISMATCH` with
  `truthClass: "OBSERVED"` — deliberately *not* a `RuntimeError`, because the client cannot
  observe the `PROJECT` lifecycle source that code declares. `admitByWireProtocol` is the
  documented narrowing for the runtime `/bootstrap` handshake.
- **Transport speaks two codes about the round trip only**: `TRANSPORT_REQUEST_FAILED`,
  `TRANSPORT_RESPONSE_UNREADABLE`, under `CONTROL_ROOM_TRANSPORT_LAYER`. `delivered`
  separates "daemon refused" from "no answer". A hang is folded into
  `TRANSPORT_REQUEST_FAILED` via `AbortSignal.timeout` (default 15 s).
- **`copyOwnDataInput` is the one prototype fence.** Every typed command edge reduces the
  caller record to frozen null-prototype own *data* properties first; an accessor, proxy,
  array or foreign prototype is irreducible and refused. The refusal is borrowed from
  `admitGoalBrief` (`sharedInputRefusal`) so this package mints no vocabulary of its own.
  Briefs are admitted from the **rest** of the destructured record, so a stray key is an
  exact-keys failure rather than a field riding along.
- **`session-key.ts` may contain no `node:` import** — the root must stay browser-loadable.
  The Ed25519 private key is generated `extractable: false`; `clientKeyId` is SHA-256 over
  the DER SPKI **bytes**, matching the daemon's `sessionClientKeyId`. Key/`sign` parameter
  types are read off `crypto.subtle` because this package compiles under `lib: ES2024`
  with no DOM lib.

## Gotchas

- `Origin` is deliberately never set in `headersFor`: it is a forbidden fetch header, so
  setting it was inert in a browser and falsely satisfied the daemon guard from Node. A
  non-browser caller must supply it through `options.fetch`.
- `TransportOptions.wireProtocolVersion` is caller-supplied on purpose — importing the
  generated constant here would hand an ungated build the string it failed to match.
- `generated-coverage.test.ts` pins **two goldens** you must update after regenerating:
  `GENERATED_FILE_SHA256` and `CONTRACT_DIGEST`. Any registry change in `@moe/contracts`
  reds this file by design.
- `control-room-client-runtime-entrypoint.test.ts` spawns real child Node processes and
  audits the `.js` bridges: it asserts exact bridge bytes for every non-test module
  (generated output included) **and** pins the excluded test files by name and reason, so
  adding a test file here means editing that map.
- `tests/security/boundary-roster.security.ts` pins `"packages/control-room-client": 2` —
  `CONTROL_ROOM_TRANSPORT_LAYER` and `SESSION_KEY_LAYER`. A third `export const *_LAYER`
  reds the security lane.
- `apps/daemon/src/http/http-listener-read-dispatch.test.ts` walks the control room's module
  graph across the single bare specifier `@moe/control-room-client` into `src/index.ts`;
  `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json`.
- The daemon's V2 readiness evidence re-derives the surface bytes and refuses
  `V2_EVIDENCE_CONTRACT_DIGEST_STALE` when they do not hash to `GENERATED_CONTRACT_DIGEST`.
- `generator-determinism.test.ts` emits only into `os.tmpdir()`; never write generator
  scratch under the repo root.

## Testing

- One file, from the repo root: `pnpm vitest run packages/control-room-client/src/client-compat.test.ts`
  (root config includes `packages/**`, `environment: "node"`). Whole package:
  `pnpm --filter @moe/control-room-client test`.
- The entrypoint test needs a real child Node with `--experimental-strip-types` — vitest
  rewrites `./x.js` back to `.ts`, so no other suite can see a missing bridge.
- Outside coverage: `tests/integration/control-room/control-room-transport.test.ts` (starts
  a real daemon and compares the transported payload to the in-process handler),
  `tests/integration/distribution/distribution-packaging.test.ts`, `pnpm test:security`
  (`boundary-roster`, `runtime-provider-control-room`, `transport-hostile-fixtures`), and
  the `apps/control-room` suite for the live ports.
- `tests/e2e/control-room/session-key-signing.spec.ts` is the only arm proving a *real*
  browser's Ed25519 agrees with the daemon's verifier: Playwright plus a running daemon and
  Vite serving this `session-key.ts`.
