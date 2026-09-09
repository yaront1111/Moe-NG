/**
 * The DURABLE WRITERS of a supersession preparation (task-32c1ba45).
 *
 * ONE DECISION OR NONE. A preparation is three legs — the preparation record, the HELD funding
 * reservation and the ACTIVE planning fence — riding a single
 * `commitExpectedVersionDecisionLegs`. The store fences all three aggregates inside that one
 * decision, so "the reservation cannot survive without its fence" is a property of the store
 * rather than of a call site. The release is the same shape in the other direction.
 *
 * SECONDARY LEG VERSIONS COME FROM THE STORE, NEVER FROM THE LEDGER FOLD. `readDurableLedger`
 * folds only `decision.targetAggregateId`, so `versionOf(ledger, fundingId)` would answer 0
 * forever and every second commit would fence against a version that moved long ago.
 * `getAggregateVersion` is the only honest source for a secondary leg.
 *
 * AT MOST ONE CURRENT GENERATION IS A WRITE-SIDE INVARIANT. The read-side guard in the service is
 * advisory; what decides an interleaving is the preparation aggregate's expected-version fence,
 * which only one of two proposals built from the same captured state can hold.
 */
import type {
  CommandDecisionRecord, EventDraft, ExpectedVersionDecisionLeg, SqliteEventStore,
} from "@moe/store";

import { commitAcceptedLegs, replayOf } from "../bootstrap/bootstrap-ledger.js";
import type { CommitPlan, HandlerContext, ServiceOutcome } from "../bootstrap/bootstrap-ledger.js";
import { readCurrentActiveGraph } from "./active-graph-projection.js";
import type { ActiveGraphResult } from "./active-graph-projection.js";
import {
  decodeReleaseRequest, fundingAggregateId, planningFenceAggregateId, preparationAggregateId,
  refusePreparation, refuseRelease, releaseGeneration,
} from "./supersession-preparation-contracts.js";
import type {
  SupersessionPreparationGeneration, SupersessionPreparationRefusal,
} from "./supersession-preparation-contracts.js";
import {
  PREPARATION_EVENT_TYPES, foldPreparationHistory, isGenerationRecord, payloadOf,
} from "./supersession-preparation-history.js";
import { proposeSupersessionPreparation } from "./supersession-preparation-service.js";

export {
  PREPARATION_EVENT_TYPES, digestOf, foldPreparationHistory, horizonDigestOf, lineageFactsFor,
} from "./supersession-preparation-history.js";
export type {
  DispositionCoverage, HorizonFacts, PreparationHistory, PreparationHistoryResult,
  PreparationHorizon,
} from "./supersession-preparation-history.js";

const encoder = new TextEncoder();
const LEDGER = "SUPERSESSION_PREPARATION_LEDGER" as const;

function eventDraftOf(
  commandId: string, suffix: string, eventType: string, payload: unknown,
): EventDraft {
  return {
    eventId: `${commandId}-${suffix}`, eventType,
    payload: encoder.encode(JSON.stringify(payload)),
  };
}

/**
 * `getAggregateVersion`, NOT `versionOf(readDurableLedger(...))`: the ledger fold answers only for
 * the decision's PRIMARY target, so a secondary leg read that way fences against 0 forever.
 */
function legOf(
  store: SqliteEventStore, aggregateId: string, draft: EventDraft,
): ExpectedVersionDecisionLeg {
  return { aggregateId, events: [draft], expectedVersion: store.getAggregateVersion(aggregateId) };
}

export interface PreparationLedgerAccepted {
  readonly decision: CommandDecisionRecord;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly generation: SupersessionPreparationGeneration;
  readonly ok: true;
}

export type PreparationLedgerResult = PreparationLedgerAccepted | SupersessionPreparationRefusal;

export type ActivationEvidencePort =
  (store: SqliteEventStore, projectId: string) => ActiveGraphResult;

/** The DEFAULT is the production projection; a test may substitute, production never does. */
export const RELEASE_ACTIVATION_EVIDENCE: ActivationEvidencePort = readCurrentActiveGraph;

/**
 * The landed replay authority, re-faced. `replayOf` owns command-id reuse and byte conflict;
 * neither is restated here, and its own code and layer ride out as the source.
 */
function replayFace(outcome: ServiceOutcome): SupersessionPreparationRefusal {
  if (outcome.ok) throw new Error("replayFace called on an accepted outcome");
  return refusePreparation("SUPERSESSION_PREPARATION_BYTES_CONFLICT", LEDGER,
    { code: outcome.code, layer: outcome.refusedBy });
}

function sharedPayload(
  generation: SupersessionPreparationGeneration, graphEpoch: number,
): Readonly<Record<string, unknown>> {
  return {
    ...generation.binding, horizonGraphEpoch: graphEpoch,
    supersessionPlanId: generation.supersessionPlanId,
  };
}

