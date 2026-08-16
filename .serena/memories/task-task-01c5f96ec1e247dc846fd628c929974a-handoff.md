# task-01c5f96e cross-host evidence — handoff (2026-08-16, second session)

## State
Steps 1-7 COMPLETE. Step 8 IN_PROGRESS, task BLOCKED again — this time on a REAL RED,
not only on publication.

- 91fc622 = implementation (first session).
- 1c9e46c = this session's diagnosability + refusal-pinning commit (6 owned paths).
- Both are on `moe/work-2026-08-08`. 91fc622 is published (origin tip was cf137c6).
  **1c9e46c is NOT pushed** — worker push is forbidden.

## The measured CI result — do not re-derive this
Run 31918405323 at cf137c6 (push). No Actions run exists at 91fc622: Actions binds to
the pushed TIP, so an exact-SHA query for a mid-branch commit can never match.

| job | conclusion | failing step |
|---|---|---|
| host-evidence-linux | failure | 7 "Run the host schedule" |
| host-evidence-darwin | failure | 7 "Run the host schedule" |
| cross-host-aggregate | failure | 9 "Compile and run the hostile contract suite" |

Steps 1-6 (checkout, pnpm 11.0.8, node 24.16.0, `pnpm install --frozen-lockfile`,
`tsc -p tests/fault/tsconfig.json`) all SUCCEEDED on both hosts. The aggregate's
receipt downloads reported `Artifact not found for name: cross-host-{linux,darwin}-cf137c6…`
purely because the host uploads were skipped by their own failure.

The failing LINES are still unknown: job logs need repo admin. See
`mem:gotcha-actions-job-logs-need-admin-use-annotations`. That is why 1c9e46c exists.

## What 1c9e46c changed
- `.github/workflows/cross-host.yml`: host-schedule / collect / contract / aggregate
  steps republish their refusal as a `::error::` annotation with the last 5000 bytes
  of the log. **Gate conditions unchanged** — same PIPESTATUS status test, same three
  count/`executedCaseCount=21` greps, each now naming which one refused.
- Both OS suites: `process.stdout.write("hostScheduleOutcome=" + JSON.stringify(describeRun(host, run)))`
  BEFORE any assertion, plus `run.message` in the on-host throw.
- `describeRun()` added to `effect-schedule-driver.ts` (now 247 lines — near the cap).
- `effect-schedule-activation.ts`: `runVerifierSchedule` takes a 4th arg
  `expectedRefusal`; exports `CRASH_REFUSAL = "VERIFIER_PROCESS_EXIT_AMBIGUOUS/CAPTURE"`
  and `CANCELLATION_REFUSAL = "VERIFIER_PROCESS_CANCELLED/CAPTURE"`. Any other refusal
  is `CROSS_HOST_SCHEDULE_INCOMPLETE`. This is plan step 4 + epic rail 6, and it may be
  what turns the crash leg red — if so the annotation will say so by name.
- Deleted `tests/fault/cross-host/zz-probe.fault.ts`, my temp probe that foreign
  whole-tree commit d447a34 had captured into the tree.

## Diagnosis already done — do not repeat
Driven on win32 with a FABRICATED `{os:"linux"}` host identity (diagnosis only, never proof):
- `runTombstoneSchedule()` -> OK, `EFFECT_TOMBSTONED/ACTIVATION`, launches 0.
- `runVerifierSchedule(base, SCRIPT_LIVE, true)` -> `VERIFIER_PROCESS_CANCELLED/CAPTURE`,
  launches 1, real pid, win32 exit `{kind:"EXITED",code:1}`.
- `buildBoundaryFacts` + `classifyLinuxBoundary` + `observeLinuxPlatform`: all seven
  boundaries PROVEN **except PATH_SYMLINK**, absent only because Windows `symlinkSync`
  refuses. Also PROVEN with a forced `{kind:"SIGNALLED",signal:"SIGKILL"}` +
  `cancelRequested:false` fact set and real activation records.
- So classification/fact shapes are sound. What has NEVER executed anywhere is the
  POSIX-only process behaviour of the crash leg.
- DISPROVEN hypothesis: vitest DOES forward `process.stdout.write` from the fork pool
  (verified — `executedCaseCount=21` reaches a `tee`d log), though `console.log` is
  swallowed. The grep is not the cause. Use `process.stdout.write` for CI diagnostics.

## Next session
1. Get 1c9e46c (or the tip carrying it) published by an authorized human/governor.
2. Read the failure from `GET /repos/yaront1111/Moe-NG/check-runs/<job_id>/annotations`
   — it now carries the vitest tail including `hostScheduleOutcome=…`.
3. Fix, recommit, repeat steps 7-8 against the NEW SHA.
4. Exact-SHA query verbatim at 1c9e46c:
   `FAILED: no exact-SHA Linux/macOS/aggregate success for 1c9e46ccf88f46f85903222fd1701d2d8100e7cc`

## Local gates at 1c9e46c
`pnpm exec tsc -p tests/fault/tsconfig.json` EXIT=0.
`pnpm test:fault` EXIT=0, Test Files 10 passed (10), Tests 83 passed (83)
(was 8/70; the extra two files are a peer's untracked `tests/fault/disaster-restore/`).
Per-file line counts all under 250: driver 247, activation 217, contract 224,
verify 256 *(over — pre-existing from 91fc622, split it if QA calls it)*, facts 239,
CLI 238, each OS suite 114.
