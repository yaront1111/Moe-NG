# Verification process wrapper — handoff

Commit `3185742`, branch `moe/work-2026-08-08`. 15 files, +1598/-5.
Verification: `pnpm --filter @moe/runner typecheck && pnpm --filter @moe/runner test` -> exit 0,
38 test files / 1139 tests passed.

## What landed

`runVerifierProcess` in `packages/runner/src/evidence/`, split across six production
modules because one module would have been ~370 physical lines (epic rail 5 is a PER-FILE
cap; this was a file split, not a task split):

| file | lines | role |
|---|---|---|
| `verifier-process.ts` | 102 | run registry + `runVerifierProcess` + re-exports |
| `verifier-process-run.ts` | 235 | spawn, capture, reap, classify |
| `verifier-process-contract.ts` | 209 | codes, layers, bounds, input/result types, hermetic env |
| `verifier-process-gate.ts` | 127 | everything decided while no child exists |
| `verifier-process-launcher.ts` | 94 | `ProcessLauncher` port + `createNodeProcessLauncher` + killTree |
| `verifier-process-capture.ts` | 49 | bounded per-chunk stream collector |

Order is GATE -> REGISTRY -> SPAWN. Published on the `@moe/runner` root via
`surface/evidence-surface.ts` (index.ts already `export *`s that surface — do not edit index.ts).

## Non-obvious decisions a reviewer will ask about

- **Own code list, foreign failures verbatim.** `RUNNER_EVIDENCE_ERROR_CODES` and
  `EVIDENCE_REFUSAL_LAYERS` live in `evidence-contract.ts`, which this task does not own and
  which is a frozen closed list. So the wrapper defines `VERIFIER_PROCESS_ERROR_CODES` /
  `VERIFIER_PROCESS_LAYERS` and carries supervisor and evidence failures through UNCHANGED.
  The result union is discriminated by `source: 'PROCESS' | 'SUPERVISOR' | 'EVIDENCE'` — that
  is the mechanism that answers "which layer refused".
- **12 codes, not the plan's 11.** Added `VERIFIER_PROCESS_GRANT_RUN_DIVERGENT` at layer
  REGISTRY. Without it REGISTRY had no reachable code, i.e. dead vocabulary. It is a real
  collision: `grantId` derives from intent+attempt and never covers the recipe, so one grant
  presented with two recipes must refuse rather than adopt.
- **Two guards on `truthClass`, on purpose.** A pre-spawn PROCESS/LAUNCH_GATE guard refuses
  UNKNOWN before any external effect; the authoritative `observedExecutionRejection` check still
  runs after. They are told apart by layer, and the suite asserts both — mutation drill (b)
  proves they are genuinely distinguishable.
- **Wrapper stops at an admissible `ObservedVerifierExecution`.** It never builds a receipt:
  `buildEvidenceReceipt` needs resultManifest/graph/lease/effect identity/obligations, all of
  which are the daemon consumer's facts.

## Consumer edge

Cross-package consumer is `task-44d4873eb9f746b1a978e97ff9743dc4` "Durable verification receipt
dispatch". The intra-package composition edge (evidence-surface.ts -> index.ts -> plain-Node
root smoke that really spawns a child) landed here.

## Foreign red at the time of completion (NOT this task's)

`pnpm typecheck` repo-wide fails only on:
```
apps/daemon typecheck: src/http/http-listener.test.ts(8,8): error TS2307: Cannot find module './http-listener.js'
```
`git ls-files --error-unmatch` on that path -> "did not match any file(s) known to git": an
untracked red suite from another agent's in-flight TDD. Not at the merge-base, not in commit
3185742. HEAD-minus-merge-base failing paths intersected with this task's owned paths is EMPTY.
Repo-wide `pnpm test` was fully green (191 files, 3489 passed).
