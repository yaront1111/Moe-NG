# task-371c80bd94094db48b15d32eb8e4b931 — QA verdict: APPROVED

Live control-room timing consumer edge (SPIDR slice 2/3 of `task-1eeb2dcc`).
Reviewed by qa-4ec0a625 at HEAD 79dcf18, base ref `ab45234`.

## Gate, re-run by QA, each leg with its OWN exit code

- `pnpm --filter @moe/control-room test` — 68 files / 845 tests, EXIT 0
- `pnpm --filter @moe/control-room-client test` — 6 files / 41 tests, EXIT 0
- `pnpm typecheck` — EXIT 0, `Scope: 18 of 19 workspace projects`, zero `error TS`

**The foreign red the worker disclosed had CLEARED by review time.**
worker-40286572 landed `apps/daemon/src/activation/foundation-launch-authority.ts`
(task-996e5318), so the plan's full named chain was green as written and no
path-attributed substitution was needed. Worth re-running the foreign leg rather
than accepting a substitution on trust — the substitution can be obsolete.

## The DoD-1 deviation was UPHELD, and re-measured independently

The plan named `recovery-actions.tsx` as "the only production surface that
already renders CommandLatency". True, and irrelevant: that surface is reachable
from ZERO application roots. Measured chain:

- `recovery-status.tsx` + `reconciliation-inventory.tsx` import it
- both are imported ONLY by `src/a11y/ui-wide-ops-fixtures.tsx` and their own specs
- `ui-wide-ops-fixtures.tsx` is imported by exactly 3 files, all `.test.tsx`

Worker shipped the consumer at `src/live/live-command-timing.tsx` instead. Real
chain traced by QA: `main.tsx:40` -> `LiveControlRoom` -> `live-app.tsx:211`
`LiveTimeline` -> `live-app.tsx:83` `LiveCommandTiming` -> `buildLiveTimingReceipt`
-> `evaluateTiming`. `describeTimingReceipt` gains its production caller at
`command-latency.tsx:107`. Both evaluator entry points now have real consumers.

See `mem:gotcha-a-production-component-can-be-fixture-only-reachable`.

## Four mutation drills, run by QA, each hash-checked back to pre-drill bytes

1. **Render timestamp bypassed** (literal instead of `readClientClock(useClock())`)
   — exactly 1 red: "measures the render phase from readings production took, not
   from a literal", `expected '1786276799999' to be '30'`. The test reads
   production's value, not its own.
2. **Cross-clock guard disabled** (`from.clock !== to.clock && false`) — 3 red,
   and they redden on the REFUSAL assertion: `expected true to be false` and
   `expected undefined to be 'TIMING_CLOCK_MISMATCH'`. Confirms the worker's
   forward-skew finding: with the guard gone the pair returns a confident WRONG
   duration rather than falling through to TIMING_NEGATIVE_INTERVAL.
3. **Upstream refusal collapsed to READING_ABSENT** — 6 red, all exact-code:
   `expected 'TIMING_SOURCE_ABSENT' to be 'TIMING_UPSTREAM_UNKNOWN'`.
4. **eventId dropped from `testIdPrefix`** — the worker's self-reported
   regression test goes red. Over-reddening (14/15) is structural, not a broken
   environment: the testId is every lookup's anchor.

## The 5 sweep exclusions survived attack

23 driven + 5 excluded = 28, all literals hand-written and asserted before
iteration, plus set-equality of driven ∪ excluded against the cross product (so a
future exclusion cannot be added silently). File executes 30 tests, exit 0 — the
cardinality is not vacuous.

I could not mint a driving reading for any exclusion:
- `server` x CLOCK_UNAVAILABLE — `readWireObservation` has 4 arms, none answers it
- `render`/`human` x CLOCK_MISMATCH — `readClientClock` is the only client-reading
  producer and unconditionally stamps `CONTROL_ROOM_CLOCK`
- `render`/`human` x UPSTREAM_UNKNOWN — only the wire arm builds a carrier

Each premise has its own live assertion rather than being left as prose.

## server AND stream both refusing TIMING_CLOCK_MISMATCH is CORRECT

Not incomplete wiring. `apps/daemon/src/http/event-stream-observation.ts:20-26`
states the two readings "must never be collapsed into one or subtracted from each
other here ... their difference is not a duration". The receipt enforces the
daemon's own contract. Only `render` measures; `human` is TIMING_SOURCE_ABSENT
until an operator acts. **Do not let a later task "fix" these into numbers.**

## Hygiene

- committed bytes == gated bytes: 8/8 tracked owned sources MATCH via
  `git show HEAD:<path> | sha256sum` vs working tree
- `packages/control-room-client/src/generated/generated-client.ts` byte-identical
  to `ab45234` — codegen hazard never bit
- per-file lines under the 250 target: `wire-timing.ts` 224, `timing.ts` 245,
  `live-app.tsx` 230, `live-event-feed.ts` 194, `command-latency.tsx` 162,
  `live-command-timing.tsx` 78
- no scratch/probe artifacts in owned dirs
- foreign whole-tree commit `702b28a` carried the worker's step-6 bytes under a
  PEER's task label (task-bdb80e99). Not held against the worker — known hook
  hazard, and the bytes verify.

## Open note for the board, not a defect

The plan's step text still names `live-timing.ts` and `recovery-actions.tsx`.
The step notes record the rename and the reachability finding, so the record is
honest, but anyone reading the plan cold hunts for files that do not exist.
