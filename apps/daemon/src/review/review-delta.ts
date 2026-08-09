import type { JsonObject, JsonValue } from "@moe/contracts";
import { evaluateCarryForward } from "@moe/core";

import { isPlainJsonObject } from "./review-contracts.js";
import type { DeltaNodeClassification } from "./review-contracts.js";
import { commitAccepted, payloadArray, payloadRef, refuse } from "./review-ledger.js";
import type { CommandHandler, ReviewOutcome } from "./review-ledger.js";

/**
 * Delta approval for a re-plan: changed hashes, and every affected node sorted into exactly one
 * of INVALIDATED or CARRY_FORWARD (journey J4, design line 1101).
 *
 * THE CLASSIFICATION IS NOT DECIDED HERE. `@moe/core`'s `evaluateCarryForward` owns design 265's
 * six conditions, and that module's own header states the division of labour verbatim: "Core
 * VALIDATES AND APPLIES a supplied impact set; it never computes one. Design 265 makes the graph
 * diff the daemon's job." So this module supplies the affected nodes and records the verdicts;
 * a local hash comparison here would be a second source of truth and would drift.
 *
 * Totality is the property that matters. Every supplied node lands in exactly one bucket: the
 * verdict is boolean-valued, so no third arm is expressible, and a node named twice is refused
 * rather than classified twice, because one node in two buckets is the unclassified case wearing
 * a disguise.
 */

interface DeltaNodeInput {
  readonly evidence: JsonObject;
  readonly nodeRef: string;
}

function parseNodes(values: readonly JsonValue[]): readonly DeltaNodeInput[] | undefined {
  const parsed: DeltaNodeInput[] = [];
  for (const value of values) {
    if (!isPlainJsonObject(value)) return undefined;
    const evidence = value["evidence"];
    const nodeRef = value["nodeRef"];
    if (!isPlainJsonObject(evidence)) return undefined;
    if (typeof nodeRef !== "string" || nodeRef.length === 0) return undefined;
    parsed.push({ evidence, nodeRef });
  }
  return parsed;
}

function stringOf(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

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
  const supported = payloadArray(request.payload, "supportedCanonicalizerVersions");
  const subjectRef = payloadRef(request.payload, "subjectRef");
  const successorPlanRef = payloadRef(request.payload, "successorPlanRef");
  if (nodeValues === null || supported === null || subjectRef === null
    || successorPlanRef === null) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (nodeValues.length === 0) {
    return refuse(request.kind, "REVIEW_DELTA_NODES_EMPTY", "DAEMON_INGRESS");
  }
  const nodes = parseNodes(nodeValues);
  if (nodes === undefined) {
    return refuse(request.kind, "REVIEW_PAYLOAD_INVALID", "DAEMON_INGRESS");
  }
  if (new Set(nodes.map((node) => node.nodeRef)).size !== nodes.length) {
    return refuse(request.kind, "REVIEW_DELTA_NODE_DUPLICATED", "DAEMON_INGRESS");
  }
  if (ledger.unreadable) {
    return refuse(request.kind, "REVIEW_LINEAGE_UNREADABLE", "DAEMON_PREREQUISITE");
  }
  // A re-plan is a SUCCESSOR. With no recorded round there is nothing it succeeds, and a delta
  // approval recorded against no rejection would claim a lineage it does not have.
  if (ledger.rounds.length === 0) {
    return refuse(request.kind, "REVIEW_REPLAN_WITHOUT_ROUND", "DAEMON_PREREQUISITE");
  }
  if (request.expectedVersion !== ledger.version) {
    return refuse(request.kind, "REVIEW_EXPECTED_VERSION_STALE", "DAEMON_PREREQUISITE");
  }

  const classifications: DeltaNodeClassification[] = [];
  for (const node of nodes) {
    const verdict = evaluateCarryForward(node.evidence, supported);
    if (!verdict.ok) {
      return refuse(request.kind, verdict.error.code, "CORE_POLICY", null, verdict.error);
    }
    classifications.push({
      classification: verdict.value.valid ? "CARRY_FORWARD" : "INVALIDATED",
      nodeRef: node.nodeRef,
      reasonCodes: verdict.value.reasonCodes,
      sourceHash: stringOf(node.evidence["sourceHash"]),
      targetHash: stringOf(node.evidence["targetHash"]),
    });
  }

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
