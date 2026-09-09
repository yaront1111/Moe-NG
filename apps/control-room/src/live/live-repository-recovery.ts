import { effectCount, effectList, effectOffer, effectRecord, effectRefusal, effectText, readEffect } from "./live-effect-read.js";
import type { EffectReadFailure } from "./live-effect-read.js";

export type RepositoryRecoveryAction = "ABORT_UNEXECUTED" | "RECONCILE_LANDED";
export interface RecoveryActionView {
  readonly action: RepositoryRecoveryAction; readonly available: boolean;
  readonly code: string | null; readonly offer: Readonly<Record<string, unknown>> | null;
}
export interface RecoveryReservationView {
  readonly nodeRef: string; readonly phase: string; readonly expectedReservationRevision: number;
  readonly actions: readonly RecoveryActionView[];
}
export interface RepositoryRecoveryView {
  readonly version: "moe-repository-recovery/1"; readonly projectId: string;
  readonly reservations: readonly RecoveryReservationView[]; readonly code: string | null;
}
export type RepositoryRecoveryOutcome = EffectReadFailure | { readonly status: "RECOVERY"; readonly view: RepositoryRecoveryView };
const LAYER = "CONTROL_ROOM_RECOVERY";
const invalid = (): EffectReadFailure => ({ status: "ERROR", code: "REPOSITORY_RECOVERY_RESPONSE_INVALID", layer: LAYER });

function actionOf(value: unknown): RecoveryActionView | null {
  const row = effectRecord(value, ["action", "available", "code", "offer"]);
  if (row === null || (row.action !== "ABORT_UNEXECUTED" && row.action !== "RECONCILE_LANDED")) return null;
  if (row.available === false && effectText(row.code) && row.offer === null) {
    return Object.freeze({ action: row.action, available: false, code: row.code, offer: null });
  }
  const offer = effectOffer(row.offer, "repository.recover");
  return row.available === true && row.code === null && offer !== null
    ? Object.freeze({ action: row.action, available: true, code: null, offer }) : null;
}
function reservationOf(value: unknown): RecoveryReservationView | null {
  const row = effectRecord(value, ["nodeRef", "phase", "expectedReservationRevision", "actions"]);
  if (row === null || !effectText(row.nodeRef) || !effectText(row.phase)
    || !effectCount(row.expectedReservationRevision) || row.expectedReservationRevision < 1) return null;
  const actions = effectList(row.actions, actionOf, 2);
  if (actions === null || new Set(actions.map((action) => action.action)).size !== actions.length) return null;
  return Object.freeze({ nodeRef: row.nodeRef, phase: row.phase, expectedReservationRevision: row.expectedReservationRevision, actions });
}
export function mapRepositoryRecoveryAnswer(status: number, body: unknown): RepositoryRecoveryOutcome {
  const refusal = effectRefusal(body); if (refusal !== null) return refusal;
  const row = effectRecord(body, ["version", "projectId", "reservations", "code"]);
  if (status !== 200 || row === null || row.version !== "moe-repository-recovery/1"
    || !effectText(row.projectId) || (row.code !== null && !effectText(row.code))) return invalid();
  const reservations = effectList(row.reservations, reservationOf);
  if (reservations === null || new Set(reservations.map((entry) => entry.nodeRef)).size !== reservations.length) return invalid();
  return Object.freeze({ status: "RECOVERY", view: Object.freeze({ version: row.version, projectId: row.projectId, code: row.code, reservations }) });
}
export async function readRepositoryRecovery(headers: Readonly<Record<string, string>>, post?: (body: string) => Promise<Response>): Promise<RepositoryRecoveryOutcome> {
  return readEffect(headers, "/repository/recovery/read", {}, mapRepositoryRecoveryAnswer, LAYER, post);
}
