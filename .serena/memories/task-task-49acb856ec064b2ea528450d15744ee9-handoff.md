# Handoff: Supervisor race and restart hardening gate — 11/11 steps SHIPPED, BLOCKED on a non-quiescent tree

Supersedes the earlier "10 of 11, step 7 blocked" note. Step 7 is DONE and
committed. The task is BLOCKED only because the five-leg verification command
cannot reach exit 0 while three other agents have uncommitted / untracked work
in the shared worktree.

## Step 7, what landed — commit `6844e17`

Seven files, `apps/daemon/src/work/**` only. Tests only; **no production file
changed anywhere in the slice**.

| File | Lines | Role |
|---|---|---|
| `work-race-fixtures.ts` | 92 | `BASE_RECORD`/`BASE_PROOF`, `leaseRecord`/`leaseProof`, `LEASE_STATE_PARITY`/`LEASE_KIND_PARITY`, `DriftCase` |
| `work-race-drift-table.ts` | 229 | the 36-row hand-written `DRIFT_CASES` |
| `work-races.test.ts` | 262 | verdict-EQUALITY gate, 50 tests |
| `work-race-tampers.ts` | 125 | 13-arm tamper alphabet, `claimOnly` flag |
| `work-race-world.ts` | 182 | seeds/steps/bias, `STATE_POOL` (6), payload builders, `labelOf`, `advance`, `legalStatesFor` |
| `work-race-schedule.ts` | 151 | splitmix32, `runSchedule`, `runStratifiedSweep`, `countByKind` |
| `work-race-orderings.test.ts` | 261 | 19-kind set equality + cross-package invariants, 12 tests |

Focused: 6 files / **190 tests** green under `npx vitest run --root . --config
package.json src/work` from `apps/daemon`.

## The numbers to quote

**Drift table**: 36 rows, 33 `EQUAL` + 3 `MIRROR_STRICTER`. Observed authority
verdict set EQUALS the hand-written `{FENCED, AUTHORITY_MALFORMED_INPUT,
AUTHORITY_STALE_LEASE, AUTHORITY_STALE_EPOCH, AUTHORITY_SUPERSEDED_AUTHORITY}`.

**Orderings**: 5 seeds x 400 = 2000 walk steps + 546 stratified cases
(7 commands x 13 arms x 6 pool members) = 2546. 19 kinds, all > 1:
`WORK_LEASE_NOT_CURRENT:lease 1196`, `WORK_REQUEST_INVALID 355`,
`get_context 222`, `WORK_PAYLOAD_MALFORMED:lease 111`,
`AUTHORITY_SUPERSEDED 102`, `STALE_EPOCH 93`, `STALE_TOKEN 87`, `release 86`,
`PAYLOAD_MALFORMED:- 83`, `cancel 60`, `renew 49`, `resume 42`,
`INTENT_REFUSED 29`, `STATE_CONFLICT 13`, `claim GRANTED 7`,
`PAYLOAD_MALFORMED:slotCeiling 5`, `SLOT_EXHAUSTED 2`,
`SLOT_RESOURCE_INACTIVE 2`, `BUDGET_REFUSED 2`.
Label grammar `OK:<command>:<authority>` / `NO:<layer>:<code>:<leg>`.

## Mutation drills (all restored byte-clean, `git hash-object` before == after)

1. Swap the mirror's hash and session checks -> 1 failed / 49 passed, exactly
   the hash+session order-pinning row.
2. `successorLease` `version + 1` -> `version` -> 2 red: "expected 7 to be 8"
   and "cancel re-granted on duplicate delivery".
3. `CLAIM_LEGAL_LEASE_STATES` `["ACTIVE"]` -> `["ACTIVE","SUSPECT"]` -> the
   cross-package agreement test red with 9 drift entries.

## Decisions a successor must not relitigate

1. **The mirror is deliberately STRICTER than `fenceAuthority`** — see
   `mem:gotcha-mirror-is-stricter-than-the-authority-it-clones`. Do not "fix"
   the 3 `MIRROR_STRICTER` rows into equality; the fail-closed direction is
   correct and the reverse is asserted never to occur.
2. **The stratified sweep is load-bearing, not belt-and-braces** — see
   `mem:gotcha-uniform-random-walk-cannot-carry-set-equality`. Deleting it
   silently drops 3 of the 19 kinds and set equality goes red.
3. Message equality, not just code equality: four causes share
   `AUTHORITY_STALE_LEASE`, so only the message pins check order.
4. splitmix32, never xorshift32 (`mem:gotcha-lfsr-low-bits-hide-tamper-arms`).

## WHY IT IS BLOCKED — three foreign in-flight files, none mine

Verified by path, never by a remembered count. Fresh at 2026-08-09 ~12:25.

