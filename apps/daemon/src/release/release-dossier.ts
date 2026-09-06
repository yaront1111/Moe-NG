import type {
  AncestryPredicate, AncestryVerdict, DossierCriterionFacts, DossierInput, DossierNodeFacts,
} from "./release-dossier-contracts.js";
import { RELEASE_DOSSIER_VERSION } from "./release-dossier-contracts.js";
import {
  GAP_SENTENCES, UNKNOWN, byCodeUnit, criteriaSection, gapsSection, oneLine, policySection,
  previewSection, reviewSection,
} from "./release-dossier-sections.js";
import type { CriterionRow, DossierGap, DossierGapCode } from "./release-dossier-sections.js";

/**
 * The PURE release-dossier generator: folded ledger facts plus a git sha plus an
 * injected ancestry predicate in, deterministic markdown out. No store handle, no
 * clock, no git — the core takes data, so the golden test is a data test and the
 * stored bytes can be re-derived byte-for-byte later.
 *
 * RE-MEASUREMENT is the point. Every cited landing commit is proven an ancestor of
 * the sha the dossier is built at. A commit that is not — or that git could not
 * decide — is rendered UNKNOWN and LISTED with its criterion id and a stable code.
 * It is never dropped: an omitted row and a verified row are indistinguishable to a
 * reader, so a dossier that drops what it could not verify reads as complete
 * evidence while being incomplete.
 *
 * ORDERING: criteria are sorted by `criterionId` here; the section renderers sort
 * gaps and review rounds by their own named keys. Nothing renders in Map order.
 */

export type { CriterionRow, DossierGap, DossierGapCode } from "./release-dossier-sections.js";

function gapOf(code: DossierGapCode, criterionId: string, detail?: string): DossierGap {
  return { code, criterionId, detail: detail ?? GAP_SENTENCES[code] };
}

/**
 * The predicate, consulted at most ONCE PER CITED COMMIT and never allowed to throw:
 * an unreachable git renders UNKNOWN rather than taking the whole dossier down.
 */
function memoized(ancestry: AncestryPredicate): AncestryPredicate {
  const seen = new Map<string, AncestryVerdict>();
  return (commitSha) => {
    const cached = seen.get(commitSha);
    if (cached !== undefined) return cached;
    let verdict: AncestryVerdict;
    try {
      verdict = ancestry(commitSha);
    } catch {
      verdict = "UNMEASURABLE";
    }
    seen.set(commitSha, verdict);
    return verdict;
  };
}

function uncovered(criterion: DossierCriterionFacts, detail?: string): CriterionRow {
  return {
    command: UNKNOWN,
    criterionId: criterion.criterionId,
    exitCode: UNKNOWN,
    gaps: [gapOf("CRITERION_UNCOVERED", criterion.criterionId, detail)],
    landing: UNKNOWN,
    nodeKey: UNKNOWN,
    receiptSha: UNKNOWN,
    title: criterion.title,
  };
}

/** A shared node key: the evidence exists but cannot be attributed to THIS goal. */
function shared(criterion: DossierCriterionFacts, node: DossierNodeFacts): CriterionRow {
  return {
    command: UNKNOWN,
    criterionId: criterion.criterionId,
    exitCode: UNKNOWN,
    gaps: [gapOf("RECEIPT_SHARED_NODE", criterion.criterionId)],
    landing: UNKNOWN,
    nodeKey: node.nodeKey,
    receiptSha: UNKNOWN,
    title: criterion.title,
  };
}

function landingOf(
  criterion: DossierCriterionFacts, node: DossierNodeFacts, ancestry: AncestryPredicate,
): { readonly gaps: readonly DossierGap[]; readonly landing: string } {
  if (node.landingSha === null) {
    return { gaps: [gapOf("LANDING_ABSENT", criterion.criterionId)], landing: UNKNOWN };
  }
  const verdict = ancestry(node.landingSha);
  if (verdict === "ANCESTOR") return { gaps: [], landing: node.landingSha };
  const code = verdict === "NOT_ANCESTOR" ? "LANDING_NOT_ANCESTOR" : "LANDING_UNMEASURABLE";
  return {
    gaps: [gapOf(code, criterion.criterionId, `${GAP_SENTENCES[code]} (${node.landingSha})`)],
    landing: UNKNOWN,
  };
}

