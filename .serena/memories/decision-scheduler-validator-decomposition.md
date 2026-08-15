# Scheduler validator decomposition

Stable internal boundary for the current refactor:

- Public API remains only `validateGraphSnapshot` from `validate-graph.ts`; helper modules are internal and absent from `index.ts`.
- `validate-graph-input.ts`: hostile-safe bounded snapshot parsing, normalization, and record-local diagnostics. Preserve exact own-data-property/proxy/accessor defenses and length-before-element traversal.
- `validate-graph-structure.ts`: cross-record integrity, completion invariants, policy counts, HARD cycle/core detection, completion closure, sorted `GraphStructureView`, and optional traversal-counter behavior.
- `validate-graph.ts`: policy-first orchestration, canonical failure sorting/freezing, successful graph identity/materialization, deep freeze, and provenance registration.
- Determinism contract is centralized at the public boundary: failure issues are sorted by existing `sortIssues([code,nodeKeys,edgeKeys,message])`; successful nodes/edges retain the existing key sort before index/identity.
- Structural validation must not run topology on any integrity issue, must not infer dependent endpoint/completion facts when node shape is untrustworthy, and must never expose partially validated graph state.
