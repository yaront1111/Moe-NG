# task-a62e3c2d (four-phase timing + shared latency feedback) handoff

## Delivered
- `apps/control-room/src/performance/timing.ts` (190 lines): `Clock`, frozen
  `TIMING_PHASE_NAMES`/`TIMING_UNKNOWN_CODES`, `SurfaceTimingReceipt` with four
  separately named fields, `measureElapsed`, `evaluateTiming`,
  `describeTimingReceipt`. Reads no time API; every reading is caller-supplied.
- `apps/control-room/src/performance/command-latency.tsx` (149): the shared spec
  §11.4 feedback, `ClockProvider`, and the only copy of the line-711 sentence.
- Recovery consumes it; `overTwoSeconds` is gone; `main.tsx` provides a monotonic
  `BROWSER_CLOCK` at the composition root.

## Three things the next agent will otherwise re-derive

**1. `main.tsx` is under an unowned nondeterminism ban.**
`src/scaffold.test.tsx:234` scans `["./fixtures.ts","./kernel.tsx","./main.tsx"]`
against `/Date\.now|Math\.random|new Date\(\)/u`. Any plan that says "main.tsx may
read a real time API" collides with it. `performance.now()` is not in that regex
**and** is the correct API here — it is monotonic, so an NTP step cannot turn a
normal wait into a negative interval. Do not "fix" this by widening the tripwire;
it is not ours.

**2. Do not give `src/performance/**` a clock.** DoD 1 bans `Date.now`,
`performance.now` and `new Date(` in that whole directory, enforced by a
`readdirSync` scan in `timing.test.ts` that asserts the listing equals the module
list — a new module there is caught, not skipped. The clock arrives by context
from `main.tsx`.

**3. `evaluateTiming` sources no timestamps ON PURPOSE.** A monotonic client clock
and a daemon wall clock are not comparable and the `stream` phase straddles both
machines. Caller-supplied `{start,end}` pairs keep the arithmetic honest and turn
skew into `TIMING_NEGATIVE_INTERVAL` instead of a plausible wrong number.

## Honest limits (stated to QA, not hidden)
- The consumer edge is real production code, but **no committed caller passes
  `feedback`** to `RecoveryActions` (`reconciliation-inventory.tsx:132`,
  `recovery-status.tsx:140` both omit it), so `CommandLatency` renders zero times
  today. The local `Feedback` it replaced sat behind the identical condition — no
  regression, and Clause 1 is claimed on the call site being production code.
- **No production supplier for the four-phase receipt can exist yet**: grep of
  `packages/contracts/src/runtime` for `emittedAt|observedAt|receivedAt|timestamp`
  returns ZERO. Inventing a feed would have been the mock-backed journey the rails
  forbid.
- `clock ?? provided` means an explicit `clock={null}` cannot *disable*
  measurement; context wins. Change that line if a surface ever needs to opt out.

## Verification
`pnpm --filter @moe/control-room test` 32 files / 478 tests exit 0; package
typecheck exit 0. Commit `7183c04`, explicit pathspec, exactly 8 owned files.

Five mutation drills, all killed, restores verified by `git hash-object` against
pre-drill captures (never `git status`, never `git checkout HEAD --`): reason-code
swap on `TIMING_SOURCE_ABSENT` (4 red), disabled skew guard (2), swapped
`TIMING_CLOCK_UNAVAILABLE` (4, spanning all three test files), `>` to `>=` on the
2 s boundary (2, only the exactly-2000 half moved), and `describeTimingReceipt`
reduced to one summed total (10 red — all six pairs plus both bare-total guards).

## Shared-tree note
A sibling worked `src/shell/**` (viewport/nav-rail/inspector-sheet/§4.16 reflow)
throughout and held the package gate red for ~15 minutes with a normal TDD red
phase. Baseline measured at claim time was 28 files / 421 tests **exit 0**, so
every failure in between was provably theirs. It cleared on its own.
Related: `mem:gotcha-shared-package-gate-broken-by-sibling-red-file`.
