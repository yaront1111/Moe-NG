/**
 * The OPERATOR-authenticated ingress for `resource.confirm_released`: a human presents
 * EVIDENCE that a quarantined resource is genuinely free, and the durable set moves.
 *
 * WHY IT IS SEPARATE FROM `resource.reconcile`. That seam is the ATTEMPT's own authority
 * over its OWN resources — it reports what an adapter observed, and the scheduler decides
 * what an uncertain observation means, which is a QUARANTINE. Admitting a GRANT there
 * would let an attempt clear the very quarantine its own uncertainty created. A proven
 * release is somebody else's evidence, so it gets its own kind, its own capability and
 * its own principal gate.
 *
 * THE PAYLOAD NAMES IDENTITY AND A PROOF REFERENCE, NEVER AN OUTCOME.
 * `RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS` is an exact allow-list of two keys and the
 * seam refuses an unlisted key structurally rather than trimming it, so `resourceId`,
 * `epoch`, `state`, a terminal flag, a member list, a cleared-id list and a caller
 * project are UNREPRESENTABLE on this wire. `grantSuccessorCapacity` alone decides which
 * rows clear, and it clears EVERY quarantined member or none — this module never names
 * one resource, never pre-reads the set to filter it, and never asserts terminality. The
 * strict readiness reader still derives set-terminality by probing each durable row.
 *
 * IDENTITY COMES FROM THE ENVELOPE AND THE AUTHENTICATED PRINCIPAL. The caller says WHICH
 * activation; the daemon says who is asking and in which project.
 * `applyAttemptResourceReport` then re-reads the committed activation and the durable
 * member set itself, so a request cannot smuggle in a membership.
 *
 * WHERE THE PROOF IS JUDGED, stated plainly rather than implied. `proofRef` is evidence
 * IDENTITY, not a verified proof: this module refuses a request it cannot shape into a
 * report at all — a missing or non-string ref — and an ADMITTED string, including the
 * empty one, is handed to the scheduler, whose own `isRef` decides. Refusing the empty
 * string here would move that boundary and hide which authority defines a proof.
 *
 * REFUSALS ARE FORWARDED, NOT RESTAMPED, exactly as the reconcile seam forwards them:
 * the daemon resource codes keep DAEMON_ATTEMPT_RESOURCE and the scheduler passthrough
 * keeps SCHEDULER_RESOURCE_AUTHORITY with the reducer's upstream code intact. This
 * module mints exactly ONE code of its own.
 */

import type { SqliteEventStore } from "@moe/store";

import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import type {
  AttemptResourceAnswer, AttemptResourceBinding, AttemptResourceLayer,
} from "./attempt-resource-authority-contracts.js";

/** The FROZEN runtime vocabulary kind (packages/contracts runtime-vocabulary.ts), the same
 *  one `doctor.propose_resource_release` already names as the follow-up an operator would
 *  carry out: an ingress that invented a kind would be unreachable from every generated
 *  client and would leave that proposal pointing at nothing. */
export const RESOURCE_CONFIRM_RELEASED_COMMAND_KIND = "resource.confirm_released" as const;

/**
 * This module's OWN layer. Deliberately not spelled `*_LAYER`: the security-boundary
 * roster scans exported column-zero `*_LAYER(S)` constants and would demand a hostile
 * trio for a name that only tags a request-shape refusal.
 */
export const DAEMON_RESOURCE_CONFIRM_RELEASED = "DAEMON_RESOURCE_CONFIRM_RELEASED" as const;

/** One code, one repair: the request could not be shaped into a grant report at all. */
export const RESOURCE_CONFIRM_RELEASED_CODES = Object.freeze([
  "RESOURCE_CONFIRM_RELEASED_REQUEST_MALFORMED",
] as const);

export type ResourceConfirmReleasedCode = (typeof RESOURCE_CONFIRM_RELEASED_CODES)[number];
export type ResourceConfirmReleasedLayer =
  AttemptResourceLayer | typeof DAEMON_RESOURCE_CONFIRM_RELEASED;

/** IDENTITY + EVIDENCE, and the exactness is the guarantee. Sorted, because the seam
 *  compares against this list in order. */
export const RESOURCE_CONFIRM_RELEASED_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "activationAggregateId", "proofRef",
]);

export interface ResourceConfirmReleasedRefused {
  readonly code: string;
  readonly ok: false;
  readonly refusedBy: ResourceConfirmReleasedLayer;
  /** The reducer's own code when a scheduler verdict is being carried, else `null`. */
  readonly upstreamCode: string | null;
}

export type ResourceConfirmReleasedOutcome =
  AttemptResourceAnswer | ResourceConfirmReleasedRefused;

/** Everything the seam already authenticated, plus the caller's payload. */
export interface ResourceConfirmReleasedInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

const malformed = (): ResourceConfirmReleasedRefused => Object.freeze({
  code: "RESOURCE_CONFIRM_RELEASED_REQUEST_MALFORMED" as ResourceConfirmReleasedCode,
  ok: false as const,
  refusedBy: DAEMON_RESOURCE_CONFIRM_RELEASED,
  upstreamCode: null,
});

/** A plain data read: no getter is invoked and a hostile prototype contributes nothing. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

/** A string, and nothing else. The EMPTY string is deliberately admitted here — see the
 *  module note on where a proof is judged. */
const isString = (value: unknown): value is string => typeof value === "string";

/**
 * Authenticated identity in, a grant report out, the durable answer forwarded verbatim.
 *
 * The binding is composed from the ENVELOPE and the PRINCIPAL; the only thing the payload
 * contributes is which activation aggregate is being spoken about, and the authority
 * re-reads that value from the store before anything is written. The report is built
 * literally — `{ kind: "GRANT", proofRef }` — so there is no field a caller could widen.
 */
export function runResourceConfirmReleasedCommand(
  store: SqliteEventStore, input: ResourceConfirmReleasedInput,
): ResourceConfirmReleasedOutcome {
  const activationAggregateId = own(input.payload, "activationAggregateId");
  const proofRef = own(input.payload, "proofRef");
  if (activationAggregateId === undefined || proofRef === undefined) return malformed();
  if (!isString(activationAggregateId) || activationAggregateId.length === 0) return malformed();
  if (!isString(proofRef)) return malformed();
  const binding: AttemptResourceBinding = Object.freeze({
    activationAggregateId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  const outcome = applyAttemptResourceReport(store, binding, { kind: "GRANT", proofRef });
  if (outcome.ok) return outcome;
  return Object.freeze({
    code: outcome.code, ok: false as const, refusedBy: outcome.refusedBy,
    upstreamCode: outcome.upstreamCode,
  });
}
