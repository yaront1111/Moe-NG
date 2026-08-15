# task-e17da1c9 handoff — Predecessor input materializer

**DONE, committed `5d77dde`** on `moe/work-2026-08-08`. 20 files, +2865, all `create mode`,
zero foreign paths. Greenfield `packages/runner/src/materialization/`.

## What landed — 8 production modules, 4 test files

| module | lines | owns |
|---|---|---|
| `materialization-kernel.ts` | 169 | closed vocabulary: 25 error codes, 4 refusal layers, ceilings, `materializationFailure`, `readBoundedList`, `QUALIFYING_MILESTONES`, `isMirroredGraphKey` |
| `dependency-witness-mirror.ts` | 239 | mirrored SHAPE + parsers (return `null`, caller picks code) |
| `witness-recheck.ts` | 219 | the `MATERIALIZATION_SEAL` verdict, `effectiveStability` |
| `predecessor-candidate-parse.ts` | 144 | hostile-input parsing of the closure |
| `predecessor-selection.ts` | 161 | ordering, dedupe, ambiguity |
| `input-manifest-digest.ts` | 238 | the 3 digest-input builders + manifest shape parsers |
| `input-manifest-seal.ts` | 158 | `sealNodeInputManifest` |
| `manifest-staleness.ts` | 150 | `revalidateSealedManifest` |

Everything is a **pure function over caller-supplied records**. No filesystem, Git, clock,
randomness, or `process.env`. Scratch-worktree materialization and fan-in are out of scope.

## THE PLAN NAMED 4 MODULES; 8 SHIPPED

Not scope growth — three per-file-cap splits. The single-module versions hit 407, 281 and 286
lines. Rail 5's remedy for a per-file violation IS splitting the file. Consequence for the next
person: **re-derive the module list from disk, never from a plan or a memory** (same lesson as
`mem:task-task-eb9ff081a7644e0dbd90a52f94cc7790-handoff`, where the count moved three times).

## Why the witness surface is mirrored, not imported

`@moe/runner` depends only on `@moe/contracts`; `packages/scheduler/src/dependencies/` is not on
the `@moe/scheduler` root export and the exports map is exclusive. `supervisor/lease-mirror.ts` is
the precedent. **It is a RE-VALIDATION, never a shape cast.**

Two authority normalizations that MUST survive any edit:
- `dependency-contract.ts:248` — a `MONOTONIC` contract with **no registry proof** normalizes DOWN
  to `REVOCABLE`. Skipping it exempts from recheck a witness the authority calls revocable —
  silent, and in the unsafe direction.
- `dependency-contract.ts:245` — a proven `MONOTONIC` contract whose witness `sourceOperationClass`
  disagrees with the registered predicate is REFUSED.

Divergence is allowed only in the **closed** direction (this mirror's `isRef`/`isCount` are tighter
than the authority's). The verdict-EQUALITY drift test cannot live here. **Follow-up owed by a
package that sees both** — `apps/daemon` is where `task-49acb856` put the lease-mirror equivalent
(`work-races.test.ts`, 36-row hand-written table). Copy that shape.

## Two digests, not one — do not collapse them

Design line 218 and line 256 describe **different** field sets:
- `inputTreeDigest` — base + ordered entries with all 8 provenance fields
- `manifestSha256` — line 218: `manifestVersion` + `inputTreeDigest` + witness bindings
- `inputBindingHash` — line 256: authority hash, manifest digest, tree digest, environment
  requirements, provider-runtime observation, graph/binding epoch

**Each field is bound in EXACTLY ONE digest-input record** and reaches the others transitively
(the `workspace-contract.ts:141` precedent). This is deliberate: a field bound twice **cannot be
mutation-tested**, because deleting it from one builder leaves the sibling covering it and the
suite stays green. Tamper detection recomputes **all three**, which closes the hole transitive
binding would otherwise open. See `mem:gotcha-layered-digests-defeat-mutation-drills`.

`providerRuntimeSha256` is **required-and-nullable** (`exactOptionalPropertyTypes` is on). At seal
time there is genuinely no provider-runtime observation yet — it resolves before `effect.activate`,
after the claim. `null` binds differently from a digest, so a later attempt that resolves one gets
a different `inputBindingHash`. That is the fail-closed direction.

## Deliberate strictness, flagged for QA

`revalidateSealedManifest` refuses on **any** witness movement, monotonic or not. The `MONOTONIC`
exemption is implemented where design line 382 puts it — the recheck **at seal**. Line 382 is
explicit that "a current or accepted attempt cannot adopt a changed witness in place", and an
already-sealed manifest is exactly that case.

## Four fail-closed gaps found by adversarial review, AFTER 975 tests were green

All four were invisible to the suite. Each is now mutation-verified.
1. **A forged selection bypassed the ambiguity refusal.** The seal took a typed
   `PredecessorSelection` and re-parsed only its shape, so a caller who never called
   `selectPredecessorInputs` could seal one artifact identity bound to two producers. DoD 3 was
   avoidable by not using the selector. `parseSelectedInputs` now enforces the once-only rule itself.
2. **Registry proofs resolved by list order** — the mirror accepted two proofs for one
   `(predicateRef, schemaId, schemaVersion)` where the authority refuses (`:189`), i.e. MORE
   permissive than what it mirrors.
3. **One witness declared by two contracts at different versions was picked silently** by contract
   order — structurally the same defect as ambiguous producers, which this task refuses elsewhere.
4. Staleness parsers used bare `typeof`, fail-closed by luck rather than construction.

**Lesson: the boundary you own needs the same re-validation you demand of a foreign one.**

## Evidence

- `pnpm --filter @moe/runner typecheck` exit 0; `test` exit 0 at **30 files / 980 tests**, from a
  26 / 855 baseline.
- Repo-wide `pnpm test`: **163 files / 3021 passed, 1 skipped, ZERO failures.** The
  `j4-replan-stale` failure that stalled three earlier workers is **gone** at this HEAD (fixed by
  `3944a9d`). Any task whose gate is repo-wide `pnpm test` can now reach exit 0.
- **9 mutation operands, 9 killed, 0 survived**, each restored by byte-compare against a backup
  held OUTSIDE the repo (these files were untracked, so `git checkout --` could not restore them).
- Closed-vocabulary sweep asserts **set equality** between the 25 declared codes and those
  reachable from real production surfaces, and the same for all 4 layers.
- Plain-Node bridge probe, all three controls: 8 bridges load with 0 undefined bindings,
  `@moe/runner` still resolves through its exports map with 66 exports, unbridged paths still
  raise the literal `ERR_MODULE_NOT_FOUND`.

## For the consumer (`task-fa96b81c` Readiness explanation engine is next in the chain)

Nothing is exported from `packages/runner/src/index.ts` — deliberate, matching the supervisor and
claude subtrees. Import the module paths directly, or add a curated seam to `index.ts` (which this
task did not own). The public surface: `selectPredecessorInputs`, `sealNodeInputManifest`,
`revalidateSealedManifest`, `recheckMaterializationSealWitnesses`, `effectiveStability`, plus the
kernel vocabulary.
