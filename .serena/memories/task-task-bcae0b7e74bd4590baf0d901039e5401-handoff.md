# task-bcae0b7e74bd4590baf0d901039e5401 — QA verdict: APPROVED

Decision-effort and attention observation records. QA `qa-50f0d628`, 2026-08-15.
Approved on first review (reopenCount 0). Superseded the worker handoff that
previously lived at this name; the worker's content is summarised below.

## What I re-ran (not trusted from the summary)

- `pnpm --filter @moe/control-room test` -> 67 files / 814 tests, exit 0.
- `pnpm typecheck` -> `Scope: 18 of 19 workspace projects`, every package Done
  incl. apps/control-room and apps/daemon, exit 0.
- Both legs redirected to a file with `$?` captured immediately — never piped
  (`mem:piped-gate-run-reports-tail-exit-code`).
- Re-ran the test leg AFTER restoring my drills: 814/814, exit 0.

## Deliverable, at HEAD

`apps/control-room/src/performance/` — four production modules, `grep -c ''`:
effort-records.ts 228, effort-admission.ts 192, effort-intervals.ts 180,
effort-collector.ts 129. All <=250. Six test files, 79 effort tests.
Bytes landed in commit `871c9b4`.

## My own mutation drills (worker's drills NOT taken on trust)

Pre-drill `cp` to /tmp, restore from that copy, sha256 back to the pre-drill
value each time — NOT `git checkout`
(`mem:git-checkout-restore-destroys-uncommitted-work`).

1. **Attribution guard** (the one DoD 5 names). Weakened `deriveDecision` so an
   UNATTRIBUTED demand takes `[...demandedOf].at(-1)`. Result: **exactly 1**
   failure, the named test `leaves an unattributed demand unattributed, never on
   the most recent command`, reddening on the exact assertion
   `expected 'cmd-a' to be 'UNATTRIBUTED'`. One failure, not over-reddening
   (`mem:qa-mutation-drill-can-redden-for-wrong-reason`).
2. **Unterminated interval closed at seal.** Replaced the `unresolve(...
   UNTERMINATED)` line in `sealOpen` with a CLOSED outcome at `openedAt`.
   Result: 6 failures across 3 files, every message on a state or code
   (`expected 'CLOSED' to be 'UNTERMINATED'`), none on a duration — there IS no
   duration field, which is what makes the drill unambiguous.

sha256 after restore: collector `2ffe0199…`, intervals `3f28dcc7…`.
`git status --porcelain -uall -- apps/control-room` empty afterwards.

## Why each DoD passed

1. Seven record types, every one `Object.freeze`d at its build site, each
   carrying `source` + `commandId` + `observedAt`. `isFrozen` asserted at 8
   sites incl. the arrays handed back and the sealed set.
2. `ADDITIONAL` is deliberately **absent** from `BASELINE_DECISION_KINDS`, so a
   caller literally cannot state it — admission answers
   `EFFORT_OBSERVATION_CONTRADICTORY`. Additional-ness is derived per
   `commandId` from the observed sequence and never across UNATTRIBUTED.
3. Focus and away are separate map slots; neither closes nor derives the other.
   No duration field exists anywhere in the domain, which structurally kills the
   auto-close temptation. unterminated -> `EFFORT_INTERVAL_UNTERMINATED`,
   overlap -> `EFFORT_INTERVAL_OVERLAPPING`, close-before-open and
   close-without-open -> `EFFORT_OBSERVATION_CONTRADICTORY`, each with layer.
4. Own `EFFORT_*` family, seven codes, mirroring the timing.ts SHAPE
   (`{code, layer}`, frozen, absent-checked-before-unparseable, no translation
   table) under two named layers. See the judgement call below.
5. Sweeps assert hand-written literals **4 / 5 / 7 / 7 / 4 / 4 / 2** BEFORE
   iterating, then compare the visited members BY NAME against the frozen
   vocabulary (`mem:qa-generated-table-cannot-police-its-own-generator`). Both
   refusing layers visited by name. Plus my drill 1.
6. Verified above.

## The judgement call I accepted

Task rail 4 says "follow the existing timing.ts UNKNOWN vocabulary rather than
inventing a parallel one". The architect read that as the SHAPE, not the
identifiers, and flagged the reading for QA in `approachesConsidered`. I agree:
an unterminated focus interval is not a timing fact, and reusing
`TIMING_SOURCE_ABSENT` for it would make two different facts indistinguishable
at every consumer — the exact defect epic rail 6 exists to prevent. Also
`timing.ts` / `wire-timing.ts` are sibling-owned and committed; extending their
code family would put this task inside a file another task answers for. Both
files verified untouched.

## Non-defects I checked and cleared

- **`e6597e4` bears this task id but carries foreign bytes** (packages/runner
  telemetry, apps/daemon readiness-projection). Known whole-tree completion-hook
  hazard, named in global rail 5 as never a rejection reason. This task's bytes
  are in `871c9b4`; working tree == HEAD for the owned paths, so committed
  bytes == gated bytes.
- **`timing.test.ts` +4 lines** is a forced positive fix: `PRODUCTION_MODULES`
  is compared for EXACT equality against the directory listing, so four new
  modules force four one-line entries. Same shape as
  `mem:closed-verdict-map-forbids-a-new-test-file`.
- **No live call site.** Composition-rail clause 1 option (a): consumer NAMED as
  parent `task-1eeb2dccce204671b442704cd60b38ad`.
- No clock, no `Date`, no `Math.random`, no threshold/score/verdict in any of
  the four production files — grep-confirmed; the only hits are prose comments
  saying the module does none of those.

## Next

All three SPIDR slices of parent `task-1eeb2dcc` are now landed
(task-1430dfae, task-371c80bd, this one). The parent owns integration and is
the next thing unblockable.
