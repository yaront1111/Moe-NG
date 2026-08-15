# Handoff: task-b4f12e63baca4ecc9f2c159ed3c3ad78 (Reusable core session authentication seam)

## Status
Plan submitted 2026-08-09, accepted into AWAITING_APPROVAL (SPEED auto-approval). 7 steps,
7 distinct affectedFiles (5 actually edited; 2 are read-only reference files), 3 new files.
Daemon warned on file count (target <=5, reject >10) — informational only.

## Remeasured baseline (do not trust the description, re-grep if stale)
- `authenticate-session.*` genuinely ABSENT. Gap is real.
- `authenticate-command.ts` = 196 lines; `identity-session.ts` = 183; `identity-capability.ts` = 145;
  `identity/index.ts` = 39; `packages/core/src/index.ts` = 221.
- Baseline gate green: `pnpm --filter @moe/core test` = 16 files / 239 tests.
- `createRuntimeError` (packages/contracts/src/runtime/runtime-error-factory.ts:93) accepts only
  `{code, correlationId, details, source}`. **RuntimeError has NO `layer` field.**

## Live precedence in authenticateCommand (the acceptance oracle)
1. `bindingsHold` false -> AUTHENTICATION_FAILED
2. `verifyProof` throws OR `!== true` -> AUTHENTICATION_FAILED
3. `checkReplay` throws OR value not "FRESH"/"REPLAYED" -> AUTHENTICATION_FAILED
4. `replay === "REPLAYED"` OR `!isCurrentGeneration` -> SESSION_REPLAYED
5. `session.status !== "ACTIVE"` -> SESSION_REPLAYED
6. `!isSessionUsableAt` -> SESSION_EXPIRED
7. transport not in `session.transportIds` -> **CAPABILITY_DENIED** (looks like a capability check, is not)
8. `matchCapability` + `STEP_UP_WINDOW` -> CAPABILITY_DENIED

Guards 1–7 move to the new seam. Guard 8 STAYS in `authenticateCommand`.

## Planned seam
`authenticateSession(input): SessionAuthenticationResult` in `identity/authenticate-session.ts`.
- Refusal arm `{ok:false, code, layer}` has **no facts key at all** — zero authority is type-level.
- `SESSION_AUTH_LAYERS` = BINDING, PROOF, REPLAY, GENERATION, SESSION_STATE, EXPIRY, TRANSPORT.
- Returns a **code string, not a RuntimeError** — keeps the seam pure (task rail 1);
  `authenticateCommand` maps it through its existing `deny()` so the RuntimeError is byte-identical.
- Layer is deliberately DISCARDED by `authenticateCommand`: RuntimeError has no layer field and
  adding one changes a public contract shape, which DoD 3 forbids.
- Envelope-free: takes scalars `requestId` / `requestDigest` / `presentedCredentialId`, which
  `authenticateCommand` fills from `envelope.commandId` / `.requestDigest` / `.sessionCredential`.
  This is how a non-command caller authenticates without fabricating a RuntimeCommandEnvelope.
- `PresentedProof`, `ProofChallenge`, `ReplayOutcome` MOVE here and are re-exported from
  `authenticate-command.ts`, so `identity/index.ts`'s existing export block stays unchanged.

## Owned-path swap (flagged for QA)
Description listed `packages/core/src/index.ts`. Plan edits `packages/core/src/identity/index.ts`
instead and leaves the root untouched. Root line 221 is `export * from "./identity/index.js";` and
lines 217-220 record an explicit in-repo decision that identity publishes through its curated area
seam so the surface is not duplicated. Net root surface identical; the new test proves it by
importing `../index.js`. See `mem:decision-core-identity-publishes-through-its-area-seam`.

## Non-obvious traps
- `.js` files here are **byte-exact bridges**, not build output: `export * from "./<name>.ts";` + one
  LF. `runtime-entrypoint.test.ts` compares bridge bytes through utf8 — a CRLF bridge fails there
  while `git diff --stat` shows nothing.
