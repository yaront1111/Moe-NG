# task-5855a9c6 — Recovery continuation evidence binding (DONE 2026-08-09)

Closed the J3 hole where a continuation REQUEST could assert its own
`predecessorRelease`/`safeHandoff` and manufacture the boundary it was asking to cross.

## The shape of the fix

Producer/consumer migration, landed together across `@moe/runner` and `apps/daemon`:

1. `classifyCrash` derives `continuationEvidence {predecessorRelease, safeHandoff}` from the
   ALREADY-PARSED `RestartRecords` (`crash-classification.ts:161`) and carries it on all five
   arms. REQUIRED, not optional — see below.
2. `ReconciliationRecord` persists both (`restart-reconciliation.ts`), schema bumped to
   `moe-restart-reconciliation/2`.
3. `ContinuationRequest` / `REQUEST_KEYS` no longer DECLARE those fields; schema
   `moe-recovery-continuation-request/2`. Exact-key parsing means a request still carrying
   them is REJECTED on key count, not silently ignored.
4. `evaluateContinuationCommandBytes` passes `record.classification/predecessorRelease/safeHandoff`
   to both runner admissions.

## Things a future agent will otherwise rediscover the hard way

- **The release lattice is now UNREACHABLE through continuation.** `heldResources` pushes
  `resource:<fact>` for any non-`PROVEN_RELEASED`, and quarantine is decided before absence, so
  an ABSENT record ALWAYS stores `PROVEN_RELEASED`. `RECOVERY_PREDECESSOR_ACTIVE` /
  `RECOVERY_PREDECESSOR_RELEASE_UNKNOWN` cannot be produced via the daemon path. There is a
  tripwire test ("stores PROVEN_RELEASED on every ABSENT record") that goes red if anything
  decouples them. Do NOT write a daemon test asserting a lattice refusal — it can only pass by
  staging a state the classifier cannot produce.
- **`continuation-test-harness.ts` is NOT owned by this task** and still mints the
  pre-migration authority-bearing envelope. Both owned suites build request bytes locally; the
  harness `run()` is imported once as `legacyAuthorityRequest` and asserted REJECTED. If you
  own that harness later, either fix `request()` or keep it deliberately as the hostile fixture.
- **A binding conflict does NOT leave the store byte-identical.** A rival predecessor claiming
  the same successor is a genuinely new command, so the store records
  `NO_BUSINESS_EFFECT` + `EXPECTED_VERSION_CONFLICT`. That ledger row is what makes retrying
  THAT command idempotent. Asserting whole-store byte identity there is wrong; assert instead
  that no binding was created/overwritten. (Byte identity IS correct for classification and
  boundary refusals, which return before any commit is attempted.)
- **`isRecoveryOutcomeKind` is not on the runner's public root.** `packages/runner/src/surface`
  does not re-export it, and task rails forbid deep imports, so the daemon defines a local
  `isRunnerClassification` guard checked against the root-exported `RECOVERY_OUTCOME_KINDS`.
  Don't "dedupe" it by deep-importing.
- The stored vocabulary is one WIDER than the runner's: `RESTART_RECORD_CLASSIFICATIONS`
  includes `REFUSED`. `ContinuationBinding.classification` is narrowed to `RecoveryOutcomeKind`.
- `REFUSED` records store `UNKNOWN`/`null` — no classification means no evidence.

## Governance history worth knowing

- `continuationEvidence` being REQUIRED broke one fixture literal in the unowned
  `packages/runner/src/platform/platform-observation.test.ts:127`. I blocked rather than make
  the field optional (which would have kept the gate green while permitting a classification
  with no continuation evidence — this task's own hole one layer down). governor-f70d1157
  amended scope by ONE line instead. Precedent: refuse the green-gate trade, report blocked.

## Verification

Owned-scope gate, exit 0:
`pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test && pnpm --filter @moe/daemon typecheck && pnpm --filter @moe/daemon exec vitest run --root . --config package.json src/recovery`
Runner 1260 tests, daemon recovery 186 tests.

Foreign red at completion, both committed and outside owned paths: the daemon
`runtime-entrypoint.test.ts` bridge test (3 test-tier `.js` bridges committed by `462a610`),
and `packages/core` identity typecheck. See `mem:gotcha-shared-worktree-foreign-red`.

QA reviews by base-ref diff, not by commit sha — commit `462a610` (task-1cafc7f9) swept all 11
of my files into a foreign whole-tree commit:
`git diff 749eb46..HEAD -- <the 11 owned paths>` = 976 insertions, 108 deletions.
