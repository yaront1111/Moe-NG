# task-371c80bd94094db48b15d32eb8e4b931 — worker handoff (steps 6-9)

Live control-room timing consumer edge, SPIDR slice 2 of 3 of `task-1eeb2dcc`.
Steps 1-5 landed in a prior session; this session did 6-9. The architect handoff
that preceded this file is preserved in the plan's step notes.

## The plan's file names DRIFTED from what shipped

The plan names `apps/control-room/src/performance/live-timing.ts` throughout.
Step 2 landed it as **`wire-timing.ts`** and recorded that in its note. So:

- bridge: `src/performance/wire-timing.ts` (224 lines)
- bridge spec: `src/performance/wire-timing.test.ts`
- step-6 sweep: `src/performance/wire-timing-cases.test.ts` (new this session)
- production consumer: `src/live/live-command-timing.tsx` — **not**
  `recovery-actions.tsx`, which step 4 measured as reachable from ZERO
  application roots (only from an a11y fixture imported by three test files).

Anyone reading the plan cold will look for files that do not exist.

## Where the sweep's honesty lives

4 phases x 7 outcomes = 28. **23 driven, 5 excluded**, all three literals
hand-written and asserted before iteration, plus a set-equality assertion that
driven-keys ∪ excluded-keys equals the generated cross product.

The 5 exclusions are UNREACHABLE through `buildLiveTimingReceipt`, not skipped,
and each premise is pinned by its own assertion rather than left as prose:

- `server` x TIMING_CLOCK_UNAVAILABLE — server pairs two WIRE readings; no
  `readWireObservation` arm can answer that code.
- `render`/`human` x TIMING_CLOCK_MISMATCH — both ends come from
  `readClientClock`, which stamps `CONTROL_ROOM_CLOCK` on every known reading.
- `render`/`human` x TIMING_UPSTREAM_UNKNOWN — a client reading carries no
  upstream carrier; only a wire reading can.

Driving them would have meant minting a reading no producer in the module can
make. See `mem:gotcha-unreachable-guard-needs-a-direct-production-pin`.

## The sharpest measured result on this task

Drill 2 deleted the `from.clock !== to.clock` guard in `pairing()`. The
BACKWARD-skewed cross-clock cases still refused — they fell through to
`TIMING_NEGATIVE_INTERVAL` — while the FORWARD-skewed ones returned
`known: true`, i.e. a plausible confidently wrong duration.

**The negative-interval guard covers only half of cross-clock skew.** That is
why every cross-clock test here uses forward skew; a backward-skew fixture would
have stayed green with the real guard deleted. Generalised in
`mem:gotcha-guard-order-mutant-survives-when-only-one-guard-can-refuse`.

## Defect found by adversarial self-review, fixed in commit 4932d9b

`testIdPrefix` was `cr.live.timing.<commandId>`. **One command emits many
events**, so two rows of one command painted two receipts under one
`data-testid` — two distinct receipts, built from two different reading sets,
that nothing could tell apart. `getByTestId` throws on the collision, so the
next test to look would have broken rather than reported it.

Reproduced through the production surface first (a throwaway two-row probe
returned `getAllByTestId(...).length === 2`), then fixed to
`cr.live.timing.<commandId>.<eventId>`. Command id still attributes; event id
disambiguates. Cost: `phaseId`/`phase` helpers in `live-timing-path.test.tsx`
and `live-command-timing.test.tsx` gained an event segment.

**Generalisable:** an id built from a business key is unique only if that key is
unique per rendered node. Command id is not — it is one-to-many with events.

## What the production receipt honestly reports

`render` measures. `server` and `stream` BOTH refuse TIMING_CLOCK_MISMATCH in
production — store commit clock vs daemon wall clock, and daemon wall clock vs
the browser clock. That is not missing wiring; it is the daemon's own
`event-stream-observation.ts` header enforced. `human` is TIMING_SOURCE_ABSENT
until an operator acts. Do not "fix" these into numbers.

## Gate state at handoff

- `pnpm --filter @moe/control-room test` — 68 files / 845 tests, exit 0
- `pnpm --filter @moe/control-room-client test` — 6 files / 41 tests, exit 0
- both owned packages `typecheck` exit 0
- repo-wide `pnpm typecheck` — RED, entirely foreign: worker-40286572's
  UNTRACKED `apps/daemon/src/activation/foundation-launch-authority.test.ts`
  (task-996e5318, mid-TDD). Went 5 -> 4 -> 1 errors while I watched. `@moe/daemon`
  has no dependency edge to `@moe/control-room`. See
  `mem:gotcha-shared-worktree-foreign-red`.

## Commit archaeology QA will need

A foreign whole-tree hook committed my step-6 file into **702b28a**, which is
LABELLED for a peer's task (task-bdb80e99, "Bound the import dependsOn graph
walk"). The label is wrong; the bytes are mine. My own commit is **4932d9b**.

**Diff against base ref `ab45234`, not against commit labels.** That range also
contains a concurrent sibling's `effort-*` files (slice 3, task-bcae0b7e) and
peer edits to `packages/control-room-client/src/client-transport.ts` — none of
which are this task's. This task's files are exactly: `timing.ts`,
`timing.test.ts`, `wire-timing.ts`, `wire-timing.test.ts`,
`wire-timing-cases.test.ts`, `live-event-feed.ts`, `live-event-feed.test.ts`,
`live-command-timing.tsx`, `live-command-timing.test.tsx`,
`live-timing-path.test.tsx`, `live-app.tsx`, `command-latency.tsx`.

`packages/control-room-client/src/generated/generated-client.ts` is byte-identical
to `ab45234` — the codegen hazard the architect flagged never bit.
