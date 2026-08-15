# task-8e3076177f87458f934a776eca68ba16 — slice 1 of 4, CODE COMPLETE, blocked on a foreign gate red

Committed as **9d60091**, 6 files, 568 insertions, all under `apps/daemon/src/telemetry/`.
Steps 1-6 completed and noted. Step 7 (gate/review/commit) is done EXCEPT its exit-0 clause.

## What landed

| file | lines | what |
|---|---|---|
| `provider-run-contracts.ts` | 196 | `ProviderRunRecord` (18 readonly fields), `ProviderRunStore` port, `deriveProviderRunAggregateId`, `PROVIDER_RUN_RECORD_VERSION`, `PROVIDER_RUN_EVENT_TYPE` |
| `provider-run-refusals.ts` | 104 | `PROVIDER_RUN_LEDGER_CODES` (17), `PROVIDER_RUN_LEDGER_LAYERS` (4), `ProviderRunRefusal`, `providerRunRefusal`, `providerRunUnknown` |
| + `.test.ts` and `.js` bridge for each | | 27 tests, all green |

## Decisions a sibling slice must NOT renegotiate

- **Narrow store port.** `commitExpectedVersionDecision` / `getCommandDecision` / `readEvents` only.
  `commitWithApply` and `commitExpectedVersionDecisionWithApply` are unnameable by construction —
  they hand out a raw `DatabaseSync` and the no-new-schema rail forbids it. Do not widen it.
- **Two provenance fields, never merged.** `upstreamRefusal: ProviderTelemetryRefusal | null` (the
  runner's) vs `usageRefusals[].issues: LayeredIssue[]` (the scheduler's, which already says
  CONTRACT or MEASUREMENT). Task rail 2 depends on this shape.
- **Usage rows are `readonly NormalizedMeasurement[]`**, not `UsageMeasurementRecord[]`. The
  scheduler root publishes `NormalizedMeasurement` = `{measurement, pricebookBinding, truncated,
  identity}`, so one binding carries the normalized row AND its cost basis with no parallel array
  whose length could diverge. `UsageMeasurementRecord` + `ObservedIntervalRefs` are RE-EXPORTED from
  `provider-run-contracts.ts` so a consumer can construct a row from one import.
- **`ProviderRunUsageRefusal {providerSequence, issues}`** exists because the scheduler's failure arm
  cannot carry its own sequence. Without it, a silently dropped 4th envelope is byte-identical to a
  run that only emitted 3.
- **Clock:** `observedStart` / `observedEnd` are `ClockObservation | null` from `@moe/scheduler`
  (`{serverWallSeconds, bootId, monotonicObservation}`), NOT a hand-rolled monotonic pair — see
  `mem:gotcha-hand-rolled-timestamp-duplicates-clockobservation`. `launch.startedAt`/`completedAt`
  stay the LAUNCHER's own wall stamps and are deliberately not reconciled with them.
- **NOT shipped: `PROVIDER_RUN_RECORD_KEYS`.** An interface's keys are not enumerable at runtime, so
  this slice had no fixture to police such a list and an unpoliced frozen key list drifts silently.
  **Slice 2 (codec) should declare it beside its codec, where a fixture exists.**
- `apps/daemon/src/index.ts` is untouched; `index-surface.test.ts` pins `EXPECTED_EXPORTS.length` to
  61 and this family stays unpublished, exactly like the activation ledger family.

## CONSUMERS (Clause 1 — this slice has no runtime consumer yet)

- `task-fc6581042426444a826981943f441908` — canonical codec (bytes, digest, unreadable read path).
  Imports `PROVIDER_RUN_RECORD_UNREADABLE`, which is forward-declared here so it need not mint one.
- `task-1a7ff170ee544a3a8a10962c25e2ca5b` — durable ledger; uses `ProviderRunStore` and
  `deriveProviderRunAggregateId` so conflict detection is the store's expected-version check.
- `task-ea27beb6e1954d0e9dba8ad49cc1641e` — normalize composition against production
  `normalizeUsageMeasurement`.
- `task-6cbff01023b14b26a78fc5e3eb1dd8a9` — the real live dispatch consumer (task rail 4).

## DoD RE-SCOPE STILL OUTSTANDING

The architect disclosed this in planningNotes and it was never actioned. Only DoD 2 and DoD 6 belong
to this task. DoD 1 and 3 -> slice 3 (ea27beb6). DoD 4 and the real-store half of DoD 5 -> slice 4
(1a7ff170). Grading this task against DoD 4's "durably commit" clause grades it against work that
now has its own task id.

## WHY BLOCKED

`pnpm --filter @moe/daemon typecheck` and `... test` are red from CONCURRENT PEER EDITS inside the
owned package. Measured ~9 times over ~10 minutes; the red MOVED each time
(`configuration/project-configuration-selection.test.ts` -> `mcp-dispatch-port` -> `mcp-http-host` /
`mcp-http-main` -> `index-surface.test.ts`), and all four legs were briefly green at 21:22 before
going red again. Final measurement: only `src/index-surface.test.ts` (peer-modified, ` M`, adding
project-configuration imports before the exports exist). Owned-path intersection is EMPTY — no
failure under `apps/daemon/src/telemetry/**` in any measurement. runner and scheduler legs exit 0
throughout.

Per `mem:owned-package-gate-red-is-a-block-not-a-disclosure` a foreign red inside your OWN package's
gate is a block, not a disclosure: `complete_task` hard-requires exit 0, and both escapes (faking it,
narrowing the command) violate standing rails.

**To finish:** re-run the four-leg chain once the daemon package settles. Nothing in this task needs
re-doing — verify by `git show --stat 9d60091` and `pnpm exec vitest run --root . --config
package.json src/telemetry` from `apps/daemon` (27 tests).
