# @moe/review

The independent-review kernel (design section 15): pure, clock-free reducers that build the
**clean review package**, fold review rounds into an append-only **lineage**, and qualify a
reviewer and an acceptance. It holds no store, no I/O and no provider; the daemon supplies every
durable fact and consumes the verdict. Its one job is to make a reviewer's authority *derivable*
— from authorship, lease history, calibration, proof state and policy — instead of asserted.
`@moe/core` is its only workspace dependency, and it never restates a policy rule that
`evaluatePolicy` already owns.

## Seams

- `exports` is `.` → `src/index.ts` only. `canonical.ts` is deliberately **not** exported:
  `canonicalJson` / `canonicalDigest` / `deepFreeze` / `byCanonicalOrder` are package-local.
- `buildReviewPackage(items)` → `ReviewPackage`. Callers:
  `apps/daemon/src/review/review-services.ts` (the `review.submit` path) and
  `review-package-restore.ts` (rebuilds a stored round's package to re-derive its digest).
- `recordReviewRound(lineage, round, continuation?)` → `{ lineage, routing }`. Called by
  `review-services.ts` and re-run as a proof of consumption by
  `apps/daemon/src/review/review-continuation.ts` (`readReviewContinuationUse`).
- `qualifyReviewAcceptance(input)` → the four-gate acceptance verdict; the sole caller is
  `apps/daemon/src/review/review-acceptance.ts`.
- `qualifyReviewerForAcceptance` / `assessReviewerIndependence` / `reviewerCalibrationDigest`
  (`apps/daemon/src/review/reviewer-calibration-record.ts`).
- `validReviewContinuationApproval(value)` — the shape gate the daemon reuses when it *mints*
  the approval in `readReviewContinuationApproval`, so grant and reader cannot drift.
- Constants cross the boundary rather than being copied: `REVIEW_ESCALATION_ROUND_LIMIT`
  (`review-stall.ts`), `REVIEW_ROUND_ABSOLUTE_CEILING` (`review-acceptance.ts`,
  `governance-escalation-decider.ts`), `REVIEW_PACKAGE_ITEM_KINDS` (`review-round-items.ts`),
  `REVIEW_FINDING_SEVERITIES` / `REVIEW_FINDING_SUBJECT_KINDS` (`review-services.ts` and
  `orchestrator/agent-mission-review.ts`, which renders the seat's mission text from them).
- Refusals leave the kernel unchanged: `review-ledger.ts`'s `refuseFromKernel(kind, code, layer)`
  stamps source `REVIEW_KERNEL` and surfaces this package's `code` and `layer` verbatim.

## The model

- **Independence is a three-valued lattice, never a boolean.** `INDEPENDENT` /
  `NOT_INDEPENDENT` / `UNKNOWN`. `authorshipResolved` and `leaseHistoryResolved` are the
  fail-closed hinge; an *empty* `authors[]` is treated as unresolved (`authorshipKnown`), because
  a vacuous `includes` would clear the author. A blank `reviewer` or `subjectRef` is likewise
  unresolvable (`identified`). A proven disqualification dominates `UNKNOWN`, but both codes are
  reported. Only `MUTATING` leases by *that* principal over *that* `subjectRef` disqualify.
- **A finding's identity is `subject` + `ruleId` only.** `findingFingerprint` hashes nothing
  else, so rewording `detail` cannot evade repeat detection. A repeated *blocking* finding routes
  `REJECT_PLAN`; fresh blocking findings route `REJECT_IMPLEMENTATION`; a clean round `ACCEPT`.
- **Only CRITICAL/MAJOR block; MINOR is informational** (owner decision 2026-09-18). A MINOR own
  finding is recorded in the lineage exactly like any other, but it does not make the round
  unsuccessful, does not enter repeat detection, and does not stop the `clean && continuation`
  rescue. `clean` therefore means "no *blocking* own finding", not "no own finding". This is
  the fix for the UnAI 2026-09-18 loop: one honest MINOR note per round made every round
  unsuccessful, the escalation limit was reached, and past it the continuation could rescue only
  a round with no own findings, so the verifier never ran. Downgrading a finding to MINOR is a
  reviewer's explicit judgment that it no longer blocks — the record persists either way.
- **Attributed findings do not charge the reporter.** `ReviewFinding.attributedTo`
  (`{ nodeKey, criterionIds }`) names another node of the same sealed plan. Such records are
  stored and attested but excluded from `unsuccessfulRounds`, from repeat detection and from the
  `clean` test. This is the fix for the UnAI 2026-09-14/15 loop where an honest node escalated
  forever. The kernel admits *shape* only (`inertAttribution`, limits `criteria: 32`,
  `refLength: 256`, no control characters, no duplicates, canonically sorted); ownership is the
  daemon's question because it holds the sealed plan. A malformed attribution refuses the whole
  round with `FINDING_ATTRIBUTION_INVALID` rather than being dropped.
- **Lineage is self-attesting and append-only.** `lineageDigest` covers `records`,
  `unsuccessfulRounds` **and `highestRound`**, so a hand-reset counter or a lowered frontier is
  caught as `FINDING_LINEAGE_DIGEST_MISMATCH`. `highestRound` is the highest round *ever*
  admitted including clean ones, so an accepted round cannot be replayed. Round numbers pass
  `admissibleRound` (`Number.isSafeInteger` && `>= 0`) **before** the ordering comparison —
  `NaN <= highestRound` is false, so ordering alone never fired. Start from `EMPTY_REVIEW_LINEAGE`.
- **Exclusions are by construction, not by filtering.** `buildReviewPackage` admits only
  `REVIEW_PACKAGE_ITEM_KINDS`; `REVIEW_PACKAGE_FORBIDDEN_ITEM_KINDS` (`WORKER_TRANSCRIPT`,
  `SELF_ASSESSMENT`, `JOURNAL_ENTRY`, `HANDOFF_PERSUASION`) is disjoint and exists *only* to earn
  `PACKAGE_ITEM_KIND_FORBIDDEN` instead of the generic unknown code. `review-package.ts`
  therefore imports nothing from a transcript or journal surface — you cannot import a thing in
  order to leave it out. `ReviewPackageItemInput.kind` is a bare `string` on purpose so a
  forbidden kind is constructible at the boundary and refusable by name.
- **Five singleton kinds** (`GRAPH_HASH`, `INTEGRATED_TREE`, `PLAN_HASH`, `RUBRIC`,
  `SUBMITTED_BYTES`) resolve together in `pickSingletons`; a second occurrence is
  `PACKAGE_BINDING_AMBIGUOUS`, never first-wins. Digests are validated as 64-hex shape only
  (`isHex64`) — this package never hashes bytes.
- **Every caller field is read exactly once** into inert data (`admit`, `inertFinding`,
  `inertAttribution`) so a re-reading accessor cannot bind bytes that were never validated, and
  every returned value is `deepFreeze`d.
- **Acceptance is four ordered gates, each naming its layer**: `ELIGIBILITY` (author, mutating
  lease, `UNKNOWN` independence, calibration), `FINDINGS` (lineage attestation, continuation,
  `REVIEW_ROUND_CAP_REACHED` — reaching the cap never auto-accepts), `ACCEPTANCE` proof
  (`PROOF_FAILED` and `PROOF_UNKNOWN` stay distinct; anything outside the closed vocabulary is
  `PROOF_UNKNOWN`, not a fall-through), `ACCEPTANCE` policy (`evaluatePolicy` consumed whole,
  its `PolicyReasonCode[]` carried verbatim on `ReviewAcceptanceRefusal.policyReasonCodes`).
- **Continuation is a human grant, spent once.** `ReviewContinuationApproval`
  (`moe-review-continuation/1`) binds project, subject, the source decision id, its
  `resultSha256`, `sourceLineageDigest`, `sourceRound` and `unsuccessfulRounds`, and requires
  `decisionVersion > sourceAggregateVersion`. `reviewContinuationMatches` lets exactly one append
  onto the lineage the human saw; `reviewContinuationAccepts` re-derives the pre-approval lineage
  digest and refuses only if an *unattributed CRITICAL/MAJOR* record sits past `sourceRound`; a
  MINOR own note or an attributed record on the continued round does not spend the grant (UnAI
  2026-09-18: with "any unattributed record" the continuation could never rescue an all-MINOR
  round, so "Allow one more attempt" bought nothing and the operator looped on it). It suppresses
  escalation for that one round only — rejection history is never reset.

## Gotchas

- Every non-test `.ts` here needs its sibling one-line `.js` bridge (`export * from "./x.ts";`).
  All seven exist today; adding a module without one reds the daemon's runtime graph, not `tsc`.
- `tests/security/boundary-roster.security.ts` pins `"packages/review": 1` and rosters exactly
  `REVIEW_DECISION_LAYERS` (axis `integrity`). A second `export const *_LAYER(S)` in this package
  reds `EXPECTED_ROSTER_SIZE` (181) and the distribution together.
- `tests/security/integrity-hostile-cases.ts` imports this package by **relative path**
  (`../../packages/review/src/index.js`) because the lane tsconfig makes `@moe/review`
  unreachable by name; its three review arms replay a superseded round and race an
  unrepresentable one against `PACKAGE_LAYER` / `FINDINGS_LAYER` read out of the constant.
- `REVIEW_ROUND_ABSOLUTE_CEILING = 24` is a pinned literal, and
  `apps/daemon/src/review/review-acceptance.test.ts` asserts both `=== 24` and
  `=== REVIEW_ESCALATION_ROUND_LIMIT * 8`. Moving either bound edits both sides.
- `apps/daemon/src/http/runs-read.ts` deliberately **re-spells** the escalation limit as a local
  `ESCALATION_ROUND_LIMIT = 3` (comment says why). Changing `REVIEW_ESCALATION_ROUND_LIMIT` here
  leaves that status word behind.
- `canonical.ts` is a local mirror by design (precedent: `packages/runner/src/canonical.ts`), not
  an oversight — do not "de-duplicate" it into a shared package. It throws on anything
  non-canonicalisable, including non-safe-integer numbers, so unadmitted shapes cannot reach a
  digest as an unstructured `TypeError`.
- `tests/integration/release/release-version-surfaces.test.ts` pins this `package.json`.

## Testing

- One file, from the repo root: `pnpm vitest run packages/review/src/review-flow.test.ts`
  (root config includes `packages/**/*.test.ts`, `environment: "node"`, forks pool capped at 8).
- Whole package: `pnpm --filter @moe/review test` (it just runs vitest with `--root ../..` over
  `packages/review/src`). Typecheck: `pnpm --filter @moe/review typecheck`.
- Suites here: `review-flow.test.ts` (package binding + routing + acceptance end to end),
  `review-findings.test.ts` (round-number admission, the `NaN` regression),
  `review-attribution.test.ts` (the UnAI cross-node loop), `reviewer-eligibility.test.ts`
  (the lattice and calibration determinism), `review-continuation.test.ts`, and
  `runtime-entrypoint.test.ts`, which spawns a real `node --experimental-strip-types` child to
  prove `@moe/review` imports outside vitest's `.js` → `.ts` rewriting.
- Fixtures are hand-transcribed on purpose: nothing at module scope dereferences a module under
  test, because that aborts collection and reports `(0 test)` instead of naming the assertion.
- Outside coverage: `pnpm --filter @moe/daemon test` for `src/review/**` (acceptance, lineage,
  continuation, stall, read model, governance escalation), `pnpm test:security` for the hostile
  integrity arms and the boundary roster, and `tests/runtime/package-loadability.test.ts`, which
  probes every workspace package's runtime entry.
