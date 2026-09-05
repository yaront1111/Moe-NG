# Every command edge echoed the refusal CODE as its `detail` — fixed 2026-09-05

Measured against the live UnAI daemon (branch `moe/work-2026-09-04`, HEAD a879421d) from two
real seats' transcripts, then confirmed by reading the edges.

## What the seats saw
- `planning.submit_decomposition`: seven graph shapes, all
  `{"code":"COMPILED_PLAN_ADMISSION_REFUSED","detail":"COMPILED_PLAN_ADMISSION_REFUSED"}`.
- `product_contract.propose_revision`: fifteen drafts, all
  `{"code":"PRODUCT_CONTRACT_PROVENANCE_MALFORMED","detail":"PRODUCT_CONTRACT_PROVENANCE_MALFORMED"}`.

## Cause (three layers, each dropping words)
1. `daemon-command-edges.ts` (and `daemon-command-dispatch.ts:74`,
   `daemon-foundation-verification-command.ts`, `daemon-v2-command-registry.ts` — ten sites)
   threw `new DomainRefusal(outcome.code, outcome.layer, outcome.code)`: the CODE as detail.
2. `compile-dispatcher.ts` `refused(compiled.code, compiled.layer)` dropped the producer's
   detail (`GRAPH_CONTENT_FIELD_INVALID@GRAPH_CONTENT_CODEC`, `dependsOn x of y`, ...).
3. `product-contract-provenance.ts` and `product-contract-propose-service.ts` refusals carried
   no detail at all.

## The fix (this row)
- `domainRefusalOf(outcome)` in `daemon-command-dispatch.ts`: the outcome's own `detail` when it
  is a non-empty string, else the code. All ten sites use it.
- `SubmitDecompositionRefused.detail?`, `ProvenanceRefused.detail` (required),
  `ProposeRevisionRefused.detail?` — every fence states what it saw.
- Tests pin the words: `compile-dispatcher.test.ts` ("answers a criterion-free join node with
  the producer's words"), `product-contract-provenance.test.ts`, `-propose-service.test.ts`.
  Two `/2` tests that pinned the provenance refusal with `toEqual` now carry
  `detail: expect.stringContaining(...)`.

## The /1 draft grammar the seat had to guess (now in `compilerMission`)
`draft` is EXACTLY `{authorRef, contractId, revisionId, lineage: null, requirements:
[{requirementId, statement, supersedesRequirementId: null}], criteria: [{criterionId,
requirementId, statement, supersedesCriterionId: null}], retiredRequirementIds: [],
retiredCriterionIds: [], sourceDocumentDigests: ["<contentSha256>"]}` — digests are BARE
lowercase sha256 strings (core `readSources`, `product-contract-admission.ts:68`), never the
`{sourceRef, contentSha256}` objects `documents_source_read` answers. The seat's ONE bare-string
attempt actually PASSED provenance and refused later at `draft.contractId` — it misread that as
"strings are wrong" and went back to objects.

Related: `mem:gotcha-compile-dispatcher-does-not-sort-the-node-roster` (fixed the same day).
