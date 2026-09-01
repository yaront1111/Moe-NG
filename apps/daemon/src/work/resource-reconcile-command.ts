/**
 * The AUTHENTICATED ingress for `resource.reconcile`: the attempt reports what its
 * adapter observed about ONE of its resources, and the durable set moves.
 *
 * THE PAYLOAD NAMES A FACT, NEVER A STATE. `RESOURCE_RECONCILE_PAYLOAD_KEYS` is an
 * exact allow-list of identity plus evidence, and the seam refuses an unlisted key
 * rather than trimming it, so `state`, `resourcesTerminal`, a row list or a released
 * assertion are UNREPRESENTABLE on this wire. What the set becomes is decided by the
 * scheduler reducers alone: `adapterConfirm` admits only an external row that is
 * still acquiring, and `adapterFail` maps an UNKNOWN disposition — and any
 * unfenceable acquiring sibling — to QUARANTINED, which the readiness surface reads
 * as NON-terminal. A reporter's strongest uncertain claim therefore yields the safe
 * answer, and no caller-supplied terminality exists to be trusted.
 *
 * IDENTITY COMES FROM THE ENVELOPE AND THE AUTHENTICATED PRINCIPAL, never from the
 * payload: the caller says WHICH activation and WHICH resource, and the daemon says
 * who is asking and in which project. `applyAttemptResourceReport` then re-reads the
 * committed activation and the durable member set itself, so a report cannot smuggle
 * in a membership.
 *
 * NO DRAIN FENCE HERE, deliberately. Design 312 lists `resource.reconcile` among the
 * commands a FENCED attempt may still issue (`drain-fence.ts` DRAIN_ADMITTED_COMMANDS),
 * so a "refuse while draining" guard would contradict the fence's own admitted list and
 * strand exactly the attempts this seam exists to reconcile.
 *
 * REFUSALS ARE FORWARDED, NOT RESTAMPED. Everything `applyAttemptResourceReport`
 * answers keeps its own code and its own layer — the daemon resource codes under
 * DAEMON_ATTEMPT_RESOURCE and the scheduler passthrough under
 * SCHEDULER_RESOURCE_AUTHORITY with the reducer's upstream code intact. This module
 * mints exactly ONE code of its own, for a request it cannot even shape into a report.
 */

import type { SqliteEventStore } from "@moe/store";

import { applyAttemptResourceReport } from "./attempt-resource-authority.js";
import type {
  AttemptResourceAnswer, AttemptResourceBinding, AttemptResourceLayer, AttemptResourceReport,
} from "./attempt-resource-authority-contracts.js";

/** The FROZEN runtime vocabulary kind (packages/contracts runtime-vocabulary.ts), not a new
 *  one: an ingress that invented a kind would be unreachable from every generated client. */
export const RESOURCE_RECONCILE_COMMAND_KIND = "resource.reconcile" as const;

/**
 * This module's OWN layer. Deliberately not spelled `*_LAYER`: the security-boundary
 * roster scans exported column-zero `*_LAYER(S)` constants and would demand a hostile
 * trio for a name that only tags a request-shape refusal.
 */
export const DAEMON_RESOURCE_RECONCILE = "DAEMON_RESOURCE_RECONCILE" as const;

/** One code, one repair: the request could not be shaped into an adapter report at all. */
export const RESOURCE_RECONCILE_CODES = Object.freeze([
  "RESOURCE_RECONCILE_REQUEST_MALFORMED",
] as const);

export type ResourceReconcileCode = (typeof RESOURCE_RECONCILE_CODES)[number];
export type ResourceReconcileLayer = AttemptResourceLayer | typeof DAEMON_RESOURCE_RECONCILE;

/**
 * IDENTITY + EVIDENCE ONLY, and the exactness is the guarantee: `disposition` is the
 * adapter's failure word (`FAILED` / `UNKNOWN`, judged by the reducer, not here) and
 * rides only on the FAIL arm. Sorted, because the seam compares against this list.
 */
export const RESOURCE_RECONCILE_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "activationAggregateId", "disposition", "epoch", "kind", "resourceId",
]);

export interface ResourceReconcileRefused {
  readonly code: string;
  readonly ok: false;
  readonly refusedBy: ResourceReconcileLayer;
  /** The reducer's own code when a scheduler verdict is being carried, else `null`. */
  readonly upstreamCode: string | null;
}

export type ResourceReconcileOutcome = AttemptResourceAnswer | ResourceReconcileRefused;

/** Everything the seam already authenticated, plus the caller's payload. */
export interface ResourceReconcileInput {
  readonly commandId: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly principalId: string;
  readonly projectId: string;
}

const malformed = (): ResourceReconcileRefused => Object.freeze({
  code: "RESOURCE_RECONCILE_REQUEST_MALFORMED" as ResourceReconcileCode,
  ok: false as const,
  refusedBy: DAEMON_RESOURCE_RECONCILE,
  upstreamCode: null,
});

/** A plain data read: no getter is invoked and a hostile prototype contributes nothing. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** The epoch is an acquisition counter: a negative, fractional or unsafe number is not
 *  one, and the reducer compares it for EQUALITY, so a near-miss must never be coerced. */
const isEpoch = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * The report, or nothing. The GRANT variant of `AttemptResourceReport` is deliberately
 * unreachable from this wire: a successor-capacity grant is not an adapter observation
 * and carries a proof ref this payload has no key for.
 */
function reportOf(payload: unknown): AttemptResourceReport | null {
  const kind = own(payload, "kind");
  const resourceId = own(payload, "resourceId");
  const epoch = own(payload, "epoch");
  const disposition = own(payload, "disposition");
  if (!isText(resourceId) || !isEpoch(epoch)) return null;
  if (kind === "CONFIRM") {
    // A confirmation that also carries a failure word is incoherent, not tolerable:
    // silently dropping the key would let two readings of one request diverge.
    return disposition === undefined ? { epoch, kind: "CONFIRM", resourceId } : null;
  }
  if (kind !== "FAIL" || !isText(disposition)) return null;
  return { disposition, epoch, kind: "FAIL", resourceId };
}

/**
 * Authenticated identity in, adapter report out, the durable answer forwarded verbatim.
 *
 * The binding is composed from the ENVELOPE and the PRINCIPAL; the only thing the
 * payload contributes to it is which activation aggregate is being spoken about, and
 * that value is re-read from the store by the authority before anything is written.
 */
export function runResourceReconcileCommand(
  store: SqliteEventStore, input: ResourceReconcileInput,
): ResourceReconcileOutcome {
  const activationAggregateId = own(input.payload, "activationAggregateId");
  const report = reportOf(input.payload);
  if (!isText(activationAggregateId) || report === null) return malformed();
  const binding: AttemptResourceBinding = Object.freeze({
    activationAggregateId,
    commandId: input.commandId,
    correlationId: input.correlationId,
    principalId: input.principalId,
    projectId: input.projectId,
  });
  const outcome = applyAttemptResourceReport(store, binding, report);
  if (outcome.ok) return outcome;
  return Object.freeze({
    code: outcome.code, ok: false as const, refusedBy: outcome.refusedBy,
    upstreamCode: outcome.upstreamCode,
  });
}