/**
 * Commit ONE preparation generation: the record, the HELD hold and the ACTIVE fence in a single
 * expected-version decision. Any leg's fence being stale aborts all three, so a concurrent
 * proposal built from the same captured state loses whole rather than half.
 */
export function commitPreparation(context: HandlerContext): PreparationLedgerResult {
  const { request, store } = context;
  const replayed = replayOf(store, request);
  if (replayed !== null && !replayed.ok) return replayFace(replayed);
  // THE ENVELOPE OWNS THE PROJECT. The payload names one too, and the service reads every
  // current fact under the payload's while the legs below are written under the envelope's — so
  // a payload naming a FOREIGN project would read that project's graph, plan and budget and
  // commit a hold and a fence against THIS one. Refused before any read.
  if (request.payload["projectId"] !== request.projectId) {
    return refusePreparation("SUPERSESSION_PREPARATION_TARGET_FOREIGN", LEDGER);
  }
  const goalRef = String(request.payload["goalRef"]);
  const aggregateId = preparationAggregateId(request.projectId, goalRef);
  if (replayed !== null) {
    // The replayed command's OWN generation, read back off its PREPARED event — never
    // `foldPreparationHistory(...).current`, which is whatever is current NOW: after a release
    // and a second preparation an honest replay of the first command answered generation 2, and
    // after a release with nothing prepared it refused PAIR_SPLIT for a decision that had landed.
    const own = priorPreparation(store, aggregateId, request.commandId);
    if (own === null) return refusePreparation("SUPERSESSION_PREPARATION_PAIR_SPLIT", LEDGER);
    return Object.freeze({
      decision: replayed.decision, disposition: "REPLAYED" as const,
      generation: own, ok: true as const,
    });
  }
  const proposal = proposeSupersessionPreparation(store, request.payload);
  if (!proposal.ok) return proposal;
  // NO SECOND FENCE HERE, and the absence is deliberate. A `versionOf(ledger, aggregateId)`
  // cross-check was written, drilled, and DELETED: `context.ledger` is a SNAPSHOT taken when the
  // transport built the context, while the proposal fences against the version it just read from
  // the store. The two diverge whenever anything moved in between — which is exactly the
  // legitimate "prepare, release, prepare again from a still-open context" case — so the check
  // could only ever turn a correctly fenced commit into a false refusal. It was also
  // unfalsifiable: the service's read-side guard and the store's own expected-version fence both
  // answer first, so deleting it left every arm green. The store fence is the authority.
  const { generation } = proposal;
  const shared = sharedPayload(generation, proposal.horizon.graphEpoch);
  const plan: CommitPlan = {
    aggregateId,
    eventPayload: {
      ...shared, coverage: proposal.dispositionCoverage,
      dispositionDigest: generation.dispositionDigest, record: generation,
    } as unknown as CommitPlan["eventPayload"],
    eventType: PREPARATION_EVENT_TYPES.PREPARED,
    expectedVersion: proposal.expectedPreparationVersion,
    result: generation as unknown as CommitPlan["result"],
  };
  const outcome = commitAcceptedLegs(store, request, plan, [
    legOf(store, fundingAggregateId(request.projectId, goalRef),
      eventDraftOf(request.commandId, "funding", PREPARATION_EVENT_TYPES.FUNDING_RESERVED,
        { ...shared, ...generation.funding })),
    legOf(store, planningFenceAggregateId(request.projectId, goalRef),
      eventDraftOf(request.commandId, "fence", PREPARATION_EVENT_TYPES.FENCE_OPENED,
        { ...shared, ...generation.fence })),
  ]);
  if (!outcome.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_GENERATION_CURRENT", LEDGER,
      { code: outcome.code, layer: outcome.refusedBy });
  }
  return Object.freeze({
    decision: outcome.decision, disposition: outcome.disposition, generation, ok: true as const,
  });
}

/** Both members to RELEASED in one decision, or neither moves. */
function commitRelease(
  context: HandlerContext, current: SupersessionPreparationGeneration, version: number,
  graphEpoch: number,
): PreparationLedgerResult {
  const { request, store } = context;
  const released = releaseGeneration(current);
  const goalRef = released.binding.goalRef;
  const shared = sharedPayload(released, graphEpoch);
  const plan: CommitPlan = {
    aggregateId: preparationAggregateId(request.projectId, goalRef),
    eventPayload: { ...shared, record: released } as unknown as CommitPlan["eventPayload"],
    eventType: PREPARATION_EVENT_TYPES.RELEASED,
    expectedVersion: version,
    result: released as unknown as CommitPlan["result"],
  };
  const outcome = commitAcceptedLegs(store, request, plan, [
    legOf(store, fundingAggregateId(request.projectId, goalRef),
      eventDraftOf(request.commandId, "funding-release",
        PREPARATION_EVENT_TYPES.FUNDING_RELEASED, { ...shared, ...released.funding })),
    legOf(store, planningFenceAggregateId(request.projectId, goalRef),
      eventDraftOf(request.commandId, "fence-release",
        PREPARATION_EVENT_TYPES.FENCE_RELEASED, { ...shared, ...released.fence })),
  ]);
  if (!outcome.ok) {
    return refuseRelease("SUPERSESSION_RELEASE_GENERATION_STALE", LEDGER,
      { code: outcome.code, layer: outcome.refusedBy });
  }
  return Object.freeze({
    decision: outcome.decision, disposition: outcome.disposition, generation: released,
    ok: true as const,
  });
}

