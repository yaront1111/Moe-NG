/**
 * The authenticated `graph.request_expansion` service: decode, read current authority, read safe
 * release, run the real reducers, and commit the ACTIVE hold with its bound EXPANSION PlanningRun
 * in one durable decision.
 *
 * WHAT THE CALLER CONTROLS. A rationale and three subject refs. Nothing else. The project and the
 * principal arrive in the SERVER envelope, outside the payload; the goal's version, generation
 * and graph epoch, the active revision, the hold id, the planning-run ref, the deadline, both
 * fingerprints, the release evidence and the worker handoff are all derived here from durable or
 * server facts. A payload carrying any of them is refused by arity before this module runs.
 *
 * WHY THE RELEASE READER IS A NAMED PORT. The production graph edge composes the store-bound
 * durable selector from `expansion-release-selector.ts`; this service consumes only its narrow
 * port and forwards its exact code/layer without restamping. Tests may inject a reader to isolate
 * admission mechanics. The exported unavailable reader remains a deliberate negative-control
 * fixture; production never selects it as a fallback.
 *
 * WHAT IT NEVER MINTS. No admission, preparation, approval, child, lease, effect, resource,
 * budget or graph activation. It stops at one ACTIVE hold and one DRAFT EXPANSION run.
 *
 * NOT REGISTERED HERE. `graph.request_expansion` is absent from the daemon command registry on
 * purpose: `buildCommandRegistry` throws on a duplicate kind — a daemon BOOT crash — and
 * task-931f99e8 owns exactly-once transport registration.
 */

import {
  reduceExpansionPlanningHold, reducePlanningRun, snapshotPlanningRunContractState,
} from "@moe/core";
import type {
  ExpansionHandoffBinding,
  ExpansionReleaseEvidence,
  PlanningCreateDraftCommand,
} from "@moe/core";
import { bindCurrentExpansionHold } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readDurableLedger } from "../bootstrap/bootstrap-ledger.js";
import { commitExpansionRequest } from "./expansion-request-commit.js";
import {
  decodeExpansionRequestEnvelope,
  decodeExpansionRequestPayload,
  expansionRequestRefusal,
  isExpansionRequestRefusal,
} from "./expansion-request-contracts.js";
import type { ExpansionRequestRefusal } from "./expansion-request-contracts.js";
import { readExpansionRequestAuthority } from "./expansion-request-current-authority.js";
import { holdCommandOf, requestBytesOf } from "./expansion-request-derivation.js";
import { expansionHoldAggregateId } from "./expansion-request-records.js";

export interface ExpansionReleaseAuthorityRequest {
  readonly goalRef: string;
  readonly parentNodeRef: string;
  readonly parentRunRef: string;
  readonly projectId: string;
}

export type ExpansionReleaseAuthorityAnswer =
  | {
    readonly ok: true;
    readonly release: ExpansionReleaseEvidence;
    readonly workerHandoff: ExpansionHandoffBinding;
  }
  | { readonly code: string; readonly layer: string; readonly ok: false };

export type ExpansionReleaseAuthorityReader =
  (request: ExpansionReleaseAuthorityRequest) => ExpansionReleaseAuthorityAnswer;

/** Explicit refusing fixture for negative controls; production composes the durable selector. */
export const unavailableExpansionReleaseAuthority: ExpansionReleaseAuthorityReader = () =>
  Object.freeze({
    code: "EXPANSION_RELEASE_AUTHORITY_ABSENT",
    layer: "RELEASE_AUTHORITY",
    ok: false as const,
  });

export interface ExpansionRequestContext {
  /** The SERVER-assembled envelope; the principal and project live here, not in the payload. */
  readonly envelope: unknown;
  readonly releaseAuthority: ExpansionReleaseAuthorityReader;
  readonly store: SqliteEventStore;
}

export interface ExpansionRequestAccepted {
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly generation: number;
  readonly graphEpoch: number;
  readonly holdId: string;
  readonly holdVersion: number;
  readonly ok: true;
  readonly planningRunRef: string;
}

