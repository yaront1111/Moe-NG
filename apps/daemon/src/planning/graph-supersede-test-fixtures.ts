/**
 * The world a replacement supersession is decided against, built ENTIRELY by production writers.
 *
 * NOTHING HERE HAND-COMMITS A GRAPH REVISION, A PREPARATION, A FUNDING RESERVATION OR A FENCE.
 * The ACTIVE predecessor comes from `activateApprovedGraph` (task-eacea969), the current
 * preparation generation from `commitPreparation` (task-32c1ba45), and the successor's sealed bytes
 * from the shipped journey producer through `putGraphBody` — the same content-addressed writer
 * `plan.propose`'s body leg uses. A hand-seeded predecessor/successor pair is exactly the
 * mock-backed accepted path epic rail 2 refuses, and it is especially tempting here because seeding
 * two graph revisions and a preparation record is easy and looks convincing.
 */
import type { JsonObject } from "@moe/contracts";
import { applyApprovalCommand, replayGraphRevisionEvents } from "@moe/core";
import type { ApprovalDecisionRecord, GraphActivationBinding } from "@moe/core";
import { decodeGraphContent } from "@moe/scheduler";
import type { GraphRevisionContent } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import type { HandlerContext } from "../bootstrap/bootstrap-ledger.js";
import {
  GOAL_ID, GRAPH_REVISION_REF, PROJECT_ID, approvalCommand, approvalRecord,
} from "../bootstrap/bootstrap-test-fixtures.js";
import { graphRevisionAggregateId, readCurrentActiveGraph } from "./active-graph-projection.js";
import { putGraphBody } from "./graph-body-record.js";
import { activateApprovedGraph } from "./graph-activation-service.js";
import {
  approvableStore, contextFor, decidedApproval, inputFor, requestFor,
} from "./graph-activation-test-fixtures.js";
import { supersedeActiveGraph } from "./graph-supersede-service.js";
import type { GraphSupersedeInput } from "./graph-supersede-service.js";
import { journeyAuthority } from "./journey-authority-bodies.js";
import { readApprovedCriteria } from "./planning-authority-reader.js";
import { preparationAggregateId } from "./supersession-preparation-contracts.js";
import { foldPreparationHistory } from "./supersession-preparation-history.js";
import { commitPreparation } from "./supersession-preparation-ledger.js";

export { PROJECT_ID, GOAL_ID, GRAPH_REVISION_REF } from "../bootstrap/bootstrap-test-fixtures.js";

/** The predecessor is `graph-revision-1`; the successor is a DIFFERENT revision, as it must be. */
export const SUCCESSOR_REVISION_REF = "graph-revision-2";
export const SUCCESSOR_NODE_KEY = "node-b";
export const SUPERSEDE_DECIDED_AT = "2026-08-26T00:10:00.000Z";

/**
 * The successor graph, minted by the SAME production producer the demo seed and the bootstrap
 * fixture use. A different node id is what makes the derived disposition set non-trivial: node-a is
 * REMOVE and node-b is ADD, so the accepted control exercises two kinds rather than an identity.
 */
export function successorContent(nodeKey: string = SUCCESSOR_NODE_KEY): {
  readonly bytes: Uint8Array; readonly graphContentHash: string;
} {
  const authority = journeyAuthority({
    authorRef: "architect-1",
    criterionIds: ["criterion-a", "criterion-b"],
    graphRevisionRef: SUCCESSOR_REVISION_REF,
    idPrefix: "run-2",
    nodeIds: [nodeKey],
    stepDescription: "Land the successor plan.",
  });
  return Object.freeze({
    bytes: new Uint8Array(Buffer.from(authority.graphContentBytesBase64, "base64")),
    graphContentHash: authority.graphContentHash,
  });
}

/** Seal the successor's bytes through the production content-addressed body writer. */
export function sealSuccessorBody(
  store: SqliteEventStore, nodeKey: string = SUCCESSOR_NODE_KEY,
): string {
  const content = successorContent(nodeKey);
  const decoded = decodeGraphContent(content.bytes);
  if (!decoded.ok) throw new Error("fixture successor body did not decode");
  const put = putGraphBody(store, PROJECT_ID, decoded.value);
  if (!put.ok) throw new Error(`fixture successor body refused: ${put.code}`);
  return put.graphContentHash;
}

export const SUCCESSOR_GRAPH_CONTENT_HASH = successorContent().graphContentHash;

