# task-b937811e8b72459ea169e5fff1238ce1 — Benchmark telemetry harness

## Outcome (2026-08-16, HEAD ac09ca9) — Clause-2 architect output delivered, RE-BLOCKED

The governor asked for the ARCHITECT output rather than a third worker conclusion:
measure the emission gap symbol by symbol, file prerequisite production tasks, re-block
on their ids. Done. No plan submitted — a plan here would have been a fixture-fed
harness, which Clause 2 forbids.

## The gap is NARROWER than the old five-owner audit

Producers **and** sink are both landed. Only the wire between them is missing.

**Landed producers, all published, all ZERO non-test apps/ callers:**
| symbol | defined | published |
|---|---|---|
| `launchClaudeWithTelemetry` | claude-telemetry-launch.ts:206 | claude-surface.ts:185 |
| `parseClaudeResultTelemetry` | claude-result-telemetry.ts:214 | claude-surface.ts:175 |
| `buildProviderRunRecord` | provider-run-record.ts:210 | provider-record-surface.ts:24 |
| `normalizeUsageMeasurement` | scheduler/budget/budget-measurement.ts:210 | scheduler/index.ts:115 |

**Landed sink (NEW — shipped today by task-1a7ff170):** `commitProviderRunRecord` at
`apps/daemon/src/telemetry/provider-run-ledger.ts:202`, `deriveProviderRunEventId` :89.

**The hole, three greps:**
- `grep -rn "launchClaude" --include=*.ts apps` → **ZERO hits**
- `grep -rn "commitProviderRunRecord" --include=*.ts apps | grep -v '\.test\.'` → only
  its own definition. The durable sink has no writer.
- apps/daemon's single `ClaudeTelemetryHandoff` mention is a **COMMENT** at
  provider-run-contracts.ts:84. The old audit counted it as "one hit"; it is not a consumer.

## Where emission belongs — NOT the agent spawner

`apps/daemon/src/orchestrator/*` spawns moe's own agent wrappers via `node:child_process`
(agent-spawn-contract.ts:9) — different concern. The provider-run seam is the
**ACTIVATION** path: activation-ingress.ts:1 already imports
`activateEffect`/`applyEffectCommand`/`EffectIntent` from @moe/runner. The ledger's own
identity confirms it — `deriveProviderRunAggregateId` keys on provider, runRef,
**effectIntentId, attemptRef**, epoch, which are activation vocabulary.

## Tasks filed

1. **task-6c0db1f9920841fea295512f602054ee** — Emit provider-run telemetry from the
   daemon activation path (PLANNING). First apps/ call sites for
   `launchClaudeWithTelemetry` + `parseClaudeResultTelemetry`.
2. **task-d3239529aab54f98b31bfd3662e316bf** — Compose and durably commit the
   provider-run record (BACKLOG, depends on 1). First call sites for
   `buildProviderRunRecord` + `commitProviderRunRecord`.

**Two, not five.** `normalizeUsageMeasurement` needs no task: it is reached transitively
once task 2 lands, via `buildProviderRunRecord` → `normalizeProviderUsage`
(provider-run-record.ts:238 → provider-usage-normalization.ts:208).

## Unblock condition (run literally)

Both ids DONE **and** all three return non-zero:
```
grep -rn "launchClaudeWithTelemetry" --include=*.ts apps | grep -v '\.test\.'
grep -rn "buildProviderRunRecord"    --include=*.ts apps | grep -v '\.test\.'
grep -rn "commitProviderRunRecord"   --include=*.ts apps | grep -v '\.test\.' | grep -v "provider-run-ledger.ts:"
```
Never unblock on task status alone, on exports, or on test-only callers.

## Two warnings for the next architect

1. **The old audit's control-room item is STALE.** `grep -rln 'effort|Effort'
   apps/control-room/src/live/` no longer returns 0 —
   `live/live-effort-edge.ts`, `performance/effort-admission.ts` and
   `performance/effort-attribution.ts` all exist. Re-measure before re-filing anything
   there; that is the "gap claimed present, actually closed" half of the rail.
2. **The vacuous gate persists.** `packages/benchmark` is still ABSENT, so
   `pnpm --filter @moe/benchmark test` prints "No projects matched the filters" and
   EXITS 0. Any DoD written for this harness must require a NONZERO executed-test count
   from vitest's own summary. See `mem:pnpm-filter-nonexistent-package-exits-0`.

## Still open for whoever plans the harness after unblock

Inherited from architect-7f301fa7, unresolved: freeze the exact stable UNKNOWN
reason-code/layer vocabulary for the benchmark codec without adding campaign scoring;
and declare **pnpm-lock.yaml plus the new package.json as owned paths in step 1**, since
creating packages/benchmark needs a workspace install and the dependency-edge rail
cannot otherwise be satisfied.

Note: `moe-epic-breakdown` skill is NOT available in this session (Unknown skill) — task
sizing applied from the project rails directly.
