import type { JsonValue } from "@moe/contracts";

import { missingCarryForwardFacts } from "../planning/carry-forward-evidence.js";
import type {
  CarryForwardDurableFact, CarryForwardEvidenceCode,
} from "../planning/carry-forward-evidence.js";
import { isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";
import { reviewContinuationAvailable } from "./review-continuation.js";
import { commitAccepted, payloadArray, payloadRef, refuse, refuseInvalidPayload } from "./review-ledger.js";
import type { CommandHandler, ReviewOutcome } from "./review-ledger.js";
import { arrayDetail, describeJson, firstDetail, refDetail } from "./review-payload-shape.js";
import type { PayloadParse } from "./review-payload-shape.js";
import { reviewDecisionRequired } from "./review-stall.js";

/**
 * Delta approval for a re-plan. Carry authority is unobtainable server-side today: the durable
 * evidence assembler pins all four required facts unreadable, just as supersession refuses to
 * emit CARRY while those sources do not exist. A caller may never supply those missing facts.
 *
 * Consequently the carry-forward classification remains in the total durable contract but is
 * unreachable through this handler: every admitted node is INVALIDATED for re-qualification.
 * The core validator is deliberately not called because handing it caller evidence was the
 * defect, not a guard. Empty hashes preserve the durable string shape without pretending a
 * server hash source exists, and grant nothing because this handler performs no comparison.
 *
 * Totality still matters: every supplied node lands in INVALIDATED exactly once, and a duplicate
 * node is refused rather than recorded twice.
 */

interface DeltaNodeInput {
  readonly nodeRef: string;
}

function parseNodes(values: readonly JsonValue[]): PayloadParse<readonly DeltaNodeInput[]> {
  const parsed: DeltaNodeInput[] = [];
  for (const [index, value] of values.entries()) {
    const at = `nodes[${String(index)}]`;
    if (!isPlainJsonObject(value)) {
      return { detail: `${at} must be a JSON object {nodeRef}, got ${describeJson(value)}`, ok: false };
    }
    const nodeRef = value["nodeRef"];
    if (typeof nodeRef !== "string" || nodeRef.length === 0) {
      return { detail: `${at}.nodeRef must be a non-empty JSON string, got ${describeJson(nodeRef)}`, ok: false };
    }
    parsed.push({ nodeRef });
  }
  return { ok: true, value: parsed };
}

const UNREADABLE_CARRY_FACTS = Object.freeze({
  dependenciesPresent: undefined,
  environmentClosureUnchanged: undefined,
  policySliceUnchanged: undefined,
  predecessorResultUnchanged: undefined,
} satisfies Record<CarryForwardDurableFact, undefined>);

const UNREADABLE_CODE: CarryForwardEvidenceCode = "CARRY_EVIDENCE_FACT_UNREADABLE";
const UNREADABLE_REASON_CODES = Object.freeze([
  UNREADABLE_CODE,
  ...missingCarryForwardFacts(UNREADABLE_CARRY_FACTS),
]);

/**
 * Classifies every node BEFORE anything is committed.
 *
 * The all-or-nothing shape is deliberate: a handler that committed each verdict as it went would
 * leave a partial delta behind when a later node's evidence turned out to be unusable, and a
 * partial delta is indistinguishable from a complete one once it is durable.
 */
export const classifyReplanDelta: CommandHandler = (context): ReviewOutcome => {
  const { ledger, request, store } = context;
  const nodeValues = payloadArray(request.payload, "nodes");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  const successorPlanRef = payloadRef(request.payload, "successorPlanRef");
  if (nodeValues === null || subjectRef === null || successorPlanRef === null) {
    return refuseInvalidPayload(request.kind, firstDetail(
      arrayDetail(request.payload, "nodes"),
      refDetail(request.payload, "subjectRef"),
      refDetail(request.payload, "successorPlanRef"),
    ) ?? "payload shape invalid");
  }
  if (Object.hasOwn(request.payload, "supportedCanonicalizerVersions")) {
    return refuse(request.kind, "REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE", "DAEMON_INGRESS");
  }
  if (nodeValues.some((value) =>
    isPlainJsonObject(value) && Object.hasOwn(value, "evidence"))) {
    return refuse(request.kind, "REVIEW_DELTA_EVIDENCE_UNSUPPLIABLE", "DAEMON_INGRESS");
  }
  if (nodeValues.length === 0) {
    return refuse(request.kind, "REVIEW_DELTA_NODES_EMPTY", "DAEMON_INGRESS");
  }
  const parsedNodes = parseNodes(nodeValues);
  if (!parsedNodes.ok) return refuseInvalidPayload(request.kind, parsedNodes.detail);
  const nodes = parsedNodes.value;
  if (new Set(nodes.map((node) => node.nodeRef)).size !== nodes.length) {
    return refuse(request.kind, "REVIEW_DELTA_NODE_DUPLICATED", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  // Funding another attempt and retiring the node are the human's answers (`escalation.decide` is
  // operator-only); this kind is agent-reachable, and its commit moves the node's version. So it
  // may override neither. An unspent grant can be spent only by the round committed right after
  // it, and taking that slot made the spending round, then the whole lineage, unreadable. Past a
  // REPLAN the successor handoff reads that decision as the node's last, with no delta after it.
  if (ledger.replanned) return refuse(request.kind, "REVIEW_NODE_REPLANNED", "DAEMON_PREREQUISITE");
  if (reviewContinuationAvailable(ledger)) {
    return refuse(request.kind, "REVIEW_CONTINUATION_ALREADY_AVAILABLE", "DAEMON_PREREQUISITE");
  }
  // Nor may it take the version the funded attempt's clean round binds its receipt and acceptance
  // to while the decision is still due: past that no round, decision, receipt or acceptance is
  // admissible. Once accepted, or with no decision due, a re-plan is a successor again.
  if (ledger.rounds.at(-1)?.routing.route === "ACCEPT" && ledger.accepted === undefined
    && reviewDecisionRequired(ledger)) {
    return refuse(request.kind, "REVIEW_ACCEPTANCE_PENDING", "DAEMON_PREREQUISITE");
  }
  // A re-plan is a SUCCESSOR. With no recorded round there is nothing it succeeds, and a delta
  // approval recorded against no rejection would claim a lineage it does not have.
  if (ledger.rounds.length === 0) {
    return refuse(request.kind, "REVIEW_REPLAN_WITHOUT_ROUND", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }

  const classifications: DeltaNodeClassification[] = nodes.map((node) => Object.freeze({
    classification: "INVALIDATED",
    nodeRef: node.nodeRef,
    reasonCodes: UNREADABLE_REASON_CODES,
    sourceHash: "",
    targetHash: "",
  }));

  return commitAccepted(store, request, {
    aggregateId: subjectRef,
    eventPayload: {
      invalidated: classifications
        .filter((entry) => entry.classification === "INVALIDATED")
        .map((entry) => entry.nodeRef),
      successorPlanRef,
    },
    eventType: "ReplanDeltaClassified",
    expectedVersion: ledger.version,
    result: { classifications, successorPlanRef } as unknown as JsonValue,
  });
};
