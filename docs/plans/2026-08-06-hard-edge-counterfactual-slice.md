# Hard-Edge Counterfactual Slice

**Goal:** Give planners an exact, review-only view of which validated source-graph HARD edges create structural serialization, without claiming an edge is unnecessary or authorizing its removal.

**Boundary:** Pure `@moe/scheduler` analysis over a runtime-provenanced `ValidatedGraph`. No graph mutation, semantic dependency verdict, speed claim, persistence, command, approval, lease, budget, provider, or execution authority.

## Work

- [x] Verify the existing validated-graph, index, stage-count, closure, provenance, and immutability contracts.
- [x] Add RED tests for chain pressure, diamonds, parallel edges, closure loss, advisory/non-execution relations, determinism, provenance, immutability, and maximum-policy bounds.
- [x] Add focused counterfactual model and algorithm modules with runtime bridges.
- [x] Export the review-only API through the supported package root and runtime smoke path.
- [x] Run scheduler/root/typecheck/runtime/static gates and keep every changed file below the split-review threshold.
- [x] Obtain independent adversarial review, resolve findings, and commit exact reviewed bytes.

## Truth contract

Every record reports topology after removing exactly one HARD edge in memory. `dependencyNecessity` remains `UNKNOWN`, `requiresSemanticProof` and `reviewOnly` remain true, and duration remains `null`. A lower structural stage count is not a speed claim; broken completion closure is reported rather than hidden. Structural HARD roots are not logical, admission, or dispatch readiness.