export type ExpansionRequestOutcome = ExpansionRequestAccepted | ExpansionRequestRefusal;

/**
 * One authenticated expansion request. Every refusal carries this slice's own code plus the
 * answering surface's code and layer verbatim, so a caller can always tell which layer spoke.
 */
export function handleExpansionRequest(context: ExpansionRequestContext): ExpansionRequestOutcome {
  const decoded = decodeExpansionRequestEnvelope(context.envelope);
  if (!decoded.ok) return decoded;
  const { envelope } = decoded;
  const payloadResult = decodeExpansionRequestPayload(envelope.payload);
  if (!payloadResult.ok) return payloadResult;
  const payload = payloadResult.payload;

  const authorityResult = readExpansionRequestAuthority({
    ledger: readDurableLedger(context.store, envelope.projectId),
    payload,
    projectId: envelope.projectId,
    store: context.store,
  });
  if (!authorityResult.ok) return authorityResult;
  const authority = authorityResult.authority;

  const release = context.releaseAuthority({
    goalRef: authority.goalRef,
    parentNodeRef: authority.parentNodeRef,
    parentRunRef: authority.parentRunRef,
    projectId: authority.projectId,
  });
  if (!release.ok) {
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_RELEASE_AUTHORITY_UNAVAILABLE", release.code, release.layer,
    );
  }

  const command = holdCommandOf(
    authority, payload, release, envelope.commandId, envelope.decidedAt,
  );
  if (command === null) return expansionRequestRefusal("EXPANSION_REQUEST_ENVELOPE_MALFORMED");
  const hold = reduceExpansionPlanningHold(undefined, command);
  if (!hold.ok) {
    return expansionRequestRefusal("EXPANSION_REQUEST_HOLD_REFUSED", hold.code, hold.layer);
  }

  const bound = bindCurrentExpansionHold({
    currentAuthority: {
      goalVersion: authority.goalVersion,
      graphEpoch: authority.graphEpoch,
      holdId: hold.state.holdId,
      holdVersion: hold.state.version,
      planningRunRef: hold.state.planningRunRef,
    },
    hold: hold.state,
  });
  if (!bound.ok) {
    const issue = bound.issues[0];
    return expansionRequestRefusal(
      "EXPANSION_REQUEST_BINDING_REFUSED", issue?.code ?? null, issue?.layer ?? null,
    );
  }

  const draft: PlanningCreateDraftCommand = {
    commandId: envelope.commandId,
    expansion: bound.binding,
    expectedVersion: 0,
    goalRef: authority.goalRef,
    kind: "planning.create_draft",
    runId: hold.state.planningRunRef,
    runKind: "EXPANSION",
  };
  const run = reducePlanningRun(undefined, draft);
  // Narrowed by core's own contract snapshot, never by a local cast: a run that is not a
  // representable EXPANSION contract state must not reach the ledger at all.
  const runState = run.ok ? snapshotPlanningRunContractState(run.state) : undefined;
  if (runState === undefined || runState.runKind !== "EXPANSION") {
    return expansionRequestRefusal("EXPANSION_REQUEST_RUN_REFUSED");
  }

  const committed = commitExpansionRequest(context.store, {
    envelope,
    goalRef: authority.goalRef,
    goalVersion: authority.goalVersion,
    hold: hold.state,
    holdAggregateId: expansionHoldAggregateId(envelope.projectId, hold.state.holdId),
    requestBytes: requestBytesOf(payload),
    run: { command: draft, state: runState },
  });
  if (isExpansionRequestRefusal(committed)) return committed;
  return Object.freeze({
    disposition: committed.disposition,
    generation: hold.state.generation,
    graphEpoch: hold.state.graphEpoch,
    holdId: hold.state.holdId,
    holdVersion: hold.state.version,
    ok: true as const,
    planningRunRef: hold.state.planningRunRef,
  });
}
