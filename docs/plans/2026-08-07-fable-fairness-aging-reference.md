# Scheduler Fairness Aging Reference Model (DEVELOPMENT_ONLY / NOT_CONFIRMATORY)

- **Author:** Fable (`claude-fable-5`).
- **Status:** DEVELOPMENT_ONLY executable reference. **NOT_CONFIRMATORY** — this is an
  engineering aid that pins the *semantics* of scheduler fairness aging and forced-cohort
  starvation prevention. It is **not** the production scheduler, **not** a benchmark
  fixture, and **not** confirmatory benchmark evidence (per the benchmark spec's Phase-1
  labeling rule). It lives under `packages/testkit/src/scheduler-fairness/**`, adds no
  dependency and no public package export, and is imported only by its own tests.
- **Authority pins (read-only, unmodified):**
  - Technical design `2026-08-05-moe-rebuild-design.md` §8.4, SHA-256
    `1D9D1EC97D3F07247FBBC088045E0BA2FD6DA8307F10A9026C55106419383191`.
  - Benchmark `2026-08-05-moe-best-tool-benchmark-spec.md`, SHA-256
    `A62B90436CC0B911FB28526AF7B7E0F2D1370F6F93DB91C26077F6E2956A589C`.

## Purpose

Design §8.4 promises that scheduling is "starvation-bounded under declared capacity" via a
per-dimension `FairnessTicket` mechanism layered over the WDRR rings. This model captures
the **starvation-proof half only** — compatible-opportunity aging and the forced cohort —
as a deterministic, pure, event-sourced reducer with fail-closed inputs. It does **not**
model the WDRR goal/role rings (ordinary share); where an ordinary (non-forced) selection
is needed, the reference uses a documented deterministic priority-then-`workItemId` order
as a stand-in and says so — the starvation guarantee comes from the forced lane, not that
stand-in.

## Model shape

