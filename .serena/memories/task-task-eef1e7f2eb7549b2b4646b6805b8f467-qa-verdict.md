# QA verdict: dependency contract kernel (task-eef1e7f2) — APPROVED at 7e80186

Reviewer qa-813cd351, 2026-08-07. Commit `7e80186 feat(scheduler): add dependency kernel`,
exactly the 8 owned paths under `packages/scheduler/src/dependencies/**`, +1281/-0, no foreign
paths staged. Every gate re-run in the foreground from disk; nothing taken from worker summaries.

## Gate evidence (foreground, mine)

| check | result |
| --- | --- |
| `pnpm --filter @moe/scheduler typecheck && ... test` (the task's named command) | **exit 1, foreign-only** — see attribution |
| `tsc --project` with only `src/admission/**` excluded | exit 0 |
| focused `vitest run packages/scheduler/src/dependencies`, twice | 2 files / 27 tests, byte-identical both runs |
| whole scheduler package suite | 24 files / 278 tests passed (25th was the foreign admission suite) |
| repo `pnpm test` | 92 files, 1313 passed, 1 skipped, exit 0 |
| repo `pnpm typecheck` | red, single foreign error only |
| `grep -rnE "Date\.now\|Math\.random\|process\.\|@moe/\|require\(" dependencies/` | zero hits |
| imports out of `dependencies/` | only `../graph-key.js`, `../graph-model.js`, `../runtime-shape.js`, `../validate-graph.js`, `../analyze-graph.js`, `vitest` — nothing outside the package |
| `grep dependencies packages/scheduler/src/index.ts` | not exported (matches the plan's Branch-A decision) |
| shims | 3 × `export * from "./<mod>.ts";`, one line each |
| scratch files | none; my temp `tsconfig.qa-tmp.json` deleted, owned paths clean |

### Foreign-work attribution — do not re-diagnose
The only red is `packages/scheduler/src/admission/**`, reported `??` (UNTRACKED) by
`git status --porcelain`, owned by `task-84e875f9`. It was live under me during review: the error
moved from `TS2307 Cannot find module './admission-pass.js'` (TDD RED) to
`TS6133 'INTERFACE_RULING' is declared but its value is never read` inside ~2 minutes, and by the
repo `pnpm test` run its suites were green. Zero overlap with owned paths. `src/authority/**` was
also untracked at review start and landed as `c0b564e` mid-review.

**Bonus integration evidence:** admission already imports this kernel —
`admission-model.ts:9-10` (`ContractRedundancyAssessment`, `DependencyContract`,
`DependencyTruthClass`), `admission-pass.ts:17` (`validateDependencyContract`),
`admission-pass.test.ts:5`. A downstream consumer compiles and passes against the API, which is
stronger than the kernel's own suite.

## DoD mapped to code, not to prose

1. **Complete contract + exact witness provenance** — `dependency-contract.ts:195` `parseContract`
   demands all 17 `CONTRACT_KEYS` present via `record()` (extra own string keys refused by
   `hasOnlyOwnStringKeys`). `dependency-contract.test.ts:109` loops `Object.keys(validContract())`
   deleting each field -> exactly one `DEPENDENCY_CONTRACT_MALFORMED`. Witnesses: `parseWitnesses`
   requires >=1, exact `{witnessRef, witnessVersion, witnessDigest, sourceOperationClass}`,
   dedup by ref, sorted. Producer is a 4-arm discriminated union keyed 1:1 to `edgeKind`, with its
   own `DEPENDENCY_PRODUCER_KIND_MISMATCH` (:241) separate from generic incompleteness.
2. **MONOTONIC schema-proven, uncertainty -> REVOCABLE, explicit invalidation** — `:243-248`.
   `proof` = registry entry matching `predicateRef` + `schemaId` + `schemaVersion`; MONOTONIC with
   proof but any witness whose `sourceOperationClass` differs -> `MONOTONIC_OPERATION_MISMATCH`;
   MONOTONIC with no proof -> demoted to `REVOCABLE` on a fresh copy. Bare `provenMonotonic: true`
   and `new Proxy([entry], {})` both -> `PREDICATE_REGISTRY_MALFORMED`. Invalidation is a typed
   event (`dependency-witness.ts:163`): MONOTONIC flips refused outright; horizon is the 11-gate
   total order asserted over all 121 pairs (`invariants.test.ts:50`); at-horizon records, one past
   returns a frozen `NO_OP_AFTER_HORIZON` with no `event`/`history` property.
3. **Redundancy stays a candidate** — `assessContractRedundancy` consumes a real
   `analyzeGraphStructure(...).structuralRedundancyCandidates[0]` (not a hand-built literal),
   returns literal-typed `requiresSemanticProof: true`, and the test asserts
   `JSON.stringify(result)` does not match `/safeToRemove|removal|activation/`. Forged
   self-as-alternate (`edges.includes(edgeKey)`) and cross-graph `graphBindingDigest` refused.
4. **Focused gates** — above.

## Mutation testing (3 mutants, all killed, tree restored via `git checkout --`)
- drop the `proof === undefined -> REVOCABLE` demotion: **3 tests die**
- `isWithinHorizon` `gateRank <= horizonRank` -> `<`: **2 die** (the "up to and including" boundary)
- allow a contract on a non-blocking edge kind: **2 die**

## LOC ruling — the point worth reusing
+1281 total = 678 handwritten production (contract 250, analysis 248, witness 180 — every module
at/under the 250 target and well under the 400 rail) + 600 tests + 3 shim lines. That is 1.7x the
400-net-LOC QA bar and I approved anyway. Reasoning, stated so the next reviewer can follow it:
- `mem:gotcha-core-aggregate-loc-bar` names *this exact task* ("dependency kernel") as a case where
  the bar and the named per-package gate are in structural conflict, and records that a size-only
  reject on landed aggregate work leaves the worker an **empty action space**.
- Precedent `mem:task-task-cc9a6953a1274b5eab5d82d15322ddd8-qa-verdict` (+1814, approved) vs
  `bcdc2f6` (+3116, rejected). At 678 production this is the **smallest aggregate in M2 so far**
  (cf. `c0b564e` +2535, `c4f9f6a` +1621, `bcdc2f6` +3116).
- Plan file count 8 is inside the runtime's <=10 limit; no module needs splitting.

## Residual notes, recorded not rejected
- `DEPENDENCY_WITNESS_MONOTONIC_PROOF_INVALID` is also returned when the *registry itself* is
  malformed (`dependency-witness.ts:120-121`), not only on a source-operation mismatch. Fail-closed
  and strictly more conservative, but the code name is slightly wider than it reads.
- The registry's `parameterSchema.digest` is never compared to the contract's
  `satisfactionPredicate.parametersDigest`. Correct — one is the schema, the other the bound
  parameters — but a future reader may mistake it for a missing check.
- The 5-value truth vocabulary is duplicated locally (scheduler is dependency-free) and only
  pinned by a test comment ritual at `invariants.test.ts:66`. Drift from the canonical set would
  not be caught by any gate. Unchanged from the approved plan.

See `mem:task-task-eef1e7f2eb7549b2b4646b6805b8f467-handoff`,
`mem:gotcha-dependency-gate-uncommitted-siblings`.
