import type { ProviderSlotReservation, ReleaseResult } from "@moe/scheduler";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { ATTEMPT_RELEASE_RECORD_VERSION } from "./attempt-release-store.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

/**
 * THE DURABLE BODY OF A RELEASE ROW, extracted from `./attempt-release-disposition.js`
 * unchanged when task-af9454f4's wiring took that file past its line target.
 *
 * A BEHAVIOUR-PRESERVING MOVE: every field, every comment and every derivation is
 * the one the release path already committed, and the sibling suite that reads
 * those rows back is the check that it stayed that way.
 */

export function releaseRecordBody(
  bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
  result: Extract<ReleaseResult, { outcome: "DRAINING" | "RELEASED" }>, reason: string,
  slot: ProviderSlotReservation,
): Record<string, unknown> {
  const { disposition, lease } = result;
  return {
    attemptAggregateId: bound.aggregateId,
    // The SAFE-BOUNDARY TRANSACTION OUTCOME, not the activation slice. The row
    // says what this release did to the attempt; the slice said RUNNING forever.
    attemptRef: durable.attempt.attemptId, attemptState: result.outcome,
    disposition: {
      resumable: disposition.resumable, strongestReason: disposition.strongestReason,
      terminalTarget: disposition.terminalTarget,
    },
    handoff: result.outcome === "RELEASED" ? { ...result.handoff } : null,
    intentRefs: result.outcome === "DRAINING" ? [...result.intentRefs] : null,
    lease: { ...lease },
    leaseRef: lease.leaseId, leaseState: lease.state,
    nodeKey: bound.nodeKey,
    outcome: result.outcome,
    // The SUCCESSOR the slot kernel answered on a settled boundary, and the
    // untouched durable fact on a draining one — never a state composed here.
    providerSlotRef: slot.slotRef,
    providerSlotState: slot.state,
    reason,
    reasons: [...disposition.reasons],
    recordVersion: ATTEMPT_RELEASE_RECORD_VERSION,
    releasePending: result.releasePending,
    // The KERNEL's answer for this release, which is NOT the disposition's own:
    // an unsettled boundary is never resumable however resumable its reason set.
    resumable: result.resumable,
    sessionId: bound.sessionId,
    truthClass: "DAEMON_VERIFIED",
  };
}
