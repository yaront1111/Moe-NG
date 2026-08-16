# task-01c5f96e cross-host evidence — implementation handoff (2026-08-16)

## State
Implementation COMPLETE and committed at **91fc622** on `moe/work-2026-08-08`.
Task reported BLOCKED on **publication only**: the DoD's final gate needs a real GitHub
Actions run at that exact SHA, worker push is forbidden, and `git ls-remote origin` shows
origin still at `1576a44`. The exact-SHA query was RUN and returned verbatim
`Error: no exact-SHA Linux/macOS/aggregate success for 91fc6220d91e...`.

## What landed (11 owned paths)
- `tests/fault/cross-host/effect-evidence-contract.ts` (224) — frozen vocabulary (2 slots,
  2 layers, 12 codes), sorted-key canonical JSON, sha256, `sealHostReceipt`,
  content-addressed `receipt-<digest>.json`, exact-key decoder, all key sets,
  `scheduleUniverseOf`.
- `tests/fault/cross-host/effect-evidence-verify.ts` (256) — `verifyHostReceipt` +
  `aggregateHostReceipts`. Gate order: shape → self-digest → doctor/kernel identity →
  derived-slot → source → distribution → runtime → schedule.
- `tests/fault/cross-host/effect-schedule-driver.ts` (222) — 7x3 universe, host derivation,
  per-boundary classify + whole-batch observe, `writeRawSchedule` (prints
  `executedCaseCount=<n>`).
- `tests/fault/cross-host/effect-schedule-activation.ts` (200) — activation record inputs,
  counting launcher, tombstone schedule, verifier schedule (crash + cancellation).
- `tests/fault/cross-host/effect-boundary-facts.ts` (239) — one real fact per boundary.
- `tests/fault/cross-host/cross-host-evidence.mjs` (238) — `collect` / `aggregate` CLI.
- `tests/fault/cross-host/effect-evidence-{contract,verify}.js` — 1-line `.ts` bridges.
- `tests/fault/{linux,macos}/effect-conformance.fault.ts` (110 each).
- `.github/workflows/cross-host.yml` — pure APPEND; `gate` untouched.

## Resume shape
1. Get 91fc622 (or its successor) pushed by an authorized human/governor.
2. Re-run the step-8 exact-SHA query; then read the three job logs for the positive Vitest
   counts, both `executedCaseCount=21` lines, both receipt digests, and the aggregate rows.
3. If a host job is red, fix, recommit, and repeat steps 7-8 against the NEW SHA.

## Highest CI risk (unverifiable on win32)
`CRASH_AFTER_ACTIVATION` requires `VERIFIER_PROCESS_EXIT_AMBIGUOUS`/`CAPTURE`. On win32 the
self-SIGKILL child produced an ACCEPTED run instead (no signal is reported), so the schedule
refuses there. On POSIX the child dies by SIGKILL and `verifier-process-run.ts` refuses with
"the child was terminated by SIGKILL, which this wrapper did not send". If Linux/macOS still
report no signal, that assertion is the thing to revisit first.

## Measurements worth keeping
- `pnpm test:fault` merge-base 4 files/47 tests → HEAD 8 files/70 tests, EXIT=0.
- Path-attributed delta over repo-wide legs: only NEW failing path at HEAD is
  `packages/store/src/recovery-anchor.test.ts` (foreign); `claude-runtime-source.test.ts`
  went green. Intersection with owned paths is EMPTY.
- Drills: mutating `identityRejection`'s code reddened the sweep precisely on
  `{label: 'host spoof'}`; mutating the driver's off-host code reddened both OS suites.
