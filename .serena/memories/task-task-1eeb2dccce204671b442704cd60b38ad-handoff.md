# task-1eeb2dcc — Live command timing and decision-effort instrumentation (DELIVERED, then REOPENED, then re-gated)

Reopen pass by worker-fd8f822b at HEAD 8ad396a. The deliverable was already correct and already
committed as **ac29c55** (3 files, +489/-0, all `apps/control-room/src/live/**`). The reject was
about the GATE, not the design — QA said so explicitly and had independently re-run the attribution
drill itself. This pass wrote **zero production bytes**.

## What the deliverable is (unchanged; supersedes nothing above this line)

Three of the four gaps the task description named were already closed by the children:
`evaluateTiming` has non-test callers, `StreamEvent` carries `commandId` + `decisionTrace`.
The fourth and unnamed one was the real work: the whole effort family
(`effort-records/admission/collector/intervals`) had **ZERO live consumers**.

- `live-effort-edge.ts` (234 lines) — dispatch-side seam, symmetric to how `live-event-feed.ts`
  wired `wire-timing.ts` into the poll side.
- one call at the top of `dispatchAffordance` in `live-dispatch.ts` (271 -> 279 lines, 8-line diff).
- `live-effort-path.test.tsx` (247 lines, 7 cases) — renders `LiveControlRoom`, clicks the board's
  own Dispatch button, reads what production recorded.

**ONE ADMISSION DOOR** is the design decision the task turns on: the edge hands the demand word to
`shapeEffortObservation` VERBATIM and never pre-filters. An edge-side filter would move the refusal
out of `effort-admission.ts:134` and leave the DoD-6 drill green while looking correct.

## THE REJECT AND WHY THE NAMED FIX WAS WRONG BY THE TIME I READ IT

QA rejected on DoD 6: `verification.command` recorded 3 of the 4 legs, dropping
`pnpm --filter @moe/daemon test`, and that dropped leg was the red one. Root cause was real —
`apps/daemon/src/recovery/effect-inventory.test.ts` was an orphan (test present, module absent),
swept into HEAD by the whole-tree completion hook commit **98d6e72** that bears this task's id.
(Two commits carry this task's name: `ac29c55` is the hand-committed deliverable; `98d6e72` is the
hook's whole-tree sweep. Do not confuse them.)

QA's fix instruction was "get that test out of HEAD". **Re-measuring first is what saved it**:

    git cat-file -e HEAD:apps/daemon/src/recovery/effect-inventory.ts   -> EXISTS
    git cat-file -e HEAD:apps/daemon/src/recovery/effect-inventory.js   -> EXISTS

`cdd53e4` had landed the module in between. Deleting the test would have deleted a landed peer test.
`pnpm --filter @moe/daemon test` is now **exit 0, 89 files / 1820 tests** with nothing removed.
See `mem:gotcha-a-qa-fix-instruction-goes-stale-like-any-other-premise`.

## Gate, four legs run fresh as ONE chain after the drills were restored

    pnpm --filter @moe/daemon test && ... control-room-client test && ... control-room test
      && pnpm --filter @moe/control-room typecheck        -> CHAIN_EXIT=0
    daemon 89/1820 · client 6/41 · control-room 70/860 · control-room tsc Done

Repo-wide `pnpm typecheck` is **exit 1 in apps/daemon ONLY** and foreign, disclosed verbatim:
`daemon-entry.ts(176,5)` and `(191,3)` from **8d9afb8** (`(options.csrfToken ?? "") === "" ? ... `
does not narrow the false arm), `session-services.test.ts(173,15)` from **7eb2997**. Both commits
post-date merge-base 598b792 (`git merge-base --is-ancestor` says NOT ancestor for both); my diff is
3 control-room files; intersection with owned paths EMPTY. Every other package prints "Done".

## Drills (DoD 6), all run fresh this pass, all red on a LIVE test by name

- **A** `wire-timing.ts:208` render pairing forced to `input.received` at both ends ->
  live-timing-path.test.tsx:147 `expected '0' to be '30'` at :149:51. Assertion, not a crash.
- **B1** `effort-admission.ts:134` membership gate weakened with `?? (demanded as never)` ->
  live-effort-path.test.tsx:224 `expected [] to have a length of 1` at :229:21.
- **B2** the layer stamp at `:58-60` flipped to the collector layer ->
  `expected 'CONTROL_ROOM_EFFORT_COLLECTOR' to be 'CONTROL_ROOM_EFFORT_ADMISSION'` at :231:39 AND
  :244:39. This arm is what proves ADMISSION is the layer that answers — without it, B1 alone does
  not exclude a different layer having refused first.
Restored by Edit, verified by sha256: `effort-admission.ts` ae3f4faa…, `wire-timing.ts` ebb4a7b3….
Never `git checkout`.

## OPEN HAZARD FOR THE CONSUMER — read this before pairing timestamps

`live-effort-edge.ts:201` stamps `observedAt` with raw **`Date.now()`**, while the timing side binds
every reading to `CONTROL_ROOM_CLOCK` through `readClientClock` against an **injected** `Clock`
(`ClockProvider`/`useClock` in `command-latency.tsx`, refuses `TIMING_CLOCK_UNAVAILABLE` when absent).
Left as-is deliberately: the effort vocabulary models provenance as `source` (EFFORT_SOURCES) and
carries no clock identity, so binding one means re-declaring frozen vocabulary; the edge does no
subtraction, so nothing here violates DoD 1; and `recordDispatchEffort` is called from a plain async
function that cannot use a hook, so the clock would have to enter through the public `DispatchInput`.
**A consumer must never pair an effort `observedAt` (wall clock) with a timing reading
(CONTROL_ROOM_CLOCK, virtual under test) without an explicit binding.**

Also deliberately absent, same reason as before: focus/away intervals and recovery burdens. The
dispatch seam sees ONE instant; an unclosed FOCUS interval would emit `EFFORT_INTERVAL_OVERLAPPING`
on every later dispatch.

## Consumer (Clause 1)

**task-b937811e8b72459ea169e5fff1238ce1** (Benchmark telemetry harness), via
`liveEffortDecisions()` / `liveEffortObservations()` / `liveEffortRefusals()`. It is also the right
home for the intervals and recovery burdens, and it owns the clock hazard above.