- `packages/runner/src/materialization/` — **wholly untracked**, another agent
  mid-TDD: `input-manifest-seal.test.ts` imports `./input-manifest-seal.js`
  which does not exist yet. Kills BOTH `pnpm --filter @moe/runner typecheck`
  (TS2307) and `pnpm --filter @moe/runner test` and root `pnpm test`.
- `apps/daemon/src/index.ts` — **modified, uncommitted**, +111 lines
  re-exporting bootstrap/goals/planning/work/event-stream/doctor. Breaks
  `apps/daemon/src/graph-preview-request.test.ts`, which asserts
  `Object.keys(daemon)` equals exactly `["evaluateGraphPreviewRequestBytes"]`.
  Untracked `apps/daemon/src/index-surface.test.ts` sits beside it, so the
  owner is mid-flight replacing that assertion. This one is durable — it has
  not self-healed over ~15 minutes.
- `packages/scheduler/src/package-boundary.test.ts` — was crashing with
  "boundary scan failed for apps\control-room\src\approvals\
  approval-detail-acceptance.tsx: unterminated regular expression source
  token" (task-8d198514's syntax-anchored detector not surviving TSX). **It
  self-healed mid-session** and now passes 39/39 standalone.

The previously-blocking `tests/fault/foundation/j4-replan-stale.test.ts` red is
GONE — retired by `9e0f123`.

**Clean legs measured before the materialization directory appeared:**
`pnpm --filter @moe/runner typecheck` 0, `pnpm --filter @moe/runner test` 0
(28 files / 927 tests), `pnpm --filter @moe/daemon typecheck` 0. Root
`pnpm test` reached 2967 passed / 1 skipped with a single foreign file red.

To finish: re-run the five-leg chain once the three files above are landed. No
change to this task's code should be needed.

## RE-VERIFICATION 2026-08-09 12:28 (worker-29cc6667) — THREE BLOCKERS ARE NOW ONE

Fresh full run of the named chain, `CHAIN_EXIT=1`, dying on leg 4:

| Leg | Result |
|---|---|
| `pnpm --filter @moe/runner typecheck` | **0** — TS2307 GONE, `materialization/` now has `input-manifest-seal.ts` on disk |
| `pnpm --filter @moe/runner test` | **0** — 29 files / 972 passed |
| `pnpm --filter @moe/daemon typecheck` | **0** |
| `pnpm --filter @moe/daemon test` | **1** — 2 failed / 363 passed |
| `pnpm test` (root, run separately) | **0** — 162 files / 3013 passed / 1 skipped |

Sole surviving blocker: `apps/daemon/src/graph-preview-request.test.ts`.
Line 241 asserts `Object.keys(daemon)` deeply equals exactly
`["evaluateGraphPreviewRequestBytes"]` and receives the full 31-value surface;
line 262 is the same fact through the real package-root specifier —
`expect(result.status).toBe(0)` gets 1. Owned by worker-064d1267's in-flight
"Publish the daemon command surface on the @moe/daemon root", whose step 1
builds the replacement 31-value `[name, typeof]` table in the still-untracked
`index-surface.test.ts`. Those two assertions are precisely what it retires.

**Do not read a green root count as this task's gate.** Root `pnpm test` exit 0
was recorded above at 3013 passed while leg 4 was red — root vitest never globs
`apps/**` (`mem:gotcha-root-vitest-skips-apps`). Only the `--filter @moe/daemon`
leg can see this failure. The earlier "root pnpm test 2967 passed" line in this
note carries the same caveat.

Recursive `pnpm typecheck` is separately exit 1 on a path OUTSIDE this chain —
`apps/control-room/src/timeline/` (untracked, architect-8a4a1764 live TDD):
TS2307 on `./timeline-list.js` x2, TS2741 missing `eventType` x2. Recorded so a
later reader does not mis-attribute it to this slice.

## Traps

- `mem:gotcha-broad-pathspec-commits-steal-untracked-work` bit again:
  `work-race-fixtures.ts` was swept into foreign commit `9e0f123` before I
  reached my own commit, which is why `6844e17` shows it as -179 lines.
- Vitest v4 hides `console.log` from PASSING tests; use `--reporter=verbose`
  to read the per-kind count table.
- PowerShell cwd drifts between calls; the Bash tool's cwd persists. `cd` into
  `apps/daemon` before invoking its vitest — running it from the repo root
  with `--root apps/daemon` fails in Vite config resolution.

Related: `mem:task-task-2580a578812f46a49cae0af79ff6fc16-handoff`,
`mem:task-task-4a3b5ec031f14079bce4141abf922905-handoff`,
`mem:task-task-ba3a45f96cda4db691233c4e45df2432-handoff`,
`mem:gotcha-self-derived-universe-cannot-check-itself`.
