/**
 * THE PRODUCTION DAEMON CALL SITE for the expansion admission protocol. It composes the
 * daemon-current durable expansion hold and its sealed EXPANSION `PlanningRun` with scheduler
 * `admitExpansion`, the scheduler-to-core bridge `bindExpansionAdmission`, core
 * `prepareExpansion` and core `approveExpansionManually`, and durably records ONE approved
 * expansion binding.
 *
 * This is the real consumer edge task-005c9896f9724ece80b27f44789d0435 requires: the three
 * kernels are called HERE, from a non-test production module, not merely re-exported. An
 * unwired composition passes a symbol grep identically to a wired one, which is why the suite
 * asserts the call sites from this seam rather than from an export list.
 *
 * A CALLER CANNOT SELECT OR REPLACE A DAEMON-CURRENT AUTHORITY BINDING. Three subject refs name
 * WHICH goal, parent node and parent run; `readExpansionAdmissionBindings` resolves the hold,
 * the run and the five current values from durable bytes. There is no parameter for a hold id,
 * a hold version, a generation, a graph epoch, a goal version or a planning-run ref, so the
 * property holds by SIGNATURE. The proposal, policy, supersession, fairness and approval bytes
 * ARE the caller's — they are decision EVIDENCE, and every one of them is validated hostilely by
 * the kernel that owns it before it can reach an accepted result.
 *
 * REFUSAL PRECEDENCE, AND WHY IT IS ORDERED THIS WAY. Envelope, payload, current authority,
 * durable ledger, scheduler admission, scheduler bridge, this slice's contract check, core
 * preparation, core approval, durable record. The order runs cheapest-and-most-fundamental
 * first, and the FIRST refusal short-circuits, so a request that is wrong in two places reports
 * only the earlier one. Each refusal carries its own surface's exact code and layer VERBATIM in
 * `upstream`, beside this slice's own code and layer; nothing is ever restamped, because the
 * difference between "the hold was stale" and "the approval was refused" is the whole
 * diagnostic value of the roster. No refusal commits a business event or any authority.
 *
 * THE LATE REFUSAL. Exactly one ordering inside `admitExpansion` can strand a hold: a resource
 * refusal arriving AFTER budget was reserved. The kernel cancels the reservation itself and
 * returns the restored meters as evidence; this module forwards that `unwind` VERBATIM and
 * commits nothing, so the refusal proves the give-back rather than asserting it.
 *
 * WHAT IT NEVER MINTS. No child run, lease, effect, resource, provider slot, graph mutation or
 * activation authority. The slice ENDS at a durable approved binding; atomic child activation
 * is a separate graph-composition capability.
 */

import { approveExpansionManually, prepareExpansion } from "@moe/core";
import type { ExpansionPreparation } from "@moe/core";
import { admitExpansion, bindExpansionAdmission } from "@moe/scheduler";
import type { ExpansionAdmissionBinding, ExpansionBoundFacts } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import { readExpansionAdmissionBindings } from "./expansion-admission-bindings.js";
import type { ExpansionAdmissionBindings } from "./expansion-admission-bindings.js";
import {
  decodeExpansionAdmissionEnvelope, decodeExpansionAdmissionPayload,
  expansionAdmissionRefusal, isExpansionAdmissionRefusal,
} from "./expansion-admission-contracts.js";
import {
  contractMismatch, fromAdmission, fromApproval, fromBridge, fromPreparation,
  fundingUnderivable,
} from "./expansion-admission-forwarding.js";
import type {
  ExpansionAdmissionEnvelope, ExpansionAdmissionPayload, ExpansionAdmissionRefusal,
} from "./expansion-admission-contracts.js";
import {
  EXPANSION_ADMISSION_GRAPH_LIFECYCLE, approvalClaimOf, fenceFactsOf, fundingFactsOf,
  holdMatchesCurrentGraph, namesCurrentPredecessor, predecessorOf,
} from "./expansion-admission-projection.js";
import { commitExpansionApproval } from "./expansion-admission-records.js";
import type { ExpansionApprovalRecord } from "./expansion-admission-records.js";

export interface ExpansionAdmissionContext {
  /** The SERVER-assembled envelope; the principal and project live here, not in the payload. */
  readonly envelope: unknown;
  readonly store: SqliteEventStore;
}

export interface ExpansionAdmissionAccepted {
  readonly approvalIdentity: string;
  readonly disposition: "DECIDED" | "REPLAYED";
  readonly holdId: string;
  readonly ok: true;
  readonly preparationIdentity: string;
  readonly proposalIdentity: string;
  readonly recordAggregateId: string;
}

export type ExpansionAdmissionOutcome =
  ExpansionAdmissionAccepted | ExpansionAdmissionRefusal;

interface Admitted {
  readonly binding: ExpansionAdmissionBinding;
  readonly bound: ExpansionBoundFacts;
  readonly proposalIdentity: string;
}

/**
 * Scheduler admission, then the SOLE admission-to-core bridge. `bindExpansionAdmission` is what
 * mints `ExpansionAdmittedFacts`, the `DAEMON_VERIFIED` truth marking and the `opportunityRef`;
 * hand-mapping the two shapes here would fork that authority, so nothing here touches them.
 */
function admit(
  payload: ExpansionAdmissionPayload,
  bindings: ExpansionAdmissionBindings,
): Admitted | ExpansionAdmissionRefusal {
  const admission = admitExpansion(payload.proposal);
  if (!admission.ok) return fromAdmission(admission);
  const projected = bindExpansionAdmission({
    currentAuthority: bindings.currentAuthority,
    hold: bindings.hold,
    opportunity: payload.opportunity,
    preparation: admission.preparation,
  });
  if (!projected.ok) return fromBridge(projected);
  return {
    binding: projected.binding,
    bound: admission.preparation.bound,
    proposalIdentity: projected.schedulerPreparationIdentity,
  };
}