/**
 * Release the EXACT current generation. A committed activation — any graph epoch beyond the one
 * the preparation captured — forbids the release outright, because activation is what consumes
 * the hold and the fence, and unreadable activation evidence fails closed rather than assuming
 * none was committed.
 */
export function releasePreparation(
  context: HandlerContext,
  activationEvidence: ActivationEvidencePort = RELEASE_ACTIVATION_EVIDENCE,
): PreparationLedgerResult {
  const { request, store } = context;
  const replayed = replayOf(store, request);
  if (replayed !== null && !replayed.ok) return replayFace(replayed);
  const decoded = decodeReleaseRequest(request.payload);
  if (!decoded.ok) return decoded;
  const { request: release } = decoded;
  // Same hole, other direction: the fold would read the payload's project while `commitRelease`
  // writes under the envelope's, so a mismatch could release one project against another's
  // history. The envelope is the authority and the payload must agree with it.
  if (release.projectId !== request.projectId) {
    return refuseRelease("SUPERSESSION_RELEASE_TARGET_FOREIGN", LEDGER);
  }
  const history = foldPreparationHistory(
    store, preparationAggregateId(request.projectId, release.goalRef),
  );
  if (!history.ok) {
    return refusePreparation("SUPERSESSION_PREPARATION_HISTORY_UNVERIFIABLE", LEDGER,
      { code: history.code, layer: history.layer });
  }
  if (replayed !== null) {
    const prior = priorRelease(store, request.projectId, release.goalRef, release.generation);
    if (prior === null) return refuseRelease("SUPERSESSION_RELEASE_PAIR_SPLIT", LEDGER);
    return Object.freeze({
      decision: replayed.decision, disposition: "REPLAYED" as const, generation: prior,
      ok: true as const,
    });
  }
  if (history.current === null || history.currentGraphEpoch === null) {
    return refuseRelease("SUPERSESSION_RELEASE_GENERATION_ABSENT", LEDGER);
  }
  if (history.current.binding.generation !== release.generation
    || history.version !== release.expectedPreparationVersion) {
    return refuseRelease("SUPERSESSION_RELEASE_GENERATION_STALE", LEDGER);
  }
  const evidence = activationEvidence(store, request.projectId);
  if (!evidence.ok) {
    return refuseRelease("SUPERSESSION_RELEASE_ACTIVATION_UNVERIFIABLE", LEDGER,
      { code: evidence.code, layer: evidence.layer });
  }
  if (evidence.graphEpoch !== history.currentGraphEpoch) {
    return refuseRelease("SUPERSESSION_RELEASE_ACTIVATION_COMMITTED", LEDGER);
  }
  return commitRelease(context, history.current, history.version, history.currentGraphEpoch);
}

/** The already-released record an exact replay must be handed back, read off committed events. */
/**
 * The generation a replayed preparation command minted: its own PREPARED event, found by the
 * command id the store traced onto it, trusted only while the record still agrees with the
 * event that carried it. Null when the aggregate holds no such event, which is the PAIR_SPLIT
 * arm: the decision landed but its record is not on the aggregate it named.
 */
function priorPreparation(
  store: SqliteEventStore, aggregateId: string, commandId: string,
): SupersessionPreparationGeneration | null {
  for (const event of store.readEvents(aggregateId)) {
    if (event.eventType !== PREPARATION_EVENT_TYPES.PREPARED) continue;
    if (event.decisionTrace?.commandId !== commandId) continue;
    const payload = payloadOf(event);
    const generation = payload?.["generation"];
    const record = payload?.["record"];
    if (typeof generation === "number" && isGenerationRecord(record, generation)) return record;
  }
  return null;
}

function priorRelease(
  store: SqliteEventStore, projectId: string, goalRef: string, generation: number,
): SupersessionPreparationGeneration | null {
  for (const event of store.readEvents(preparationAggregateId(projectId, goalRef))) {
    if (event.eventType !== PREPARATION_EVENT_TYPES.RELEASED) continue;
    const payload = payloadOf(event);
    const record = payload?.["record"];
    if (payload?.["generation"] === generation && isGenerationRecord(record, generation)) {
      return record;
    }
  }
  return null;
}