function activatedStore(): SqliteEventStore {
  const store = approvableStore();
  const outcome = activateApprovedGraph(
    contextFor(store, requestFor("cmd-activate-1")), inputFor(store),
  );
  if (!outcome.ok) throw new Error(`fixture activation refused: ${outcome.code}`);
  return store;
}

function prepareContext(store: SqliteEventStore, commandId: string): HandlerContext {
  return contextFor(store, requestFor(commandId, {
    approvedTargetRevisionRef: GRAPH_REVISION_REF,
    commandId, correlationId: "corr-prepare", decidedAt: "2026-08-26T00:00:00.000Z",
    goalRef: GOAL_ID, principalId: "principal-1", projectId: PROJECT_ID,
  } as JsonObject));
}

/** ACTIVE predecessor + current preparation generation + sealed successor bytes. */
export function prepareSupersession(store: SqliteEventStore): SqliteEventStore {
  const prepared = commitPreparation(prepareContext(store, "cmd-prepare-1"));
  if (!prepared.ok) throw new Error(`fixture preparation refused: ${prepared.code}`);
  sealSuccessorBody(store);
  return store;
}

export function supersedableStore(): SqliteEventStore {
  return prepareSupersession(activatedStore());
}

/** The same world with the successor bytes NEVER sealed, for the unsealed-content arm. */
export function unsealedSuccessorStore(): SqliteEventStore {
  const store = activatedStore();
  const prepared = commitPreparation(prepareContext(store, "cmd-prepare-1"));
  if (!prepared.ok) throw new Error(`fixture preparation refused: ${prepared.code}`);
  return store;
}

/** A world where the successor's bytes are sealed but NO preparation generation is current. */
export function unpreparedStore(): SqliteEventStore {
  const store = activatedStore();
  sealSuccessorBody(store);
  return store;
}

/**
 * The world AFTER one accepted supersession: `graph-revision-2` is ACTIVE at epoch 2 and
 * `graph-revision-1` is SUPERSEDED with a four-event history.
 *
 * A SECOND PREPARATION IS NOT REACHABLE FROM HERE, and the reason is a measured property of the
 * delivered tree rather than a fixture limitation. Every committed budget-ledger record carries the
 * `graphRevisionRef` and `graphEpoch` it was authorized at, and `budget-current-projection.ts:113`
 * refuses `BUDGET_PROJECTION_STALE_BINDING` when they disagree with the CURRENT binding — which a
 * supersession has just moved. Nothing in this tree re-authorizes a budget root at a new epoch, so
 * `readCurrentBudgetLedger` refuses for the goal and `proposeSupersessionPreparation` answers
 * `SUPERSESSION_PREPARATION_BUDGET_UNAVAILABLE`. The consequence is PINNED by its own arm so the
 * day budget re-authorization lands, the pin goes red instead of the gap staying silent.
 */
export function supersededStore(): SqliteEventStore {
  const store = supersedableStore();
  const outcome = supersedeActiveGraph(supersedeContext(store, "cmd-supersede-1"),
    supersedeInput());
  if (!outcome.ok) throw new Error(`fixture supersession refused: ${outcome.code}`);
  return store;
}

export const THIRD_GRAPH_CONTENT_HASH = successorContent("node-c").graphContentHash;

export interface PreparationFence {
  readonly expectedPreparationVersion: number;
  readonly generation: number;
}

/** The EXACT current generation and version, read back through the production fold. */
export function currentPreparationFence(store: SqliteEventStore): PreparationFence {
  const history = foldPreparationHistory(store, preparationAggregateId(PROJECT_ID, GOAL_ID));
  if (!history.ok || history.current === null) throw new Error("fixture has no current generation");
  return Object.freeze({
    expectedPreparationVersion: history.version,
    generation: history.current.binding.generation,
  });
}

export function supersedeRequest(
  store: SqliteEventStore, overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const fence = currentPreparationFence(store);
  return {
    commandId: "cmd-supersede-1",
    correlationId: "corr-supersede",
    decidedAt: SUPERSEDE_DECIDED_AT,
    expectedPredecessorRevisionRef: GRAPH_REVISION_REF,
    expectedPreparationVersion: fence.expectedPreparationVersion,
    generation: fence.generation,
    goalRef: GOAL_ID,
    principalId: "principal-1",
    projectId: PROJECT_ID,
    successorGraphContentHash: SUCCESSOR_GRAPH_CONTENT_HASH,
    successorRevisionRef: SUCCESSOR_REVISION_REF,
    ...overrides,
  };
}

