# QA verdict — task-e17da1c9 Predecessor input materializer: APPROVED

Verified 2026-08-09 by qa-017ee6b6 against commit `5d77dde` (20 files, +2865, all under
`packages/runner/src/materialization/`, zero foreign paths, working tree clean vs HEAD).

## Gates I re-ran myself (not trusted from the worker note)

- `pnpm --filter @moe/runner typecheck` -> exit 0.
- `pnpm --filter @moe/runner test` -> exit 0, **30 files / 980 tests**. Matches the worker's claim.
- Per-file cap: largest production file `dependency-witness-mirror.ts` at **239** lines; all 8
  production modules under 250. Counted with `wc -l`, not `Measure-Object`
  (`mem:powershell-measure-object-line-undercounts`).

## Mutation drill — I re-ran it, 7 operands, 7 KILLED, 0 survived

Per `mem:pattern-qa-verify-a-mutation-drill-instead-of-reading-it`. Backups outside the repo,
`trap restore EXIT`, one operand at a time, ending `git diff --quiet` -> `CLEAN_RESTORED_OK`.
Baseline 4 files / 125 tests in the directory.

| operand | result |
|---|---|
| `witness-recheck.ts:47` downgrade returns `contract.stability` instead of `"REVOCABLE"` | 4 failed |
| `input-manifest-digest.ts:172` drop the once-only artifact-identity rule | 1 failed |
| `predecessor-selection.ts:141` ambiguity -> silent `continue` | 5 failed |
| drop `producerAdoptionRef` from `inputTreeDigestInput` | 2 failed |
| `manifest-staleness.ts:102` ignore witness VERSION movement | 3 failed |
| drop `environmentRequirements` from `inputBindingDigestInput` | 2 failed |
| `witness-recheck.ts:182` duplicate-witness conflict resolved by contract order | 2 failed |

Note the non-crashing-operand rule from `mem:gotcha-layered-digests-defeat-mutation-drills` worked:
the stability operand returns a WRONG answer rather than throwing, so red means attached assertion.

## Mirror-vs-authority check (the thing most likely to be a silent bypass)

Compared `dependency-witness-mirror.ts` check-for-check against
`packages/scheduler/src/dependencies/dependency-contract.ts`:
- `:248` MONOTONIC-without-proof downgrade — **preserved** (`witness-recheck.ts:42-48`).
- `:245` proven-MONOTONIC operation-class mismatch refusal — **preserved** (`:49-61`).
- `:189` registry dedupe on `[predicateRef, schemaId, schemaVersion]` — **preserved** (`:218`).
- `DEPENDENCY_GATES` compared at RUNTIME by importing both through their `.js` bridges:
  **GATES_IDENTICAL**, 11 elements in order. `MILESTONES` and `OPERATIONS` string-identical too.
- Divergences are closed-direction only (mirror requires non-empty witness/fact lists, tighter
  `isRef`). Mirror never accepts what the authority refuses — see
  `mem:gotcha-mirror-is-stricter-than-the-authority-it-clones` for how the deferred cross-package
  drift test must be partitioned when someone finally writes it in `apps/daemon`.

## Bridges

8 `.js` bridges, exact `ls`-diff parity with the 8 non-test `.ts` modules. Plain-Node probe:
positive (all 8 import, 0 undefined bindings, 1-17 exports each), negative control still raises the
literal `ERR_MODULE_NOT_FOUND`. The vitest gate is blind to this, so the probe is the only evidence.

## Test-quality spot checks

- 33 `code:` and 34 `layer:` assertions; failures asserted as whole objects, so an extra or missing
  field fails too.
- Closed-vocabulary sweep asserts **set equality both directions** for all 25 codes and all 4
  layers, and guards `REFUSALS.length > 0` so a zero-case sweep cannot pass.
- Ordering expectation is **hand-written**, plus 4 input permutations against the same constant.
- Refused seal checked by **key set** (`["code","detail","layer","message","ok"]`), not by a boolean.
- Digest binding: 18-case table, **one field per assertion**, plus a distinct-hash set-size check.

## One flagged non-defect (do NOT re-litigate as a bug)

`manifestVersion` appears in all three digest-input records and `inputTreeDigest` in two, so the
file's own "each field is bound in EXACTLY ONE record" claim holds for the design-256 payload fields
but not for those two structural ones. Consequence is only that deleting either from one builder
would survive a mutation drill. No correctness or binding gap: both are still bound, and
`revalidateSealedManifest` recomputes all three digests. Not a rejection reason.

## Commit-hygiene finding that is NOT this task's fault

`c699422` lands 2 minutes after `5d77dde`, carries this task's id in its subject, and sweeps 31
files including 18 `.moe/` state files plus other agents' in-flight control-room/daemon/core work.
It contains **zero** materialization files. The same shape appears at `9e0f123` (20 files, 18
`.moe/`) for a different task, so it is a recurring environment sweep, not a worker's `git add -A`.
Do not attribute it to the completing task — check `moeStateFiles` count before calling rail 3.