/**
 * The two comparisons no kernel can make for itself: that the hold was opened against the graph
 * bytes the project STILL holds, and that the caller's supersession input names that same
 * predecessor. Both operands are durable; a caller supplies neither side of the first.
 */
function contractRefusal(
  payload: ExpansionAdmissionPayload,
  bindings: ExpansionAdmissionBindings,
): ExpansionAdmissionRefusal | null {
  if (!holdMatchesCurrentGraph(bindings.hold, bindings.authority)) {
    return contractMismatch(bindings.hold.holdId);
  }
  if (!namesCurrentPredecessor(payload.supersession, predecessorOf(bindings.authority))) {
    return contractMismatch(bindings.authority.parentRevisionRef);
  }
  return null;
}

/** Core preparation over the admitted facts plus the four families the daemon derives. */
function prepare(
  payload: ExpansionAdmissionPayload,
  bindings: ExpansionAdmissionBindings,
  admitted: Admitted,
): ExpansionPreparation | ExpansionAdmissionRefusal {
  const funding = fundingFactsOf(admitted.bound);
  if (funding === null) return fundingUnderivable(admitted.bound.budgetReservation.admissionRef);
  const prepared = prepareExpansion({
    admitted: admitted.binding.admitted,
    criteria: payload.criteria,
    deadlineEpochMs: bindings.hold.deadline,
    fence: fenceFactsOf(bindings.hold),
    funding,
    graphLifecycle: EXPANSION_ADMISSION_GRAPH_LIFECYCLE,
    policy: payload.policy,
    supersession: payload.supersession,
  });
  return prepared.ok ? prepared.preparation : fromPreparation(prepared);
}

/**
 * The request identity the store fences replays on. It is built from the DERIVED identities
 * rather than from the caller's payload bytes, for two reasons that both matter.
 *
 * The subject refs ALONE are not enough: the store keys a decision on
 * (commandId, principalId, projectId) and replays when the request bytes match, so a second
 * request reusing a commandId with a DIFFERENT proposal would be answered with the FIRST
 * decision — the transport-layer form of reusing stale authority. Feeding the three identities
 * in makes those bytes differ, and the store answers IDEMPOTENCY_CONFLICT instead of replaying.
 *
 * And the payload bytes are the CALLER's: serialising arbitrary nested data here could throw
 * where a refusal belongs. Every value below is a validated production digest.
 */
function requestBytesOf(holdId: string, record: ExpansionApprovalRecord): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([
    holdId, record.proposalIdentity, record.preparationIdentity, record.approvalIdentity,
  ]));
}

/**
 * Manual approval over the live claim, then the ONE durable record. `nowEpochMs` is the SERVER's
 * own decision timestamp: `Date.now()` here would make two identical replays differ and put a
 * clock inside a decision the store must be able to replay.
 */
function approveAndRecord(
  context: ExpansionAdmissionContext,
  envelope: ExpansionAdmissionEnvelope,
  payload: ExpansionAdmissionPayload,
  bindings: ExpansionAdmissionBindings,
  admitted: Admitted,
  preparation: ExpansionPreparation,
): ExpansionAdmissionOutcome {
  const nowEpochMs = Date.parse(envelope.decidedAt);
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
    return expansionAdmissionRefusal("EXPANSION_ADMISSION_ENVELOPE_MALFORMED");
  }
  const approved = approveExpansionManually({
    approval: payload.approval,
    claim: approvalClaimOf(admitted.binding.admitted, preparation),
    command: payload.approvalCommand,
    nowEpochMs,
    preparation,
  });
  if (!approved.ok) return fromApproval(approved);
  const record: ExpansionApprovalRecord = {
    approvalIdentity: approved.binding.identity,
    preparationIdentity: preparation.identity,
    proposalIdentity: admitted.proposalIdentity,
  };
  const committed = commitExpansionApproval(context.store, {
    commandId: envelope.commandId,
    correlationId: envelope.correlationId,
    decidedAt: envelope.decidedAt,
    holdId: bindings.hold.holdId,
    principalId: envelope.principalId,
    projectId: envelope.projectId,
    record,
    requestBytes: requestBytesOf(bindings.hold.holdId, record),
  });
  if (isExpansionAdmissionRefusal(committed)) return committed;
  return Object.freeze({
    ...record,
    disposition: committed.disposition,
    holdId: bindings.hold.holdId,
    ok: true as const,
    recordAggregateId: committed.aggregateId,
  });
}

/** One authenticated expansion admission, from subject refs to one durable approved binding. */
export function handleExpansionAdmission(
  context: ExpansionAdmissionContext,
): ExpansionAdmissionOutcome {
  const decoded = decodeExpansionAdmissionEnvelope(context.envelope);
  if (!decoded.ok) return decoded;
  const { envelope } = decoded;
  const payloadResult = decodeExpansionAdmissionPayload(envelope.payload);
  if (!payloadResult.ok) return payloadResult;
  const payload = payloadResult.payload;

  const resolved = readExpansionAdmissionBindings(context.store, envelope.projectId, payload);
  if (!resolved.ok) return resolved;
  const bindings = resolved.bindings;

  const admitted = admit(payload, bindings);
  if (isExpansionAdmissionRefusal(admitted)) return admitted;
  const mismatch = contractRefusal(payload, bindings);
  if (mismatch !== null) return mismatch;

  const preparation = prepare(payload, bindings, admitted);
  if (isExpansionAdmissionRefusal(preparation)) return preparation;
  return approveAndRecord(context, envelope, payload, bindings, admitted, preparation);
}