- The envelope read is itself a guard: `input.envelope?.correlationId ?? ""` means a null envelope
  denies with correlationId `""`. Reading `envelope.commandId` eagerly would throw instead of deny.
- The seam must `isNonEmpty`-check its three scalars itself; inside `authenticateCommand` the decoder
  upstream had already guaranteed them, a coordination caller has no decoder.
- No exact export-count assertion exists on the root namespace (`runtime-entrypoint.test.ts` uses
  `toBeGreaterThan` + filters), so adding exports does not redden it.

## Exact gate
`pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test && pnpm typecheck`
Final leg is repo-wide in a shared working directory — apply the path-attributed baseline rail
(merge-base failures vs HEAD failures, intersected with owned paths) before treating red as ours.

## Consumer edge (Clause 1, option a)
`task-21713cf152c047c597da9765d8d95510` "Durable daemon session authority" — its description states
"Depends on task-b4f12e63baca4ecc9f2c159ed3c3ad78" and it owns
`apps/daemon/src/identity/session-authority*.ts`, where the real proof verifier and durable replay
guard land. Downstream: `task-04e4367443214a588ed6277b92969a33`, then
`task-4afcb06422ed4adb89430b7ea9758d7f`.


## Worker execution update (2026-08-09)
- Claimed by `worker-d61b2685`; step 1 completed.
- Fresh baseline: `pnpm --filter @moe/core test` exit 0, 16 files / 239 tests.
- No owned source or test file was edited.
- Task is BLOCKED at step 2 because the approved plan says `REFUSAL_CASES.length === 9` while enumerating 10 distinct required cases. Step 6 also names the length-9 mutation drill.
- Block reported through `moe.report_blocked`; governor/architect amendment requested. Resume only after the plan pins one consistent count (likely 10) or explicitly removes one enumerated table entry.


## Final worker handoff (2026-08-09)
- Implemented and published the pure `authenticateSession` seam through `packages/core/src/identity/index.ts`; `authenticateCommand` composes it before unchanged capability/step-up admission. Named consumer: task-21713cf152c047c597da9765d8d95510 (Durable daemon session authority).
- Refusals are frozen zero-authority `{ok,code,layer}` arms across the exact seven layers. Proof requires literal `true`; verifier/replay throws and unknown replay deny. Records/scalars are snapshotted before callbacks, including a cloned/frozen transport list so a verifier cannot mutate transport authority mid-decision.
- Focused suite is 24 tests; full core gate is 18 files / 279 tests. Mutation drills reddened every planned guard, the exact-10 case count, seven-layer set, truthy verifier, scalar guards, layer values, and transport-list callback mutation.
- Exact completion gate passed fresh: `pnpm --filter @moe/core typecheck && pnpm --filter @moe/core test && pnpm typecheck` exit 0. `pnpm verify:foundation` passed 26/411 and `pnpm verify:store` passed 32/357. Root `pnpm test` is separately foreign-red only at `packages/scheduler/src/package-boundary.test.ts` (scanner error on daemon-main.ts) and `packages/runner/src/recovery-inventory/recovery-inventory.test.ts` (__proto__ case); neither intersects owned paths.
- Final owned bytes are clean vs HEAD. Production lines: authenticate-session.ts 233, authenticate-command.ts 126. Exact bridge remains 43 bytes, LF-only. Final hashes: session source FB77FA37D9B986D2FFC8EA3AE046BE2886AE58948A1B0BCE1B9A23B7BF11A940; test E726583179E62097F997FB98FB2AFF7D899E8FA9C2093A6C183B5D637785878A; bridge 93C3629BB459090B85E544076B84442EBE71FB47A3F30ADF37DEF7235560D9AA.
- Shared-tree attribution: foreign completion commits 462a610 and 7d8d0f8 swept earlier owned bytes. Final hardening landed by explicit pathspec in 832eb0b and contains only the two owned session files. Review the full task from base ref `a423722082d9700494009029a8cdb0b115ebdfe8` with `git diff a423722..HEAD -- <five owned paths>`; do not require a single task-id commit for all bytes.
- Moe status moved to REVIEW successfully after `moe.complete_task`; QA handoff accepted by runtime.