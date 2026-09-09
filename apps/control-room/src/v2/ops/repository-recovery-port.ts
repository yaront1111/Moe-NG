import type { RecoveryActionView, RecoveryReservationView } from "../../live/live-repository-recovery.js";
import { spendOffer } from "../approvals/offer-wire.js";
import type { OfferOutcome, OfferWire } from "../approvals/offer-wire.js";

export interface RepositoryRecoveryPort {
  submit(reservation: RecoveryReservationView, action: RecoveryActionView, reason: string): Promise<OfferOutcome>;
}
export function createRepositoryRecoveryPort(wire: OfferWire): RepositoryRecoveryPort {
  const refuse = (code: string): OfferOutcome => ({ ok: false, code, layer: "CONTROL_ROOM_RECOVERY" });
  return Object.freeze({ submit: async (reservation: RecoveryReservationView, action: RecoveryActionView, reason: string) => {
    if (!reservation.actions.includes(action) || !action.available || action.offer === null) return refuse("REPOSITORY_RECOVERY_NOT_OFFERED");
    if (reason.trim().length === 0 || reason.trim().length > 1000) return refuse("REPOSITORY_RECOVERY_REASON_REQUIRED");
    return spendOffer(wire, "repository.recover", action.offer, {
      action: action.action, decision: "APPROVE", nodeRef: reservation.nodeRef,
      expectedReservationRevision: reservation.expectedReservationRevision, reason: reason.trim(),
    }, "ui-repository-recovery", "CONTROL_ROOM_RECOVERY");
  } });
}
