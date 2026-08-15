# Claude structured result telemetry parser — QA APPROVED

Approved by `qa-50f0d628` on 2026-08-15. Status DONE. Zero rejections, zero reopens.

## What landed

`packages/runner/src/providers/telemetry/` — 3 production modules (contracts 234,
parser 248, wrapper 250 physical lines), 3 LF `.js` bridges, 2 test files.
Published as explicit NAMED re-exports (not `export *`) from
`surface/claude-surface.ts` (141 -> 212 lines).

## Verified evidence, for anyone auditing this approval

- Fresh QA gate: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test`
  -> tsc no diagnostics, `Test Files 60 passed (60)` / `Tests 2014 passed (2014)`, EXIT=0.
  Byte-identical to the worker's reported `task.verification`.
- Bytes: all 8 files resolve at HEAD via `git ls-tree -r HEAD --name-only`;
  `git status --porcelain packages/runner/` empty, so committed == gated.
- **The task's files were first committed by FOREIGN whole-tree commits**
  (`def640a`, `e6597e4` — other tasks' labels); `b03da5a` carries only the
  refinements. `7263d13` wears THIS task's label but touches zero
  `packages/runner` paths — it swept in `packages/store` + `scripts/release`.
  Project rail 5 says neither is a rejection reason. Verify by CONTENT, never by
  commit label, in both directions.
- Launcher modules NOT grown: lifecycle 249 / port-results 250, last touched by
  `94d487b` (a different task).

## The two QA mutation drills, and what each proved

Run against the PRODUCTION surface, not a helper. Both restored by sha256
hash-check back to pre-drill bytes.

1. **`?? 0` at the `readCount` choke point** (`return knownCount(0) ?? absent`
   on both the `source === null` and `typeof raw !== "number"` arms) -> 6 red.
   Message: `expected 'COMPLETE' to be 'UNKNOWN'`. It reddens on the coverage
   CLASS, not on a merely different number — which is the strong form.
   NOTE the ordering trap: `readCount` returns `absent` at `source === null`
   BEFORE the `typeof` check, so drilling only the `typeof` arm misses the
   missing-usage-block case entirely.
2. **Truncation guard disabled** in `decodeCapture` -> 5 red. Interesting result:
   the refusal did NOT become a summed prefix, it became
   `TELEMETRY_CAPTURE_UNDECODABLE` — the `byteLength`/`sha256` integrity check
   sits directly behind the truncation guard and catches a cut capture anyway.
   So the truncation guard is load-bearing for the CODE/LAYER identity rather
   than for never-summing. The tests survive that only because they pin the exact
   code; an assertion of "refused" would have stayed green.

## Design facts worth not re-deriving

- `parseClaudeResultTelemetry` hardcodes `infrastructure: "NONE"` on its own
  success path; the WRAPPER's `infrastructureOf` is the real authority and only
  reports `NONE` when `truthClass === "PROVEN"`. A failed *stderr* capture gives
  `UNKNOWN` even when stdout parses perfectly.
- `CLAUDE_TELEMETRY_ANOMALY_REFUSALS` is the parser's actual dispatch table AND
  is exported, so asserting it `toEqual` `CLAUDE_STREAM_ANOMALIES` is an
  assertion against the production surface, not a test reimplementation.
- Withheld from the root on purpose: `knownCount`, `readCount`, `readText`,
  `countCoverage`, `unknownFact`, `telemetryRefusal`, `snapshotRunRef`,
  `PROVIDER_TELEMETRY_MESSAGES`. Every one MINTS a fact. Both
  `index-surface.test.ts` and the plain-Node child probe assert 0 leaks WITH a
  positive control over published names.

Unblocks consumers `task-159f4c21ef9149e8a65f24735c9c1475` and
`task-6cbff01023b14b26a78fc5e3eb1dd8a9`, and chain head
`task-8e307617` (normalize and persist provider run telemetry).

Related: `mem:gotcha-drill-restore-silently-fails-after-a-bash-cd`,
`mem:gotcha-truncation-on-a-record-boundary-is-the-equivalent-mutant`.
