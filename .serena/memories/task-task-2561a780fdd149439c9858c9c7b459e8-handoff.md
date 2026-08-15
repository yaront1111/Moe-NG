# task-2561a780 (Scheduler expansion admission) — DONE, in REVIEW

worker-767ae903, 2026-08-10. Commit **b865e7c**, 9 files, all under
`packages/scheduler/src/expansion/`. Gate exit 0: 42 test files / 1125 tests, 0 failed
(baseline 41 / 1047). Repo-wide `pnpm -r typecheck` exit 0, zero TS errors.

## What landed

```
expansion-receipt.ts     235  closed receipt shape + refusal vocabulary + readers
expansion-evidence.ts    230  the seven derivations
expansion-preparation.ts 208  request envelope, delegated-refusal vocabulary, identity
expansion-admission.ts   317  the composer: order, all-or-none, unwind
expansion-admission.test.ts 825
+ four one-line LF `.js` bridges (`export * from "./<name>.ts";`)
```

Entry point `admitExpansion(value: unknown): ExpansionAdmissionResult`.

## Decisions a reviewer or successor will question

**No @moe/core import, against plan step 3.** Step 3 said compose
`validExpansionProposalIdentity`. The task DESCRIPTION says "NOT in scope: ... importing
@moe/core/@moe/runner", the objective says "dependency-free evidence validator", DoD 5 forbids
cross-package imports. Three against one. There is no `@moe/*` import at all — only
same-package relative, `node:crypto`, `vitest`.

**Limits composed, not redeclared AND not exported.** `checkExpansionLineage`
(admission-pass.ts:192) already ENFORCES 3/6/9 and returns the landed `ADMISSION_EXPANSION_*`
codes. Composing the CHECKER beats exporting the CONST: limits + enforcement + verbatim
delegated codes, and no unowned file touched. Step 1's pre-authorisation to export
`EXPANSION_LIMITS` was never needed.

**Order is the all-or-none mechanism.** All pure checks (evidence, lineage limits, admitGraph,
rotateOnce, capacity re-derivation, cap revision, bypass claim) run in `pureChecks` before
anything is reserved. Then budget, THEN resources — exactly one partial-hold path exists, and it
calls `cancelReservation` and returns the restored meter buckets as `unwind.restoredMeters`.
The never-started proof ref is legitimate: this kernel creates no attempt/run/lease/effect.

**`origin` beside the verbatim `layer`.** Fairness owns a `RESOURCE` layer and so does the
acquisition surface, so the delegated layer ALONE is ambiguous exactly where two layers can both
refuse. Surfaces with no layer of their own (admission, budget, authority) get `layer === origin`.

**Only three local codes**, each for a fact no closed tuple can express: REQUEST_MALFORMED (my
envelope), NO_FAIRNESS_OPPORTUNITY (`rotateOnce` returns ok:true carrying IDLE), 
RESOURCES_UNAVAILABLE (`reserveAll` returns ok:true carrying WAITING). Those two ok-but-not-an-
admission cases are easy to miss.

**childWidth is DERIVED; depth and node count are not.** The request's `lineage` accepts exactly
`expansionDepth` and `nodesAddedInExpansion` — structural facts about the surrounding graph a
receipt cannot see. A caller-supplied `childWidth` is refused as an unknown key.

## The defect a green drill found — read `mem:gotcha-a-digest-can-mask-every-field-it-covers`

`evidenceDigest` was `digestOf(wholeEvidenceValue)`, which re-bound seven scalars already bound
beside it. Dropping any of them from the identity left every perturbation test GREEN. A sweep of
all 15 bound fields found THREE unfalsifiable (proposalId, childKeys, sourceDigests), not one.
Fixed in production: evidenceDigest digests only per-child scope/oracle/input facts;
`ExpansionChildFacts` deliberately OMITS `childKey` (childKeys binds it once, same loop, entry i
== key i); added single-field perturbations. Re-sweep reddens on all fifteen.

## Fixtures that work (reuse rather than re-derive)

- graph: `inputFor(chain())` from `../admission/admission-fixtures.js` — test-only, same-package,
  precedent in admission-pass.test.ts. The DoD-5 grep for `@moe/testkit|DEVELOPMENT_ONLY|@moe/runner`
  still returns EMPTY over the expansion dir (verified with a positive control).
- rotation: two resources weight 1, two entries deficitCounter 1, DISPATCHABLE items, capacities
  4/0. deficit 1 >= FAIRNESS_SERVICE_COST selects on round 0.
- budget: view `{accountId, state:"OPEN", version:4, meters:[{meter,available,reserved,quarantined,committed}]}`,
  admission needs ALL FIVE purposes (EXECUTION + the four protected) or it refuses.
- resources: `reserveAll` needs all 7 REQUEST_KEYS; `capacitySnapshot` is a plain id->units record.

## Stale plan claims — do not re-measure, do not repeat

The plan's "KNOWN baseline red" in `packages/scheduler/src/package-boundary.test.ts` (shebang
tokenizer) **does not occur**. Package is green at baseline. No inherited cover is available.

Related: `mem:gotcha-a-digest-can-mask-every-field-it-covers`,
`mem:gotcha-untracked-files-need-checksum-not-git-diff-for-drill-restores`,
`mem:gotcha-layer-only-and-code-only-drills-must-be-run-separately`.