/** The transport's own envelope. Its payload IS the supersede request, so replay is byte-exact. */
export function supersedeContext(
  store: SqliteEventStore, commandId: string, payload?: Record<string, unknown>,
): HandlerContext {
  return contextFor(store, requestFor(
    commandId, (payload ?? supersedeRequest(store, { commandId })) as JsonObject,
  ));
}

const revisionDecoder = new TextDecoder("utf-8", { fatal: false });

/** The predecessor's durable revision history, decoded exactly as the production legs read it. */
function revisionHistory(store: SqliteEventStore, aggregateId: string): readonly unknown[] {
  return store.readEvents(aggregateId).map((event) => {
    try {
      return JSON.parse(revisionDecoder.decode(event.payload)) as unknown;
    } catch {
      return null;
    }
  });
}

/**
 * The binding the ACTIVE predecessor was activated under, replayed from ITS OWN history.
 *
 * Which revision is active is a fact of the store, not of this module: the two-goal world activates
 * a different one from the canonical world, and that is exactly the divergence a shared record
 * cannot express. A null binding throws here rather than yielding `undefined` fields, which would
 * surface downstream as a mismatch that reads like a production bug.
 */
function predecessorBinding(store: SqliteEventStore): GraphActivationBinding {
  const active = readCurrentActiveGraph(store, PROJECT_ID);
  if (!active.ok) throw new Error(`fixture has no active predecessor: ${active.code}`);
  const replayed = replayGraphRevisionEvents(
    revisionHistory(store, graphRevisionAggregateId(PROJECT_ID, active.revisionId)),
  );
  if (!replayed.ok) throw new Error("fixture predecessor revision history did not replay");
  if (replayed.state.boundHashes === null) {
    throw new Error("fixture predecessor revision carries no bound hashes");
  }
  return replayed.state.boundHashes;
}

function decodedSuccessor(nodeKey: string): GraphRevisionContent {
  const decoded = decodeGraphContent(successorContent(nodeKey).bytes);
  if (!decoded.ok) throw new Error("fixture successor content did not decode");
  return decoded.value.content;
}

/**
 * A DECIDED approval bound to the successor and predecessor THIS store actually holds.
 *
 * `decidedApproval()` is one immutable record shared by every caller: its `exactRevisionHash` is
 * the PREDECESSOR's sealed submission hash and its budget, criteria, quality and policy refs are
 * the `hex64` placeholders `approvalRecord` spells. None of those is a constant of the system --
 * the canonical, two-goal, file-backed and node-a worlds each bind different ones. Every field
 * below is therefore READ BACK out of the caller's own store through the production reader that
 * yields it, so an arm that built a different world necessarily gets a different record.
 *
 * Built through `approvalRecord` + `applyApprovalCommand`, the same core path `decidedApproval()`
 * uses, so this is a genuinely decided record rather than a hand-assembled object.
 */
export function successorBoundApproval(
  store: SqliteEventStore, nodeKey: string = SUCCESSOR_NODE_KEY,
): ApprovalDecisionRecord {
  const binding = predecessorBinding(store);
  const criteria = readApprovedCriteria(store, PROJECT_ID, GOAL_ID);
  if (!criteria.ok) throw new Error(`fixture approved criteria unreadable: ${criteria.code}`);
  const verdict = applyApprovalCommand({
    ...approvalRecord(successorContent(nodeKey).graphContentHash),
    applicablePolicyRef: binding.policyHash,
    approvedNodeScope: decodedSuccessor(nodeKey).nodeAuthority.authorities
      .map((authority) => authority.nodeKey),
    budgetRef: binding.budgetHash,
    criteriaRef: criteria.criteriaDigest,
    planQualityAssessmentRef: binding.qualityHash,
    // task-9fb4e53d51db4c7f9009275445706723 will replace absence with a durable digest.
    policyDecisionRef: null,
  }, approvalCommand());
  if (!verdict.ok) throw new Error(`fixture approval refused: ${verdict.error.code}`);
  return verdict.value;
}

/**
 * The core's DECIDED approval record, never a payload copy.
 *
 * The override is OPTIONAL and defaults to today's shared record: the thirty-one call sites in
 * `graph-supersede-refusals.test.ts` and `graph-supersede-service.test.ts` keep their zero-arg
 * shape. Arms whose world diverges from the canonical one pass `successorBoundApproval(store)`.
 */
export function supersedeInput(
  overrides: Partial<GraphSupersedeInput> = {},
): GraphSupersedeInput {
  return { approval: decidedApproval(), ...overrides };
}
