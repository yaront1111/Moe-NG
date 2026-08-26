/**
 * The DAEMON-CURRENT authority bindings one expansion admission is decided against: the ACTIVE
 * `ExpansionPlanningHoldState`, the sealed EXPANSION `PlanningRun` bound to it, and the five
 * current values the scheduler's binder compares them to.
 *
 * A CALLER CANNOT SELECT OR REPLACE ANY OF THEM. The only caller values that reach this module
 * are the three SUBJECT refs — which goal, which parent node, which parent planning run — and
 * they identify a subject, never a binding. The goal's version, generation and graph epoch come
 * from `readExpansionRequestAuthority` over durable bytes; the hold id and the planning-run ref
 * are `identitiesOf`'s digest of that same current world; the hold version is read from the
 * store. There is no parameter through which a stale or foreign hold could be named, so the
 * DoD-0 property is a fact about the SIGNATURE rather than a check this module could forget.
 *
 * WHY THE VERSION IS READ AND THEN RE-READ. The observed version is taken from the hold
 * aggregate here and handed to `readCurrentExpansionRequest`, which reads the ledger again and
 * compares. That is not a redundant check: a concurrent writer moving the hold between the two
 * reads makes the second one disagree, and the pair refuses `EXPANSION_REQUEST_LEDGER_STALE`
 * instead of admitting against a world that has already moved. It is a narrow fence, and it is
 * named as narrow rather than sold as a general one.
 *
 * NOTHING HERE IS REIMPLEMENTED. The current-authority read, the identity derivation and the
 * strict hold/run relation reader are the landed production surfaces of
 * task-738a12a816e8421a96edd84648565a38; this module orders them and forwards their refusals
 * verbatim. It writes nothing and mints no authority.
 */

import type { ExpansionPlanningHoldState, PlanningRunContractState } from "@moe/core";
import type { ExpansionCurrentAuthority } from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import {
  expansionAdmissionRefusal, upstreamFace,
} from "./expansion-admission-contracts.js";
import type {
  ExpansionAdmissionPayload, ExpansionAdmissionRefusal,
} from "./expansion-admission-contracts.js";
import type { ExpansionRequestRefusal } from "./expansion-request-contracts.js";
import { readExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import type { ExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import { identitiesOf } from "./expansion-request-derivation.js";
import { readCurrentExpansionRequest } from "./expansion-request-ledger.js";
import {
  EXPANSION_HOLD_EVENT_TYPE,
  decodeExpansionHoldRecord,
  expansionHoldAggregateId,
} from "./expansion-request-records.js";

export interface ExpansionAdmissionBindings {
  readonly authority: ExpansionRequestAuthority;
  /** The five daemon-current values the scheduler binder compares the hold against. */
  readonly currentAuthority: ExpansionCurrentAuthority;
  readonly hold: ExpansionPlanningHoldState;
  readonly holdAggregateId: string;
  readonly run: PlanningRunContractState;
}

export type ExpansionAdmissionBindingsResult =
  | { readonly bindings: ExpansionAdmissionBindings; readonly ok: true }
  | ExpansionAdmissionRefusal;

/**
 * Both delegated refusals keep their OWN code and layer; the doubly-delegated pair the request
 * slice carries travels in `origin`/`target`, so nothing is rewritten and nothing is dropped.
 */
function forward(
  code: "EXPANSION_ADMISSION_AUTHORITY_UNAVAILABLE" | "EXPANSION_ADMISSION_HOLD_UNAVAILABLE",
  refusal: ExpansionRequestRefusal,
): ExpansionAdmissionRefusal {
  return expansionAdmissionRefusal(code, upstreamFace(refusal.code, refusal.layer, {
    component: "EXPANSION_REQUEST",
    origin: refusal.sourceLayer,
    target: refusal.sourceCode,
  }));
}

function lastHoldEvent(
  store: SqliteEventStore, aggregateId: string,
): StoredEvent | undefined {
  return store.readEvents(aggregateId)
    .filter((event) => event.eventType === EXPANSION_HOLD_EVENT_TYPE).at(-1);
}

/**
 * The observed hold version, or a refusal naming exactly why there is none. An absent aggregate
 * and an unreadable record are DIFFERENT worlds and get the request slice's own two codes rather
 * than one shared "unavailable": collapsing them is how a corrupt record hides behind a missing
 * one.
 */
function observedVersion(
  store: SqliteEventStore, aggregateId: string,
): number | ExpansionAdmissionRefusal {
  const event = lastHoldEvent(store, aggregateId);
  if (event === undefined) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_HOLD_UNAVAILABLE",
      upstreamFace("EXPANSION_REQUEST_LEDGER_ABSENT", "LEDGER",
        { component: "EXPANSION_REQUEST", target: aggregateId }));
  }
  const hold = decodeExpansionHoldRecord(event.payload);
  if (hold === null) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_HOLD_UNAVAILABLE",
      upstreamFace("EXPANSION_REQUEST_LEDGER_MALFORMED", "LEDGER",
        { component: "EXPANSION_REQUEST", target: aggregateId }));
  }
  return hold.version;
}

function isRefusal(value: unknown): value is ExpansionAdmissionRefusal {
  return typeof value === "object" && value !== null && "ok" in value
    && (value as { readonly ok: unknown }).ok === false;
}

/**
 * Resolves the ONE current hold/run pair an expansion admission may be decided against, or the
 * exact reason there is none. Read-only: it opens nothing, repairs nothing and returns no
 * partial binding — an unresolvable world yields a refusal carrying no hold, run or version.
 */
export function readExpansionAdmissionBindings(
  store: SqliteEventStore,
  projectId: string,
  payload: ExpansionAdmissionPayload,
): ExpansionAdmissionBindingsResult {
  const authorityResult = readExpansionRequestAuthority({
    ledger: readDurableLedger(store, projectId),
    payload: {
      // The rationale is a hold-CREATION fact that admission never reads. It used to be passed
      // as a placeholder; task-671cdd10 narrowed the authority input to exactly these three
      // refs, so the placeholder is now unrepresentable rather than merely unread.
      goalRef: payload.goalRef,
      parentNodeRef: payload.parentNodeRef,
      parentRunRef: payload.parentRunRef,
    },
    projectId,
    store,
  });
  if (!authorityResult.ok) {
    return forward("EXPANSION_ADMISSION_AUTHORITY_UNAVAILABLE", authorityResult);
  }
  const authority = authorityResult.authority;
  const { holdId, planningRunRef } = identitiesOf(authority);
  const holdAggregateId = expansionHoldAggregateId(projectId, holdId);
  const version = observedVersion(store, holdAggregateId);
  if (isRefusal(version)) return version;

  const pair = readCurrentExpansionRequest(store, {
    generation: authority.generation,
    goalRef: authority.goalRef,
    graphEpoch: authority.graphEpoch,
    holdVersion: version,
    parentNodeRef: authority.parentNodeRef,
    parentRunRef: authority.parentRunRef,
    planningRunRef,
    projectId,
  });
  if (!pair.ok) return forward("EXPANSION_ADMISSION_HOLD_UNAVAILABLE", pair);

  return Object.freeze({
    bindings: Object.freeze({
      authority,
      currentAuthority: Object.freeze({
        goalVersion: authority.goalVersion,
        graphEpoch: authority.graphEpoch,
        holdId: pair.pair.hold.holdId,
        holdVersion: pair.pair.hold.version,
        planningRunRef: pair.pair.hold.planningRunRef,
      }),
      hold: pair.pair.hold,
      holdAggregateId: pair.pair.holdAggregateId,
      run: pair.pair.run,
    }),
    ok: true as const,
  });
}
