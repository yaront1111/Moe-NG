/**
 * The pure predicates the Foundation binding reader composes.
 *
 * Split out because `activation-ledger-reader.ts` crossed the 400-line rail when
 * the effect scan gained its replacement completeness proof. Every function here
 * is a TOTAL FUNCTION OF ITS ARGUMENTS - no store, no clock, no I/O, no decoding
 * - which is exactly what lets them live away from the reader with no import
 * cycle: they need nothing the reader owns, and the reader needs no state of
 * theirs. The reader keeps every judgement that consults the store.
 */

import type { LeaseRecord } from "@moe/scheduler";
import type { StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "./activation-ledger-contracts.js";
import type { FoundationTransition } from "./foundation-activation-transition.js";

/** The exact ordered optional prefix a Foundation launch history may carry. */
export const TRANSITION_ORDER = Object.freeze([
  "GRANT_CONSUMED", "PREFLIGHT_REGISTERED", "PROCESS_OBSERVED",
] as const);

const MAX_QUERY_CHARS = 400;
const LEASE_FIELDS = Object.freeze([
  "leaseId", "kind", "ownerSessionRef", "leaseToken", "epoch", "state", "serverWallDeadline",
  "bootId", "monotonicObservation", "authorityHashRef", "version",
] as const);

export function isQueryText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_QUERY_CHARS
    && value.isWellFormed();
}

export function sameLease(left: LeaseRecord, right: LeaseRecord): boolean {
  return LEASE_FIELDS.every((field) => left[field] === right[field]);
}

export function tracedProject(event: StoredEvent, projectId: string): boolean {
  return event.decisionTrace !== undefined && event.decisionTrace.projectId === projectId;
}

/** Rechecks one decoded transition against the committed activation it claims. */
export function bindsActivation(
  transition: FoundationTransition, record: ActivationLedgerRecord,
  previous: FoundationTransition | undefined,
): boolean {
  if (transition.activationDigest !== record.activationDigest) return false;
  if (transition.grantId !== record.grant.grantId) return false;
  if (transition.intentId !== record.effectIntent.intentId) return false;
  if (transition.attemptId !== record.attempt.attemptId) return false;
  if (transition.wrapperIdentity !== record.grant.wrapperIdentity) return false;
  if (transition.tag === "GRANT_CONSUMED") return true;
  if (transition.lockIdentity === null || transition.processIdentity === null) return false;
  if (transition.bootstrapCredentialDigest === null || transition.registeredAt === null) return false;
  if (transition.tag !== "PROCESS_OBSERVED") return true;
  // The observed process must hold the lock its own preflight reserved, under a
  // DIFFERENT process identity: a preflight re-presented under the observed tag
  // would otherwise persist a reservation as process authority.
  if (previous === undefined || previous.tag !== "PREFLIGHT_REGISTERED") return false;
  return transition.lockIdentity === previous.lockIdentity
    && transition.processIdentity !== previous.processIdentity;
}