A pure reducer over an immutable `FairnessState`, scoped to caller-confirmed facts only —
it **never infers** readiness, compatibility, capacity, or authority (design §8.4: "Dispatches
on incompatible or unavailable capacity do not count"). Every output is deeply frozen; no
input is mutated. Restart/replay is a canonical round-trip of the reduced state.

### Events (all caller-confirmed)

- `ADMIT { ticketId, workItemId, dimension, startingPriority? }` — a continuously
  dispatchable, compatible ticket becomes eligible (default `startingPriority` = `P3`).
- `COMPATIBLE_DISPATCH { winnerTicketId, bypassedTicketIds }` — a committed dispatch of
  `winnerTicketId` using a slot in its dimension; the caller **confirms** the exact set of
  other continuously-dispatchable, compatible tickets that could have consumed that slot
  (`bypassedTicketIds`). Each accrues one **compatible bypass opportunity**; the winner is
  removed. An incompatible/unavailable dispatch is modeled simply by a `bypassedTicketIds`
  set that omits the tickets it does not apply to (nothing is inferred).
- `LOSE_DISPATCHABILITY { ticketId }` — closes the ticket's continuous segment; it leaves
  the active forced cohort if forced, but **promotion/bypass/forced-earned history is kept**.
- `REGAIN_DISPATCHABILITY { ticketId }` — opens a new segment (new eligibility event); if
  still forced it **rejoins the forced cohort at the tail** with a new entry event; churn
  can never improve priority.
- `TERMINATE { ticketId }` — dispatched/terminal; removed entirely.
- `RAISE_CAP { newMd, migrations? }` — see cap rule below.

### Priority ladder

`P0` (highest) → `P1` → `P2` → `P3`. A ticket promotes **one class after exactly eight**
compatible bypass opportunities; eight further at `P0` append it to the dimension's forced
cohort. `bucketsToForced(P3)=4, P2=3, P1=2, P0=1, forced=0`.

### Forced cohort

Served **before** the ordinary lane, FIFO by immutable `forcedCohortEntryEvent`, then
`workItemId`. Continuous-eligibility age is display evidence, never a selection key. A
later arrival, re-entry, or weight change can never move ahead of a continuously
dispatchable forced ticket.

### Bound evidence (no wall-clock)

- **Before forced:** conservative bound `≤ 8·c + M_d`, where `c = bucketsToForced(priority)`
  (whole remaining buckets, counting the current partial bucket as a full eight).
- **Once forced:** exact remainder `= F_ahead + 1`, where `F_ahead` is the count of
  dispatchable forced tickets strictly ahead in the active cohort.

Both are opportunity/selection counts, never times.

### Capacity `M_d`

Default `10,000` (design §8.4 project-wide ceiling). At most `M_d` continuously dispatchable
tickets. `ADMIT` rejects **before any element traversal** — an O(1) `dispatchableCount` check
that precedes the duplicate scan, so the 10,001st admission fails without touching the ticket
list. `REGAIN` applies the same O(1) count check, but only **after** locating the ticket, so a
regain of an unknown/already-dispatchable ticket returns the precise `FAIRNESS_UNKNOWN_TICKET`/
`FAIRNESS_STALE_EVENT` rather than masking it as a cap error. A `RAISE_CAP` returns
`CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION` unless every live dispatchable ticket is
drained or carries an equal-or-tighter migration bound.

### Single dimension per state

A `FairnessState` is scoped to one compatibility dimension `d`. `ADMIT` rejects a differing
`dimension` (`FAIRNESS_MALFORMED_EVENT`) and the codec rejects a snapshot whose tickets span
dimensions — the stored `dimension` is enforced, not decorative.

### Restart validation (codec trust boundary)

`fromCanonicalBytes` is strict: exact key sets (no missing/extra fields), valid priority,
`bypassesInLevel ∈ 0..7`, the `forced ⟺ P0/0` reducer-reachability invariant, the
`forcedCohortEntryEvent ≠ null ⟺ forced ∧ dispatchable` active-cohort invariant, id
uniqueness, `dispatchableCount` consistency, and `eventSeq ≥ max(continuousEligibilityEvent,
forcedCohortEntryEvent)` across tickets — the last guards the FIFO order so a tampered snapshot
cannot let a resumed forced ticket overtake an earlier one. Any violation → `FAIRNESS_MALFORMED_STATE`.

### Fail-closed reason codes

`FAIRNESS_MALFORMED_EVENT`, `FAIRNESS_DUPLICATE_TICKET`, `FAIRNESS_UNKNOWN_TICKET`,
`FAIRNESS_STALE_EVENT`, `FAIRNESS_INVALID_PRIORITY`, `FAIRNESS_TICKET_CAP_EXCEEDED`,
`CAP_RAISE_REQUIRES_DRAIN_OR_TIGHTER_MIGRATION`, `FAIRNESS_MALFORMED_STATE`. Every result is
a `{ ok: true, … } | { ok: false, issues }` union; no partial mutation on failure.

## Files (each < 400 lines; most < 250, split by responsibility)

- `fairness-model.ts` — types, reason codes, DEVELOPMENT_ONLY banner.
- `fairness-policy.ts` — `M_d` default + resolution, priority ladder helpers.
- `fairness-internal.ts` — deep freeze, deterministic compares, guards.
- `fairness-reducer.ts` — `applyEvent` / `reduceEvents` (admit/dispatch/lose/regain/terminate/raiseCap).
- `fairness-selection.ts` — forced order, `selectNext`, `conservativeBound`, `exactRemainder`.
- `fairness-codec.ts` — canonical restart round-trip (reuses testkit `canonicalize`).
- `index.ts` — internal barrel (not wired into the package's public `index.ts`).

## Non-goals

WDRR ring modeling, `SAFETY_EMERGENCY` suspension, resource-queue aging, wall-clock, and any
production wiring. This reference proves the aging + forced-cohort starvation bound only.
