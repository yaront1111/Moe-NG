import type { CommandDecisionRecord, SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "./bootstrap/bootstrap-ledger.js";
import type { HumanReviewWitness } from "./bootstrap/bootstrap-ledger.js";
import { unavailableExpansionReleaseAuthority } from "./planning/expansion-request-service.js";
import { handleExpansionRequest } from "./planning/expansion-request-service.js";
import type { ExpansionReleaseAuthorityReader } from "./planning/expansion-request-service.js";
import { supersedeActiveGraph } from "./planning/graph-supersede-service.js";
import { commitPreparation, releasePreparation }
  from "./planning/supersession-preparation-ledger.js";
import type { DurableDecision } from "./http/http-contract.js";
import { DomainRefusal, decisionOf } from "./daemon-command-dispatch.js";
import { runGraphApproveEdge } from "./daemon-command-graph-approve.js";
import {
  assembleGraphRequest, graphHandlerContext, replayStableDecidedAt,
} from "./daemon-command-graph-contracts.js";
import type { GraphEnvelope, GraphRequestFacts } from "./daemon-command-graph-contracts.js";
import { GRAPH_APPROVAL_INTENT_KEYS, decideGraphSupersedeApproval }
  from "./daemon-command-graph-supersede.js";

/**
 * The five graph MUTATION kinds, each assembled at its own edge and handed to ITS OWN durable
 * planning service (task-931f99e8).
 *
 *   graph.approve               -> `activateApprovedGraph`        (task-eacea969)
 *   graph.prepare_supersession  -> `commitPreparation`            (task-32c1ba45)
 *   graph.release_preparation   -> `releasePreparation`           (task-32c1ba45)
 *   graph.request_expansion     -> `handleExpansionRequest`       (task-738a12a8)
 *   graph.supersede             -> `supersedeActiveGraph`         (task-9e52f850)
 *
 * NO RESTAMPING. Every refusal leaves here carrying the answering service's OWN code and its own
 * layer, plus the name of the service that refused and — where one service wrapped another — the
 * wrapped surface's code and layer verbatim. A caller can always tell which layer spoke. Nothing
 * in this module reduces, folds, projects, synthesises current state, reserves or activates.
 *
 * THE REGISTRY'S AUTHENTICATOR HAS ALREADY RUN. The seam's stages are AUTHENTICATE, REGISTRY,
 * AUTHORIZE, PAYLOAD_SHAPE, DISPATCH in that order, so nothing here can be reached by an
 * unauthenticated caller or by one lacking the capability — and no graph payload member is read
 * until all four earlier stages have passed.
 */

export interface GraphEdgeContext {
  readonly clock: () => string;
  readonly envelope: GraphEnvelope;
  /** Server-assembled operator evidence, present only when the principal IS the operator. */
  readonly humanReview: HumanReviewWitness | undefined;
  readonly kind: GraphRequestFacts["kind"];
  readonly principalId: string;
  readonly projectId: string;
  /** Injected so a test may substitute; production leaves it at the fail-closed default. */
  readonly releaseAuthority?: ExpansionReleaseAuthorityReader;
  readonly store: SqliteEventStore;
}

/** The refusal face every graph service shares once its own vocabulary is read. */
interface GraphRefusal {
  readonly code: string;
  readonly layer: string;
  readonly refusedBy: string;
  readonly sourceCode: string | null;
  readonly sourceLayer: string | null;
}

/**
 * A refusal, carried out on the transport error UNRESTAMPED. `detail` names the refusing service
 * and, when one service wrapped another, the wrapped code and layer exactly as they arrived —
 * so "which layer spoke" survives the trip to the HTTP seam, which has only four fields.
 */
function refuseGraph(refusal: GraphRefusal): never {
  const source = refusal.sourceCode === null && refusal.sourceLayer === null
    ? ""
    : ` (${refusal.sourceCode ?? "-"}/${refusal.sourceLayer ?? "-"})`;
  throw new DomainRefusal(refusal.code, refusal.layer, `${refusal.refusedBy}${source}`);
}

/** The service's OWN decision record, re-faced for the seam. No field is minted here. */
function decisionRecordOf(
  record: CommandDecisionRecord, disposition: "DECIDED" | "REPLAYED",
): DurableDecision {
  return Object.freeze({
    commandId: record.key.commandId, disposition,
    effectId: record.decisionId, resultCode: record.resultCode,
  });
}

/**
 * The committed decision, read back from the store by the identity it was committed under.
 *
 * `handleExpansionRequest` returns its business facts rather than the decision record, so the
 * record is READ rather than reconstructed — a transport-minted `resultCode` would be exactly
 * the restamping DoD 1 forbids. An accepted service whose decision cannot be read back is a
 * split pair and refuses.
 */
function committedDecisionOf(
  store: SqliteEventStore, facts: GraphRequestFacts, disposition: "DECIDED" | "REPLAYED",
): DurableDecision {
  const record = store.getCommandDecision({
    commandId: facts.envelope.commandId,
    principalId: facts.principalId,
    projectId: facts.projectId,
  });
  if (record === null) {
    refuseGraph({
      code: "GRAPH_INGRESS_DECISION_UNREADABLE", layer: "DAEMON_INGRESS",
      refusedBy: "DAEMON_GRAPH_INGRESS", sourceCode: null, sourceLayer: null,
    });
  }
  return decisionRecordOf(record, disposition);
}

/** `graph.request_expansion` — the ONLY kind whose service takes an envelope, not a context. */
function runExpansionRequestEdge(
  context: GraphEdgeContext, facts: GraphRequestFacts, decidedAt: string,
): DurableDecision {
  const outcome = handleExpansionRequest({
    envelope: {
      commandId: facts.envelope.commandId,
      correlationId: facts.envelope.correlationId,
      decidedAt,
      payload: facts.envelope.payload,
      principalId: facts.principalId,
      projectId: facts.projectId,
    },
    releaseAuthority: context.releaseAuthority ?? unavailableExpansionReleaseAuthority,
    store: context.store,
  });
  if (!outcome.ok) {
    refuseGraph({
      code: outcome.code, layer: outcome.layer, refusedBy: "EXPANSION_REQUEST_SERVICE",
      sourceCode: outcome.sourceCode, sourceLayer: outcome.sourceLayer,
    });
  }
  return committedDecisionOf(context.store, facts, outcome.disposition);
}

/** One edge for the four context-shaped kinds; `graph.request_expansion` is handled above. */
function runContextEdge(
  context: GraphEdgeContext, facts: GraphRequestFacts, decidedAt: string,
): DurableDecision {
  const { store } = context;
  const request = assembleGraphRequest(
    facts, decidedAt,
    facts.kind === "graph.supersede" ? GRAPH_APPROVAL_INTENT_KEYS : [],
  );
  const ledger = readDurableLedger(store, facts.projectId);
  if (facts.kind === "graph.approve") {
    return decisionOf(runGraphApproveEdge({
      humanReview: context.humanReview, ledger, request, store,
    }));
  }
  const handlerContext = graphHandlerContext(store, ledger, request);
  if (facts.kind === "graph.supersede") {
    const approval = decideGraphSupersedeApproval(facts);
    if (!approval.ok) refuseGraph(approval.refusal);
    const answer = supersedeActiveGraph(handlerContext, { approval: approval.approval });
    if (!answer.ok) {
      refuseGraph({
        code: answer.code, layer: answer.layer, refusedBy: answer.refusedBy,
        sourceCode: answer.sourceCode, sourceLayer: answer.sourceLayer,
      });
    }
    return decisionRecordOf(answer.decision, answer.disposition);
  }
  const answer = facts.kind === "graph.prepare_supersession"
    ? commitPreparation(handlerContext)
    : releasePreparation(handlerContext);
  if (!answer.ok) {
    refuseGraph({
      code: answer.code, layer: answer.layer, refusedBy: answer.refusedBy,
      sourceCode: answer.sourceCode, sourceLayer: answer.sourceLayer,
    });
  }
  return decisionRecordOf(answer.decision, answer.disposition);
}

/** The graph dispatch the registry entry calls once every earlier seam stage has passed. */
export function runGraphEdge(context: GraphEdgeContext): DurableDecision {
  const facts: GraphRequestFacts = {
    envelope: context.envelope,
    kind: context.kind,
    principalId: context.principalId,
    projectId: context.projectId,
  };
  const decidedAt = replayStableDecidedAt(context.store, facts, context.clock);
  return facts.kind === "graph.request_expansion"
    ? runExpansionRequestEdge(context, facts, decidedAt)
    : runContextEdge(context, facts, decidedAt);
}
