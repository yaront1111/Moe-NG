# QA verdict: Live control-room seam — APPROVED

qa-812c17a0, 2026-08-09. Commit `369ea08` (17 owned files, +2325/-3). Approved.

## Gates re-run, not read off a status field

- Root `pnpm typecheck` exit 0 (15 workspaces Done).
- Root `pnpm test` exit 0 — 159 files / 2870 passed / 1 skipped / 0 failed.
- Root gate does NOT discover `apps/**` (see `mem:gotcha-root-vitest-skips-apps`), so the
  app suites were run separately as the real evidence for this task's own surface:
  `@moe/daemon` 12 files / 257 tests, `@moe/control-room` 13 / 175,
  `@moe/control-room-client` 3 / 26. All exit 0.
- Per-FILE cap: largest production source 238 lines (`http-contract.ts`); nothing near 400.

## Four QA-original mutants, all killed, all restored byte-identical

The worker reported 22/22 killed. QA did NOT reuse that list; drills naturally target
operators and constants, not statement ORDER (`mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`).

1. **REORDER**: moved `decodeRuntimeCommandEnvelopeBytes` above `authenticate` in
   `http-adapter.ts` -> 3 tests red. The fixture is valid because BOTH guards can refuse the
   same input (`UNDECODABLE_BODY` + unknown credential), which is exactly the condition an
   ordering assertion needs.
2. **Arm flattening**: added `nextCursor` to `gapFrame` in `event-stream.ts` -> the
   `Object.hasOwn(gap, "nextCursor")` test red.
3. **Static ban**: added a `truthStrength` helper to `data-adapter.ts` -> ban test red.
4. **Advisory bypass**: made `receiveAdvisoryMessage` call `transport.sendCommand` ->
   "records a session or terminal message without dispatching anything" red.

Restore verified with `git hash-object` each time: `896f1b10` http-adapter.ts,
`e9a35515` event-stream.ts, `5f91b576` data-adapter.ts. Owned paths clean afterwards.

## What made this pass on assertion quality

- Refusal tests assert the stage AND the stable code, never just "refused".
- Idempotency asserted by STATE (`port.effects.length === 1`, handler calls === 1).
- Gapless resume compared against the RAW ledger id list, not a second call through the same
  seam — a self-comparison would pass even if the seam dropped the same events on both paths.
- The error vocabulary is asserted by SET EQUALITY in both directions.
- The static ban asserts an exact file set, an exact import allow-list, AND non-vacuity
  (`productionFiles().length > 0`).
- Compat is ONE authority with two readers: `WIRE_PROTOCOL_VERSION` is composed from the
  three contract constants at both ends (`mem:convention-one-compat-authority-two-ends`).
  The daemon comparing the composed pin directly is NOT a second compatibility rule.
- Generated client regenerated, not hand-edited: generator template and emitted output carry
  identical added lines; determinism + coverage tests green.
