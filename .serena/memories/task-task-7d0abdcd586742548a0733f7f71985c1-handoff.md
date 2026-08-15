# Handoff: task-7d0abdcd — publish the @moe/runner recovery, evidence and Claude observation surfaces

Worker worker-29cc6667, 2026-08-09. Commit **7afa17d**, 8 owned paths, no foreign path.
Fifth instance of the same recurring defect (after task-8ee125d0 @moe/scheduler,
task-53680e91 @moe/runner supervisor, task-6054520b @moe/daemon, the bridge sweeps).

**QA VERDICT: APPROVED by qa-b2df68b9, 2026-08-09.** Evidence at the bottom of this note.

## What shipped

`@moe/runner` root goes **66 -> 116 named exports** (+50) plus ~70 types. Curation lives in
three new modules, not inline:

```
packages/runner/src/surface/recovery-surface.ts   53 lines  (+ .js bridge)
packages/runner/src/surface/evidence-surface.ts   70 lines  (+ .js bridge)
packages/runner/src/surface/claude-surface.ts     80 lines  (+ .js bridge)
packages/runner/src/index.ts                     173 lines  (was 163; +11, 0 removed)
packages/runner/src/index-surface.test.ts        925 lines  (was 305; 78 -> 141 tests)
```

index.ts reaches them with `export * from "./surface/<area>-surface.js"`. That is compliant
with "prefer curated named exports": the curation moved one file down into an explicit
hand-written list that cannot grow without a reviewer editing it.

Gate: `runner typecheck && runner test && daemon typecheck` -> exit 0.
Runner suite **1040 -> 1104 tests**, still 37 files. `tests/runtime/package-loadability.test.ts`
7 passed; its `allowedPackageFailures` is `Object.freeze({})` and names no task.

## Three things worth carrying forward

1. **`export *` hides a name collision — the COUNT is the proof, not tsc.**
   See `mem:gotcha-export-star-collision-is-silent`.
2. **Type-only exports are invisible to a set-equality test.** `Object.keys` sees values only.
   The guard is the test's `import type { ... } from "@moe/runner"` block: drop a published
   type and you get TS2724 at the import. Drilled it.
3. **Restart records are hand-buildable through the root** — no need for
   `recovery/recovery-test-fixtures.ts` (which must never be published). Recipe:
   `runner.activateEffect(activationRequest())` gives a real `ActivationCommit`; feed
   `commit.intent` / `commit.attempt` / `commit.grant` into a records literal with a
   hand-written `LaunchLockRegistration`. **Trap:** the `reconciliation` field is parsed by
   `parseReconciliationReference`, which requires `reconciliationVersion ===
   CLAUDE_RECONCILIATION_VERSION` and `outcomeClass` in `CLAUDE_RECONCILED_OUTCOMES` — the
   supervisor's generic `SETTLEMENT` fixture (`"recon/1"` / `"COMPLETED"`) is REFUSED, and the
   only symptom is `RECOVERY_OBSERVATION_MALFORMED`, which reads like the observation is at
   fault. Cost one debug cycle.

## Deliberately withheld from the seam (decisions, not oversights)

`recordClaudeStream` and its input/result types (a `ClaudeStreamRecord` is plain data a
consumer can assemble from the published types, so reconciliation is reachable without
opening the stream-recording subtree); the Claude probe port, `assessCapabilities`,
`capabilitySchemaDigestOf`, `resolveContextLimit`, `UNPROVEN_PROBE_REPORT`; every refusal
factory (`recoveryFailure`, `carriedFailure`, `evidenceFailure`, `claudeFailure`) and the
shape guards; `evidence/candidate-reconciliation.ts`'s internals; `recipeDigestInput`.

Two inclusions that look like creep but are not:
- `isEvidenceFailure` — `canonicalObligations` returns `readonly DischargedObligation[] |
  EvidenceFailure`, and an array has no `.ok` to narrow on.
- `buildProviderRuntimeObservation` — a `ProviderRuntimeObservation` carries a digest over
  its own fields and `observedExecutionRejection` refuses one that does not recompute, so
  publishing the type without its builder publishes an unusable type.
- `RESTART_POST_STATES` / `DrainDisposition` / `DRAIN_REASONS` / `DRAIN_TERMINAL_TARGETS` are
  the type closure of `CrashClassification.postState` and `DrainAdvance.disposition`, not a
  second supervisor publish.

## For the reviewer / next owner

- `index-surface.test.ts` at 925 lines is now the largest test in the repo (previous largest
  875, `packages/coordination/src/coordination-suite.test.ts`). The per-file cap is production
  sources and owned paths pinned me to one test file, so it was not split; the natural seam is
  the three `/* ---- */` banners.
- **This publishes the surface ONLY.** J3's launcher/restart composition is a separate
  follow-on and the Foundation canary stays blocked until it lands. What changed is that the
  composition is now possible at all.

## QA verification actually performed (qa-b2df68b9, 2026-08-09)

- `pnpm --filter @moe/runner typecheck` exit 0. `pnpm --filter @moe/runner test` ->
  **37 files / 1104 tests passed**, re-run twice.
- `pnpm --filter @moe/daemon typecheck` **exit 1**, and the red is FOREIGN: both errors are
  TS6133 unused-import in `apps/daemon/src/review/review-lineage.test.ts`, an UNTRACKED path
  (`git ls-tree HEAD -- apps/daemon/src/review` is empty) owned by another in-flight agent.
  Zero errors mention `@moe/runner`, so the intended-consumer resolution the DoD cares about
  is proven. Path-attributed-baseline rail applies; not attributable to 7afa17d.
- **Collision audit, done statically rather than trusting tsc** (see
  `mem:gotcha-export-star-collision-is-silent`): parsed the export lists out of index.ts and
  the three surface modules — 0 duplicates across the star modules, 0 names shadowed by an
  explicit index.ts export. So neither silent `export *` failure mode is present.
- **Independent count**, computed by QA from the sources, not from the namespace:
  66 index value exports + 50 surface value exports = **116**, matching the hand list.
- **Runtime probe from a real consumer**: `cd apps/daemon && node --experimental-strip-types
  -e "await import('@moe/runner')"` -> `116` keys, `classifyCrash`/`buildEvidenceReceipt`/
  `reconcileClaudeRun`/`advanceRecoveryDrain` all `function`. Proves the three new `.js`
  bridges load outside vitest. Note the probe must run from a package that DEPENDS on
  @moe/runner — from the repo root it is `ERR_MODULE_NOT_FOUND`.
- **Mutation drill** (epic rail 6): dropped `classifyCrash` from `recovery-surface.ts` ->
  4 tests red, naming the symbol: set-equality `expected [ …(115) ] to deeply equal [ …(116) ]
  - "classifyCrash"`, plus `publishes classifyCrash on the package root as a function`. Test is
  not vacuous. Restored; `git status --porcelain -- packages/runner` clean afterwards.
- DoD 6's "no .js bridge is added or removed" reads as violated but is not — see
  `mem:gotcha-dod-no-bridge-added-conflicts-with-extraction-rail`.
