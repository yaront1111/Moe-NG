# Handoff: dependency contract kernel

Task implementation is complete on `main` at commit `7e80186` (`feat(scheduler): add dependency kernel`). The commit contains exactly eight owned files under `packages/scheduler/src/dependencies/**`: three focused TypeScript modules, three one-line NodeNext `.js` shims, and two test files. The scheduler root export remains unchanged, so this internal milestone surface is sealed from package subpaths.

## Delivered behavior
- Exact hard/nonblocking requirement projection with immutable graph-bound typed contracts, four producer arms, mandatory alternatives, witness/fact provenance, local truth vocabulary, and hostile-input-safe normalization.
- MONOTONIC survives only a complete matching predicate registry/schema/source-operation entry; unregistered claims normalize to REVOCABLE, mismatches and proxied registries fail closed.
- Exact witness validation, eleven-gate inclusive horizon ordering, explicit REVOCABLE invalidation records, MONOTONIC flip refusal, and typed no-op after the horizon.
- Contract redundancy assessment consumes the existing structural `RedundancyCandidate`, always carries literal `requiresSemanticProof: true`, and exposes no removal/activation authority.
- Both challenge directions, successor planning-run bindings, canonical hash+epoch+sorted-fact dedup identity, own-lease self-holds only, mutual-hidden-hold refusal, and current hard-contract enforcement.

## Review and evidence
Independent adversarial review found and re-checked fixes for own-undefined property presence, dedup identity/enforcement, forged self-alternate candidates, cross-graph comparison, and nested freeze/property coverage. Production line counts are 250/180/248; tests are 300/300. Forbidden nondeterminism/dependency scans are clean; no scratch files exist.

Fresh required gate: `pnpm --filter @moe/scheduler typecheck && pnpm --filter @moe/scheduler test` -> exit 0, 21 files / 249 tests. Fresh repository regression: `pnpm typecheck && pnpm test` -> exit 0, 86 files / 1195 passed / 1 skipped. Own dependency path is clean; concurrent untracked `packages/scheduler/src/authority/**` belongs to task `task-967769ea801f4fe09944e4fdcc47663e` and was not staged or committed.

See `mem:gotcha-dependency-contract-property-presence` and `mem:gotcha-dependency-challenge-dedup-identity`.