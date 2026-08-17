/**
 * The attempt-level release disposition: the COMPOSITION half.
 *
 * THIS MODULE PRODUCES FACTS AND GRANTS NO AUTHORITY. It creates no hold, no
 * PlanningRun and no terminal decision; it composes one advisory row saying what
 * happened to ONE attempt at release: the drain disposition, the attempt's own
 * state, and the lease and provider-slot refs with the states the COMMITTED
 * ACTIVATION gives them.
 *
 * THE AUTHORITY RULE, and it is the whole point of the module. A caller may
 * identify WHICH attempt; it may never supply WHAT happened to it.
 *   - The drain disposition is validated through `parseDrainDisposition` and
 *     `isMonotonicDisposition` from the `@moe/runner` ROOT and is REFUSED rather
 *     than repaired. Nothing here re-derives a rank or a terminal target, and
 *     nothing retypes `WORK_RELEASE_OR_PAUSE` as a local string: two definitions
 *     would drift and core's release predicate would start refusing silently.
 *   - The lease and provider-slot facts are RE-READ from the committed
 *     activation. The `record` argument is used for identity agreement only; a
 *     caller-claimed lease or slot state is never consulted, so it cannot win.
 *   - `resumable` is DERIVED, never accepted. Design 765: only an unchanged
 *     strongest `WORK_RELEASE_OR_PAUSE` result makes the run resumable.
 *
 * FAIL CLOSED. An unreadable activation, an incoherent disposition or a row that
 * no longer re-encodes stays UNKNOWN under an exact code and this layer.
 *
 * The durable half — the frozen vocabulary, the aggregate derivation, the store
 * reads and the single append — lives in `./attempt-release-store.js` and is
 * re-exported below, so consumers keep one import site.
 */

import {
  DRAIN_REASONS, DRAIN_TERMINAL_TARGETS, isMonotonicDisposition, parseDrainDisposition,
} from "@moe/runner";
import type { DrainDisposition } from "@moe/runner";
import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import {
  ATTEMPT_RELEASE_RECORD_VERSION, commitRelease, durableActivation, refuse, sameActivation,
  readAttemptRelease,
} from "./attempt-release-store.js";
import type { AttemptReleaseOutcome, AttemptReleaseRefused } from "./attempt-release-store.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

export {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE, deriveAttemptReleaseAggregateId,
  readAttemptRelease,
} from "./attempt-release-store.js";
export type {
  AttemptReleaseAnswer, AttemptReleaseCode, AttemptReleaseOutcome, AttemptReleaseRefused,
} from "./attempt-release-store.js";

/** What THIS release carried. `reason` is this request's own drain reason;
 *  `disposition` is the accumulated one it was unioned into. */
export interface AttemptReleaseRequest {
  readonly disposition: unknown; readonly reason: string;
}

/**
 * Coherence, answered ONLY by the runner's own predicate.
 * `isMonotonicDisposition` folds two questions into one boolean: is the stored
 * strongest reason the highest-ranked member of its own set, and does the
 * terminal target match that reason's target. To report them separately without
 * re-deriving either, ask the SAME predicate whether any declared target would
 * make this disposition monotonic. If one would, the reason set is sound and
 * only the target is wrong; if none would, the set itself was downgraded.
 */
function coherenceRefusal(disposition: DrainDisposition): AttemptReleaseRefused | null {
  if (isMonotonicDisposition(disposition)) return null;
  const retargetable = DRAIN_TERMINAL_TARGETS.some(
    (terminalTarget) => isMonotonicDisposition({ ...disposition, terminalTarget }));
  return refuse(retargetable
    ? "ATTEMPT_RELEASE_TARGET_MISMATCH" : "ATTEMPT_RELEASE_DISPOSITION_DOWNGRADED");
}

/** `parseDrainDisposition` validates a COPY of `reasons` but hands back the
 *  caller's own array, whose `includes`/iterator are own-overridable. Re-read
 *  the set through the FROZEN vocabulary and a borrowed builtin instead, in the
 *  drain precedence order the runner's own union emits. */
const emittedReasons = (disposition: DrainDisposition): readonly string[] =>
  DRAIN_REASONS.filter((reason) => Array.prototype.includes.call(disposition.reasons, reason));

function admitRequest(request: AttemptReleaseRequest): DrainDisposition | AttemptReleaseRefused {
  if (!DRAIN_REASONS.some((reason) => reason === request.reason)) {
    return refuse("ATTEMPT_RELEASE_REASON_UNKNOWN");
  }
  const disposition = parseDrainDisposition(request.disposition);
  if (disposition === null) return refuse("ATTEMPT_RELEASE_DISPOSITION_MALFORMED");
  const incoherent = coherenceRefusal(disposition);
  if (incoherent !== null) return incoherent;
  // Design 348: each request UNIONS its reason into the disposition, so a reason
  // absent from that set describes a different release from the strongest one.
  return emittedReasons(disposition).includes(request.reason)
    ? disposition : refuse("ATTEMPT_RELEASE_REASON_NOT_UNIONED");
}

/**
 * Design 765, applied as a derivation and never as an input: "only an unchanged
 * strongest WORK_RELEASE_OR_PAUSE result makes the run resumable". Both halves
 * are read off the VALIDATED disposition, so a request cannot assert either.
 */
const isResumable = (disposition: DrainDisposition): boolean =>
  disposition.strongestReason === "WORK_RELEASE_OR_PAUSE"
  && disposition.terminalTarget === "RELEASED";

function releaseRecordBody(
  bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
  disposition: DrainDisposition, reason: string,
): Record<string, unknown> {
  return {
    attemptAggregateId: bound.aggregateId,
    attemptRef: durable.attempt.attemptId, attemptState: durable.attempt.state,
    disposition: {
      resumable: isResumable(disposition), strongestReason: disposition.strongestReason,
      terminalTarget: disposition.terminalTarget,
    },
    leaseRef: durable.lease.leaseId, leaseState: durable.lease.state,
    nodeKey: bound.nodeKey,
    providerSlotRef: durable.providerSlot.slotRef,
    providerSlotState: durable.providerSlot.state,
    reason,
    reasons: emittedReasons(disposition),
    recordVersion: ATTEMPT_RELEASE_RECORD_VERSION,
    sessionId: bound.sessionId,
    truthClass: "DAEMON_VERIFIED",
  };
}

/**
 * The one writer. Validate the disposition through the runner -> re-read the
 * activation from the store -> agree on identity -> compose from DURABLE fields
 * -> commit ONE row -> answer from RE-DECODED durable bytes. The answer never
 * comes from the value just written.
 */
export function recordAttemptRelease(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  request: AttemptReleaseRequest,
): AttemptReleaseOutcome {
  const admitted = admitRequest(request);
  if ("ok" in admitted) return admitted;
  const durable = durableActivation(store, bound);
  if ("ok" in durable) return durable;
  if (!sameActivation(durable, record)) return refuse("ATTEMPT_RELEASE_BINDING_MISMATCH");
  const encoded =
    encodeFoundationPayload(releaseRecordBody(bound, durable, admitted, request.reason));
  if (!encoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  // The event id is COPIED from the grant, never minted: a second release on the
  // same activation collides on store-wide event-id uniqueness instead of
  // quietly landing a second row nobody can choose between.
  if (!commitRelease(store, bound, encoded.bytes, `${durable.grant.grantId}:RELEASED`)) {
    return refuse("ATTEMPT_RELEASE_COMMIT_UNAVAILABLE");
  }
  return readAttemptRelease(store, bound.aggregateId);
}
