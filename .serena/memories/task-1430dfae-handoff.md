# task-1430dfae — daemon stream identity + timing observations (DONE, commit 4c39f3a)

Landed the command identity and daemon-observed timing on the daemon event-stream
seam. 8 owned paths under `apps/daemon/src/`.

## What shipped
- `StreamEvent` gained `commandId` + optional `decisionTrace` (6 fields typed as
  plain `string`). It is a STRUCTURAL VIEW — a real `StoredEvent` must stay
  assignable. Never add a field the store record lacks, or you force a
  `packages/store` edit the task rails forbid.
- `WireEvent` gained `identity` (commandId, principal, run, session) and TWO
  observations: `ledgerObservation` (STORE_LEDGER/STORE_COMMIT_CLOCK) and
  `seamObservation` (DAEMON_SEAM/DAEMON_WALL_CLOCK).
- New module `event-stream-observation.ts` owns the closed vocabularies, the
  value/observation types, AND `EVENT_STREAM_LAYER`.

## Gotchas that cost real time here
1. **A new `.ts` module under `apps/daemon/src` needs a physical `.js` bridge**
   (`export * from "./<name>.ts";`). Focused vitest and `tsc` are BOTH blind to a
   missing bridge — vitest rewrites `./foo.js` back to `foo.ts`, tsc never reads
   bridges. Only the child-process probes in `runtime-entrypoint.test.ts` see it.
   Missing it produced 6 failures across 4 files. See `mem:core-js-bridge-requires-index-reachability`
   for the related @moe/core variant.
2. **`Parameters<fn>` of a DEFAULTED parameter carries an explicit `| undefined`**:
   `[.., observer?: SeamObserver | undefined]`. Under `exactOptionalPropertyTypes`
   that is NOT the same as `observer?: SeamObserver`. `expectTypeOf(...).toEqualTypeOf`
   reports the mismatch as `TS2554: Expected 1 arguments, but got 0` — reads like
   an arity bug, is not one. Resolve the real type with a throwaway probe.
3. `apps/daemon/src/index-surface.test.ts` pins a hand-written
   `expect(EXPECTED_EXPORTS.length).toBe(N)` (58 -> 61 here) AND
   `Object.keys(daemon).sort()` equality AND `Parameters<typeof daemon.readEventPage>`.
   Any new runtime export or signature change touches all three.
4. Focused runs need the package config: `pnpm --filter @moe/daemon exec vitest run
   --root . --config package.json src/<path>`. Without it you get
   "No test files found" because the ROOT config excludes apps/**.

## Design constraints future work must not break
- Identity is COPIED, never minted. `session` and `run` do not exist anywhere in
  `packages/store/src` (verified with a positive control) and are emitted as an
  explicit `EVENT_STREAM_IDENTITY_NOT_PROVIDED` unknown at layer SEAM on EVERY event.
- The two readings are separate fields, never collapsed, never subtracted at this
  layer — different clocks in different processes, so a difference is an interval
  plus an unknown offset, not a duration.
- ONE seam reading per frame encode, stamped on every event. Not one per event.
- `EVENT_STREAM_REFUSAL_CODES` is closed and byte-identical; absent facts use the
  separate `EVENT_STREAM_UNKNOWN_CODES`, asserted disjoint. An absent identity is
  NOT a refused frame.
- Identity fields are copied straight while readings are defended
  (`typeof === "string" && !== ""`). Deliberate: the store guarantees non-empty
  identifiers at `packages/store/src/store-rows.ts:31-43`, but `committedAt` can be
  structurally present and semantically unusable.

## Siblings still in BACKLOG
task-371c80bd (live consumer edge) and task-bcae0b7e (decision-effort observations).
Both should plan against the STATED ABSENCE of session/run, not a pending value.
