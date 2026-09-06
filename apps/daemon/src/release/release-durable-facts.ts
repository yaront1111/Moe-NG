import type { SqliteEventStore } from "@moe/store";
import { readLatestProjectConfiguration } from "../configuration/project-configuration-selection.js";
import { readCriterionGoal } from "../criterion-evidence/criterion-goal.js";
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
import type { DossierInput, DossierNodeFacts, DossierPreviewDecision, DossierReviewRound } from "./release-dossier-contracts.js";

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

/** Read approved scope and evidence through their durable validators; never infer a missing receipt. */
export function readReleaseDossierInput(
  store: SqliteEventStore, projectId: string, goalId: string,
): DossierInput | null {
  try {
    if (store.getHealth().projectId !== projectId) return null;
    const goal = readCriterionGoal(store, projectId, goalId);
    if (!goal.ok) return null;
    const bearing = new Set(goal.graph.content.snapshot.nodes.filter((node) => node.executionBearing).map((node) => node.nodeKey));
    const definitions = goal.graph.content.nodeAuthority.definitions.filter((node) => bearing.has(node.nodeKey));
    const subjects = new Map(definitions.map((node) => [node.nodeKey, compiledExecutionRef(projectId, goal.graph, node.nodeKey)]));
    const facts = [...subjects.values()].map((subject) => nodeFacts(store, projectId, subject));
    const configuration = readLatestProjectConfiguration(store, { projectId });
    return Object.freeze({
      criteria: Object.freeze(goal.criteria.map((criterion) => {
        const owners = definitions.filter((node) => node.criterionBindings.some((binding) => binding.criterionId === criterion.criterionId));
        return Object.freeze({ criterionId: criterion.criterionId, title: criterion.statement,
          nodeKey: owners.length === 1 ? subjects.get(owners[0]!.nodeKey) ?? null : null });
      })),
      goalId, goalTitle: goalTitle(store, projectId, goalId),
      nodes: Object.freeze(facts.map((fact) => Object.freeze(fact.node))),
      policyRevision: configuration.ok ? configuration.manifest.settings.policy.policyRevisionId : null,
      preview: previewDecision(store, projectId, goalId), projectId,
      reviewRounds: Object.freeze(facts.flatMap((fact) => fact.rounds)),
    });
  } catch { return null; }
}
