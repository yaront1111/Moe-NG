import type { SqliteEventStore } from "@moe/store";
import { readLatestProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { readCriterionArtifact } from "../criterion-evidence/criterion-artifact.js";
import type { IntegratedCriterionArtifact } from "../criterion-evidence/criterion-contracts.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
import type { CriterionGoal } from "../criterion-evidence/criterion-goal.js";
import { currentCriterionReceipts } from "../criterion-evidence/criterion-read.js";
import { decisionsOf } from "../decision-ledger-memo.js";
import { decodeGoalCatalogEntry } from "../http/goal-catalog-entry.js";
import { compiledExecutionRef } from "../orchestrator/compiled-execution-ref.js";
import { readPreviewDecision } from "../preview/preview-daemon-edge.js";
import { PREVIEW_DECIDE_COMMAND_KIND } from "../preview/preview-contracts.js";
import { readPreviewReceipt } from "../preview/preview-ledger.js";
import { previewAggregateId } from "../preview/preview-receipt-contracts.js";
import { readLandingReceipt } from "../repository/landing-ledger.js";
import { landingReceiptId } from "../repository/landing-receipt-contracts.js";
import { readReviewLedger } from "../review/review-read-model.js";
import { readVerifierReceipt } from "../review/verifier-receipt-ledger.js";
import type { DossierCriterionReceipt, DossierInput, DossierNodeFacts, DossierPreviewDecision, DossierReviewRound } from "./release-dossier-contracts.js";

function nodeFacts(store: SqliteEventStore, projectId: string, nodeKey: string): {
  node: DossierNodeFacts; rounds: readonly DossierReviewRound[];
} {
  const unknown: DossierNodeFacts = { landingSha: null, nodeKey, receipt: null, sharedAcrossPlans: false };
  try {
    const ledger = readReviewLedger(store, projectId, nodeKey);
    if (ledger.unreadable) return { node: unknown, rounds: [] };
    const rounds: DossierReviewRound[] = ledger.rounds.map((round) => ({
      nodeKey, outcome: round.routing.route === "ACCEPT" ? "ACCEPTED" : "REFUSED",
      refusalCode: round.routing.route === "ACCEPT" ? null : round.routing.reasonCodes[0] ?? round.routing.route,
      round: round.round,
    }));
    const accepted = ledger.accepted;
    const source = ledger.rounds.at(-1);
    if (accepted === undefined || source === undefined || source.routing.route !== "ACCEPT") {
      return { node: unknown, rounds };
    }
    const verified = readVerifierReceipt(store, projectId, accepted.verifierReceiptId);
    if (!verified.ok || verified.receipt.subjectRef !== nodeKey
      || verified.receiptSha256 !== accepted.verifierReceiptSha256
      || verified.receipt.reviewInputDigest !== accepted.reviewInputDigest
      || verified.receipt.source.decisionId !== source.decisionId
      || verified.receipt.source.resultSha256 !== source.resultSha256
      || verified.receipt.source.aggregateVersion !== source.aggregateVersion) {
      return { node: unknown, rounds };
    }
    const receipt = verified.receipt;
    const landed = readLandingReceipt(store, projectId, landingReceiptId(projectId, nodeKey, receipt.receiptId));
    const landingSha = landed.ok && landed.receipt.subjectRef === nodeKey
      && landed.receipt.verifierReceiptId === receipt.receiptId && landed.receipt.outcome === "COMMITTED"
      ? landed.receipt.commit?.sha ?? null : null;
    return {
      node: { ...unknown, landingSha, receipt: {
        command: receipt.execution.test, exitCode: receipt.execution.exitCode, receiptId: receipt.receiptId,
        // Legacy receipt bytes prove no Git SHA; the release edge must retain this gap.
        sha: receipt.execution.workspaceBinding?.headSha ?? null,
      } },
      rounds,
    };
  } catch { return { node: unknown, rounds: [] }; }
}

function goalTitle(store: SqliteEventStore, projectId: string, goalId: string): string {
  try {
    const event = store.readAggregateEvents(goalId, 0, 1).items[0];
    if (event !== undefined) {
      const decoded = decodeGoalCatalogEntry(event, projectId);
      if (decoded.ok && decoded.entry.goalId === goalId) return decoded.entry.brief?.title ?? goalId;
    }
  } catch { /* The identifier remains truthful when the original title is unavailable. */ }
  return goalId;
}

function previewDecision(store: SqliteEventStore, projectId: string, goalId: string): DossierPreviewDecision | null {
  let preview: DossierPreviewDecision | null = null;
  try {
    for (const decision of decisionsOf(store, 256)) {
      if (decision.key.projectId !== projectId || decision.commandKind !== PREVIEW_DECIDE_COMMAND_KIND
        || decision.effectDisposition !== "EFFECTS_COMMITTED" || decision.targetAggregateId !== previewAggregateId(goalId)) continue;
      // A newer unreadable verdict must not make an older approval look current.
      preview = null;
      const record = readPreviewDecision(store, projectId, decision.key.principalId, decision.key.commandId);
      if (record === null || record.goalId !== goalId) continue;
      const receipt = readPreviewReceipt(store, projectId, record.previewRef);
      preview = { decidedAt: record.decidedAt, decisionId: decision.decisionId, outcome: record.decision,
        url: receipt.ok && receipt.receipt.goalId === goalId && receipt.receipt.sha === record.sha ? receipt.receipt.url : null };
    }
    return preview;
  } catch { return null; }
}

/**
 * THE PER-CRITERION EVIDENCE, read through the criterion seam rather than re-derived here.
 *
 * `currentCriterionReceipts` is the SAME function goal closure consumes — traced:
 * goal-services.ts:166 refuses GOAL_CLOSE_CRITERIA_UNVERIFIED from `goalCloseReadinessFor` ->
 * `readGoalCloseReadiness` -> document-coverage-read.ts:190 `readCoverageCriterionAuthority` ->
 * document-coverage-criteria.ts:27, which calls it with the DEFAULT artifact read. This edge
 * calls it with the same default, so release and closure answer from one authority. Its rules —
 * latest run COMPLETED, artifact unchanged, receipt PASSED, approved check and criterion digest
 * still matching — are NOT restated here; a second copy is exactly the drift this exists to end.
 *
 * `artifactRead` is a TEST SEAM, the same one criterion-service.ts:18 carries and for the same
 * reason: production measures the workspace's own integrated Git artifact, and a lane with no git
 * object database can substitute that ONE measurement without doubling anything that decides.
 */
function criterionReceiptsOf(
  store: SqliteEventStore, goal: CriterionGoal,
  artifactRead: (root: string) => IntegratedCriterionArtifact | null,
): readonly DossierCriterionReceipt[] {
  try {
    return [...currentCriterionReceipts(store, goal, artifactRead)]
      .map(([criterionId, receipt]) => Object.freeze({
        artifactSha: receipt.artifact.sha, criterionId,
      }));
  } catch { return []; }
}

/**
 * Why there is no input. NO_APPROVED_SCOPE is the ORDINARY state: a foreign project, or a goal
 * that is absent, unbound, cancelled, or without a sealed plan yet. RELEASE_FACTS_UNREADABLE
 * is a store that THREW mid-read - STORE_BUSY under a concurrent seat writer, a closed or
 * poisoned handle - which says nothing about the goal at all. A reader that showed the second
 * as the first would tell an operator a goal has no evidence while its evidence is present.
 */
export type ReleaseDossierFactsCode = "NO_APPROVED_SCOPE" | "RELEASE_FACTS_UNREADABLE";

export type ReleaseDossierFacts =
  | Readonly<{ readonly input: DossierInput; readonly ok: true }>
  | Readonly<{ readonly code: ReleaseDossierFactsCode; readonly ok: false }>;

const NO_APPROVED_SCOPE: ReleaseDossierFacts = Object.freeze({ code: "NO_APPROVED_SCOPE", ok: false });
const FACTS_UNREADABLE: ReleaseDossierFacts = Object.freeze({ code: "RELEASE_FACTS_UNREADABLE", ok: false });

/**
 * The input, or null for BOTH refusals. The decide edge and the fixtures only need the input;
 * the release READ must not fold the two, so it calls `readReleaseDossierFacts` directly.
 */
export function readReleaseDossierInput(
  store: SqliteEventStore, projectId: string, goalId: string,
  artifactRead: (root: string) => IntegratedCriterionArtifact | null = readCriterionArtifact,
): DossierInput | null {
  const facts = readReleaseDossierFacts(store, projectId, goalId, artifactRead);
  return facts.ok ? facts.input : null;
}

/**
 * Read approved scope and evidence through their durable validators; never infer a missing
 * receipt. `readCriterionGoal` names one code per goal STATE (absent, unbound, cancelled, scope
 * mismatch) and keeps CRITERION_CHECK_UNREADABLE for a failure ON an approved plan - its own
 * store faults included, which it catches rather than throws. Measured: STORE_BUSY from
 * `store.readEvents` under the planning-run walk reaches this frame as that code and nothing
 * else, so it is the one refusal here that is a fault and not a fact about the goal.
 */
export function readReleaseDossierFacts(
  store: SqliteEventStore, projectId: string, goalId: string,
  artifactRead: (root: string) => IntegratedCriterionArtifact | null = readCriterionArtifact,
): ReleaseDossierFacts {
  try {
    if (store.getHealth().projectId !== projectId) return NO_APPROVED_SCOPE;
    const goal = readCriterionGoal(store, projectId, goalId);
    if (!goal.ok) {
      return goal.code === "CRITERION_CHECK_UNREADABLE" ? FACTS_UNREADABLE : NO_APPROVED_SCOPE;
    }
    const bearing = new Set(goal.graph.content.snapshot.nodes.filter((node) => node.executionBearing).map((node) => node.nodeKey));
    const definitions = goal.graph.content.nodeAuthority.definitions.filter((node) => bearing.has(node.nodeKey));
    const subjects = new Map(definitions.map((node) => [node.nodeKey, compiledExecutionRef(projectId, goal.graph, node.nodeKey)]));
    const facts = [...subjects.values()].map((subject) => nodeFacts(store, projectId, subject));
    const configuration = readLatestProjectConfiguration(store, { projectId });
    return Object.freeze({ ok: true as const, input: Object.freeze({
      criteria: Object.freeze(goal.criteria.map((criterion) => {
        const owners = definitions.filter((node) => node.criterionBindings.some((binding) => binding.criterionId === criterion.criterionId));
        return Object.freeze({ criterionId: criterion.criterionId, title: criterion.statement,
          nodeKey: owners.length === 1 ? subjects.get(owners[0]!.nodeKey) ?? null : null });
      })),
      criterionReceipts: Object.freeze(criterionReceiptsOf(store, goal, artifactRead)),
      goalId, goalTitle: goalTitle(store, projectId, goalId),
      nodes: Object.freeze(facts.map((fact) => Object.freeze(fact.node))),
      policyRevision: configuration.ok ? configuration.manifest.settings.policy.policyRevisionId : null,
      preview: previewDecision(store, projectId, goalId), projectId,
      reviewRounds: Object.freeze(facts.flatMap((fact) => fact.rounds)),
    }) });
  } catch { return FACTS_UNREADABLE; }
}
