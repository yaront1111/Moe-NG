# task-22cfca91 "Portability shadow gate" — handoff

## QA VERDICT 2026-08-20 (qa-d20cc5f3): APPROVED -> DONE

Everything below the worker recorded was RE-MEASURED, not trusted. Nothing was
found that the worker had not already disclosed.

Re-run at HEAD 60a043a, PowerShell:
- `pnpm test:integration` EXIT=0 — `Test Files 12 passed (12)` / `Tests 360
  passed (360)`; node:test `tests 71 / pass 71 / fail 0` (71 not 69: peers
  landed cases after the worker's run).
- `pnpm test:migration` EXIT=0 — `Test Files 3 passed (3)` / `Tests 26 passed (26)`.
- `npx vitest run tests/integration/portability` -> 4 files / 100 tests.
- `npx tsc -p tests/integration/portability/tsconfig.json --noEmit` EXIT=0.

External evidence re-derived independently:
- `node tests/fault/cross-host/exact-sha-evidence-gate.mjs 06c4e9ed...` EXIT=0.
- Downloaded `cross-host-aggregate-06c4e9ed...` myself. Body matches the
  receipt field-for-field: `aggregateDigest 33251d80…`, `source.commitSha` ==
  the pin, `consumerTaskId` == this task, rows linux+darwin PROVEN,
  `distribution.aggregateDigest 2f3b8091…` over 6 components.

Drills re-run:
- Pin hex flip (…e1e1 -> …e1e2): STILL GREEN, 4 files / 100 tests, EXIT=0.
  This reproduces the worker's own honest record (step-6 drill 3b): equivalent
  mutant by construction, since every row/hash derives from the one resolver.
  It was NOT claimed as a red. See `mem:qa-honest-equivalent-mutant-is-not-a-reject`.
- The guard that actually binds: `MOE_PORTABILITY_SOURCE_COMMIT=<HEAD sha>` ->
  `Test Files 4 failed (4)`, EXIT=1, four `PORTABILITY_SOURCE_COMMIT_SEALED_CONFLICT`
  errors. Positive control at the pinned sha -> 4 / 100, EXIT=0.

Graded and explicitly NOT rejected:
- 3 owned test files over 400 lines (projection 686, transport 515, harness
  509). All predate this task (measured at `af20a02^`); the cap is per
  PRODUCTION file. This task's own new files are 178 and 197.
- No Windows leg in the `portability-evidence` matrix although `gate-windows`
  exists and was already committed at `af20a02^`. The worker measured this in
  step 3 and reasoned it: `gate-windows` is a SEPARATE pwsh job, not a matrix
  arm, so the portability legs mirror `gate`'s 2-OS matrix; Windows is the local
  primary host and its portability rows do execute inside `gate-windows`'
  `pnpm test`. Disclosed judgment call, not a silent drop.

## What sealing means (the whole point of the task)
Receipt SEALED at **06c4e9ed420eb7302c820274c06945f09eabe1e1**:
`externalRun {runId: 32376607547, event: "push"}`,
`aggregateDigest sha256:33251d806206ba58ffe6699a317db2625e07300f393554acab1c67f331cd2e90`.
That is the DERIVED digest inside the aggregate body; the archive digest GitHub
stamps on the upload is `78b8a805…` and lives in the receipt's `$comment`.

Deliverable commits: af20a02 (workflow + resolver), b437f1d (typecheck repair),
e3cd7f2 (store-side positive control), 6a8400e (seal).

## The pin moved, and why it had to
Originally pinned e3cd7f2. No run has ever existed there —
`mem:gotcha-push-run-exists-only-at-the-push-tip`. Re-pinned forward to 06c4e9e,
an ancestor-superset still carrying af20a02.

## Blast radius of the seal
`MOE_PORTABILITY_SOURCE_COMMIT` is set in exactly ONE place in cross-host.yml
(the `portability-evidence` job's own `env:`). Next push at a newer sha reds
ONLY that job with `PORTABILITY_SOURCE_COMMIT_SEALED_CONFLICT`; `gate` runs with
the variable UNSET and stays green. That red is the designed staleness alarm.
Reversal is one line: `externalRun: null`.

## STILL OPEN for a follow-up
macOS per-matrix ATTRIBUTION is UNKNOWN at this commit. The macOS portability
rows PASSED (`Test Files 12 passed (12)` / `Tests 360 passed (360)`); the job
died earlier on the foreign release-supply-chain node:test macOS red, so
`portability-matrix.json` was never produced. Mechanism:
`mem:gotcha-bundled-foreign-suite-erases-later-evidence-steps`. Fix = run the
matrix-evidence step first or with `if: always()`. Only provable on a LATER push
run; epic rail 3 forbade this worker pushing. Governor asked in chan-ced99359
msg-40348ed8.

## Traps for whoever touches this next
- **Do not follow step 7's pathspec literally.** It names
  `.github/workflows/cross-host.yml`, still dirty with 87 insertions of PEER WIP
  (gate-windows extension, zero portability lines — re-confirmed by QA:
  `git diff -- <wf> | grep -c portability` = 0). The task's own workflow bytes
  landed at af20a02.
- Artifacts expire ~90d; after that the gate refuses run 32376607547 for
  `expired` and the digests spelled out in the receipt's `$comment` are the only
  durable evidence.
