/**
 * The THREE preparation-consumption legs of a replacement supersession (task-9e52f850).
 *
 * A preparation is three aggregates — the preparation record, the funding reservation and the
 * planning fence — and the supersession that activates against it must retire all three inside the
 * SAME decision that moves the graph. Leaving a HELD hold or an ACTIVE fence behind a committed
 * supersession would let a second supersession be prepared against a world that no longer exists,
 * and would let `releasePreparation` refund a hold that was already spent.
 *
 * CONSUMPTION IS NOT RELEASE. `consumeGeneration` keeps `refunded` at 0 and both members land on
 * the CONSUMED terminal, so the durable record says the authority was spent rather than handed
 * back. `foldPreparationHistory` treats both terminals alike for currency, which is what makes a
 * post-consumption release answer `SUPERSESSION_RELEASE_GENERATION_ABSENT`.
 *
 * SECONDARY LEG VERSIONS COME FROM THE STORE, NEVER FROM THE LEDGER FOLD. `readDurableLedger` folds
 * only `decision.targetAggregateId`, so `versionOf(ledger, fundingId)` would answer 0 forever and
 * every commit past the first would fence against a version that moved long ago.
 */
import type { EventDraft, ExpectedVersionDecisionLeg, SqliteEventStore } from "@moe/store";

import type { SupersessionPreparationGeneration } from "./supersession-preparation-contracts.js";
import {
  PREPARATION_EVENT_TYPES, isGenerationRecord, payloadOf,
} from "./supersession-preparation-history.js";

const encoder = new TextEncoder();

/**
 * Both members to CONSUMED together, the same all-or-nothing shape `releaseGeneration` gives the
 * other terminal. `refunded` stays 0 because a consumed hold was SPENT: refunding it would hand
 * back authority the supersession already used, and a retry finding a refunded-but-consumed hold
 * could spend it twice.
 */
export function consumeGeneration(
  generation: SupersessionPreparationGeneration,
): SupersessionPreparationGeneration {
  return Object.freeze({
    ...generation,
    fence: Object.freeze({ ...generation.fence, lifecycle: "CONSUMED" as const }),
    funding: Object.freeze({ ...generation.funding, lifecycle: "CONSUMED" as const, refunded: 0 }),
  });
}

export interface PreparationConsumptionInput {
  readonly commandId: string;
  readonly fundingAggregateId: string;
  readonly generation: SupersessionPreparationGeneration;
  readonly planningFenceAggregateId: string;
  readonly preparationAggregateId: string;
  /** The fold's version for the preparation aggregate — the fence a stale caller loses on. */
  readonly preparationVersion: number;
  readonly store: SqliteEventStore;
  /** The epoch the SUCCESSOR is activating at, recorded so the horizon stays readable. */
  readonly successorGraphEpoch: number;
}

export interface PreparationConsumption {
  readonly consumed: SupersessionPreparationGeneration;
  readonly legs: readonly ExpectedVersionDecisionLeg[];
}

function draftOf(
  commandId: string, suffix: string, eventType: string, payload: unknown,
): EventDraft {
  return {
    eventId: `${commandId}-${suffix}`, eventType,
    payload: encoder.encode(JSON.stringify(payload)),
  };
}

function legOf(
  store: SqliteEventStore, aggregateId: string, draft: EventDraft,
): ExpectedVersionDecisionLeg {
  return { aggregateId, events: [draft], expectedVersion: store.getAggregateVersion(aggregateId) };
}

/**
 * Build the three legs, in the order the preparation was written. Nothing is committed here; the
 * caller rides them on the same decision as the two revision legs and the goal.
 */
export function buildPreparationConsumptionLegs(
  input: PreparationConsumptionInput,
): PreparationConsumption {
  const consumed = consumeGeneration(input.generation);
  const shared = {
    ...consumed.binding, horizonGraphEpoch: input.successorGraphEpoch,
    supersessionPlanId: consumed.supersessionPlanId,
  };
  return Object.freeze({
    consumed,
    legs: Object.freeze([
      {
        aggregateId: input.preparationAggregateId,
        events: [draftOf(input.commandId, "preparation-consumed",
          PREPARATION_EVENT_TYPES.CONSUMED, { ...shared, record: consumed })],
        expectedVersion: input.preparationVersion,
      },
      legOf(input.store, input.fundingAggregateId,
        draftOf(input.commandId, "funding-consumed", PREPARATION_EVENT_TYPES.FUNDING_CONSUMED,
          { ...shared, ...consumed.funding })),
      legOf(input.store, input.planningFenceAggregateId,
        draftOf(input.commandId, "fence-consumed", PREPARATION_EVENT_TYPES.FENCE_CONSUMED,
          { ...shared, ...consumed.fence })),
    ]),
  });
}

export interface PriorConsumption {
  readonly consumed: SupersessionPreparationGeneration;
  readonly successorGraphEpoch: number;
}

/**
 * The already-consumed record a same-byte replay must be handed back, read off COMMITTED EVENTS
 * rather than recomputed. A replay whose generation left no consumption event on this aggregate is
 * a SPLIT pair, not a replay, and the caller refuses instead of inventing the answer.
 */
export function priorConsumption(
  store: SqliteEventStore, preparationAggregateId: string, generation: number,
): PriorConsumption | null {
  for (const event of store.readEvents(preparationAggregateId)) {
    if (event.eventType !== PREPARATION_EVENT_TYPES.CONSUMED) continue;
    const payload = payloadOf(event);
    const record = payload?.["record"];
    const epoch = payload?.["horizonGraphEpoch"];
    if (payload?.["generation"] === generation && isGenerationRecord(record, generation)
      && Number.isSafeInteger(epoch)) {
      return Object.freeze({ consumed: record, successorGraphEpoch: epoch as number });
    }
  }
  return null;
}
