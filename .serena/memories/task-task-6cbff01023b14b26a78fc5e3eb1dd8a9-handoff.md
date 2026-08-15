# Durable Claude attempt dispatch — SHIPPED (commit 5e72476, 2026-08-16)

Five owned paths landed in `apps/daemon/src/work/`: `foundation-attempt-contracts.ts/.js`,
`foundation-attempt-service.ts/.js`, `foundation-attempt-service.test.ts`. 16/16 tests green.

## Public surface downstream tasks compose
- `createFoundationAttemptService({ captureResult, launch?, launchOptions?, store })` -> `{ dispatch(input) }`
- `readFoundationAttemptRecord(store, attemptAggregateId)` — callers name the **activation**
  aggregate; the dispatch aggregate is derived internally and never accepted from outside.
- Request is an exact 5-key record: `activationRequestBytes`, `binding`
  `{attemptAggregateId,nodeKey,sessionId}`, `graphSnapshot`, `inputManifest`
  `{baseIdentity,entries}`, `launchTemplate`
  `{argv,bootstrapCredentialDigest,cwd,environment,launchSelection,limits,runtime}`.
- Layer `DAEMON_FOUNDATION_ATTEMPT`; 15 codes in `FOUNDATION_ATTEMPT_CODES`. Producer refusals
  (activation ingress, scheduler, runner workspace/launcher) keep THEIR code + layer verbatim.

## The load-bearing design fact
Activation AND the launch-authority transitions are both idempotent — each can answer REPLAYED
with the same durable bytes — so **neither is a single-invocation fence**. The fence is an
expected-version-0 reservation on a SEPARATE derived aggregate
(`deriveDispatchAggregateId`). It must not live on the activation aggregate: versions 1..3 there
already belong to GRANT_CONSUMED / PREFLIGHT_REGISTERED / PROCESS_OBSERVED. Only a fresh DECIDED
reservation launches; REPLAYED adopts the stored record or returns
`FOUNDATION_ATTEMPT_DISPATCH_IN_PROGRESS`. Final record appends at expected version 1 and is
**re-read and byte-compared** — the candidate is never echoed.

## Two real defects this work found
1. `decodeFoundationAttemptRequest` originally read `outer[key]` before snapshotting, so a
   **top-level getter WAS invoked**. Fixed: the descriptor walk now starts at the outermost slot.
   The nested `snapshot()` alone does not protect the top level.
2. A single `contained()` requiring a native promise for both ports turned every **synchronous**
   capture answer into a false `CAPTURE_UNKNOWN`. Now parameterised: launch must return a promise,
   capture may answer sync; a non-native thenable is never awaited either way.

## Gate state at handoff
Owned scope green. Foreign red disclosed, all outside owned paths:
`src/telemetry/provider-run-codec.ts(224,44) TS18047` (task-fc658104, landed mid-session — this
alone reds `pnpm typecheck`, `verify:foundation`, `verify:store`), plus 5s-timeout flakes in
`packages/runner/src/runtime-entrypoint.test.ts` and `packages/testkit/src/foundation/*`.

## Open item for QA/owner
Both production files exceed the plan's step-7 `-le 250` shell gate (contracts 359, service 294)
while staying under the 400 split threshold the epic/task rails actually set. ~510 lines of
non-comment code cannot fit 250+250 without a third production module, which the five owned paths
forbid. Not hidden, not worked around — needs an owner decision if strict 250 is wanted.

Related: `mem:decision-foundation-dispatch-reservation-and-result-capture`,
`mem:gotcha-per-file-line-gate-can-be-stricter-than-the-rail`,
`mem:gotcha-slow-fs-makes-5s-vitest-timeouts-look-like-failures`.