function rowOf(
  criterion: DossierCriterionFacts,
  nodes: ReadonlyMap<string, DossierNodeFacts>,
  ancestry: AncestryPredicate,
): CriterionRow {
  if (criterion.nodeKey === null) return uncovered(criterion);
  const node = nodes.get(criterion.nodeKey);
  if (node === undefined) {
    return uncovered(criterion, `${GAP_SENTENCES.CRITERION_UNCOVERED} (${criterion.nodeKey} is`
      + " not an execution-bearing node of this goal)");
  }
  if (node.sharedAcrossPlans) return shared(criterion, node);
  const { gaps: landingGaps, landing } = landingOf(criterion, node, ancestry);
  const receipt = node.receipt;
  const receiptGaps = receipt === null ? [gapOf("RECEIPT_ABSENT", criterion.criterionId)]
    : receipt.sha === null ? [gapOf("RECEIPT_SOURCE_UNPROVEN", criterion.criterionId)] : [];
  return {
    command: receipt?.command ?? UNKNOWN,
    criterionId: criterion.criterionId,
    exitCode: receipt === null ? UNKNOWN : String(receipt.exitCode),
    gaps: [...receiptGaps, ...landingGaps],
    landing,
    nodeKey: node.nodeKey,
    receiptSha: receipt?.sha ?? UNKNOWN,
    title: criterion.title,
  };
}

/**
 * The criterion rows, derived in ONE place. Both the rendered dossier and the gap list
 * a refusal names come from this function, so the PR body and the detail on
 * RELEASE_EVIDENCE_INCOMPLETE cannot disagree about what is missing — a second copy of
 * this pipeline is exactly how they would come to.
 *
 * EXPORTED for the release READ (`http/release-read.ts`), which is the third consumer and
 * needs the rows THEMSELVES rather than the markdown or the flattened gap list: an operator
 * deciding a release is shown covered-versus-UNKNOWN per criterion, and that distinction only
 * survives at row granularity. Serving it from here rather than re-parsing the stored document
 * is the same argument `releaseDossierGaps` makes below — a reader that recovered rows from
 * prose would be a second, drifting implementation of this pipeline.
 */
export function criterionRows(
  input: DossierInput, ancestry: AncestryPredicate,
): readonly CriterionRow[] {
  const nodes = new Map(input.nodes.map((node) => [node.nodeKey, node]));
  const at = memoized(ancestry);
  return [...input.criteria]
    .sort((a, b) => byCodeUnit(a.criterionId, b.criterionId))
    .map((criterion) => rowOf(criterion, nodes, at));
}

/**
 * Every unverified-evidence gap for `input`, in the dossier's own row order — the same
 * gaps the "Unverified evidence" section renders, from the same derivation.
 *
 * A caller that needs to NAME what is missing (RELEASE_EVIDENCE_INCOMPLETE) reads this
 * rather than the stored dossier: `ReleaseDossierV1` keeps only the rendered markdown,
 * so re-parsing the document back into rows would reimplement this authority against a
 * prose artefact.
 *
 * Pure and SYNC on purpose: `AncestryPredicate` is sync so the core stays
 * byte-deterministic and fakeable, and making this async would force that decision back
 * open. `sha` is unused HERE because the derivation depends on the sha only through the
 * `ancestry` predicate, which the caller has already bound to it; the parameter is kept
 * so this reads at the call site exactly like `renderReleaseDossier(input, sha, ancestry)`.
 */
export function releaseDossierGaps(
  input: DossierInput, _sha: string, ancestry: AncestryPredicate,
): readonly DossierGap[] {
  return criterionRows(input, ancestry).flatMap((row) => row.gaps);
}

/**
 * Render the dossier for `input` AT `sha`. The sha is load-bearing: it is printed in
 * the header and it is the tree every cited landing commit is re-measured against, so
 * a render at `shaA` and a render at `shaB` differ even when the ledger facts are
 * identical.
 */
export function renderReleaseDossier(
  input: DossierInput, sha: string, ancestry: AncestryPredicate,
): string {
  const rows = criterionRows(input, ancestry);
  return [
    // Every interpolated value is collapsed to one line: a goal title carrying a
    // newline could otherwise inject a forged section into a document a human reads
    // as evidence. See `oneLine` in release-dossier-sections.ts.
    `# Release dossier: ${oneLine(input.goalTitle)}`,
    "",
    `- Goal: ${oneLine(input.goalId)}`,
    `- Project: ${oneLine(input.projectId)}`,
    `- Re-measured at sha: ${oneLine(sha)}`,
    `- Record: ${RELEASE_DOSSIER_VERSION}`,
    "",
    "## Acceptance criteria",
    "",
    ...criteriaSection(rows),
    "",
    "## Unverified evidence",
    "",
    ...gapsSection(rows),
    "",
    "## Review rounds",
    "",
    ...reviewSection(input),
    "",
    "## Preview decision",
    "",
    ...previewSection(input),
    "",
    "## Installed policy",
    "",
    ...policySection(input),
    "",
  ].join("\n");
}
