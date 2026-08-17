/**
 * The attempt-level release disposition: the COMPOSITION half.
 *
 * THIS MODULE PRODUCES FACTS AND GRANTS NO AUTHORITY. It creates no hold, no
 * PlanningRun and no terminal decision; it composes one advisory row saying what
 * happened to ONE attempt at release.
 *
 * THE AUTHORITY RULE, and it is the whole point of the module. A caller may
 * identify WHICH attempt and supply the boundary FACTS; it may never supply what
 * those facts MEAN.
 *   - `releaseWork` from the `@moe/scheduler` ROOT is the sole design-765
 *     release authority. It fences the lease, parses the request, refuses an
 *     uncommittable handoff BEFORE composing any transition, and then decides
 *     RELEASED / DRAINING / NO_OP. Nothing here re-derives a rank, a terminal
 *     target or `resumable`: a second definition would drift, and core's release
 *     predicate would start refusing silently. Its refusals are carried under
 *     ITS layer, never flattened into a daemon code.
 *   - The lease handed to the kernel is the one the KERNEL last answered, read
 *     back out of the durable release row, falling back to the committed
 *     activation only when no release has happened yet. The `AuthorityProof` is
 *     built entirely from that lease; a caller-supplied proof is never consulted.
 *   - The attempt and provider-slot facts are RE-READ from the committed
 *     activation. The `record` argument is used for identity agreement only, so
 *     a caller-claimed lease or slot state cannot win.
 *
 * FAIL CLOSED. An unreadable activation, a lease the parser will not accept, a
 * rejected request or a row that no longer re-encodes stays UNKNOWN under an
 * exact code and a named layer.
 *
 * The durable half — the frozen vocabulary, the aggregate derivation, the store
 * reads and the single append — lives in `./attempt-release-store.js` and is
 * re-exported below, so consumers keep one import site.
 */

import { parseLeaseRecord, releaseWork } from "@moe/scheduler";
import type { AuthorityProof, LeaseRecord, ReleaseResult } from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import {
  ATTEMPT_RELEASE_RECORD_VERSION, carryAuthorityRejection, commitRelease, durableActivation,
  readAttemptRelease, refuse, sameActivation, withOutcome,
} from "./attempt-release-store.js";
import type { AttemptReleaseOutcome } from "./attempt-release-store.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

export {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_OUTCOMES, ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE,
  SCHEDULER_LEASE_DRAIN, deriveAttemptReleaseAggregateId, readAttemptRelease,
} from "./attempt-release-store.js";
export type {
  AttemptReleaseAnswer, AttemptReleaseCode, AttemptReleaseLayer, AttemptReleaseOutcome,
  AttemptReleaseOutcomeName, AttemptReleaseRefused,
} from "./attempt-release-store.js";

/**
 * What THIS release carried, all of it PASS-THROUGH to the kernel.
 *
 * `safeBoundaryObserved`, `effectsTerminal` and `resourcesTerminal` are typed
 * `unknown` on purpose: their durable producers are task-ded026d6 and
 * task-6d400781 and neither has landed, so the daemon relays whatever it was
 * given and never synthesizes, defaults or optimistically upgrades one. The
 * kernel demands a real boolean, so an omitted flag is refused rather than read
 * as false-and-drained or true-and-released. `handoff` is the same relay pending
 * task-af9454f4.
 */
export interface AttemptReleaseRequest {
  readonly disposition: unknown;
  readonly effectsTerminal: unknown;
  readonly handoff: unknown;
  readonly intentRefs: unknown;
  readonly reason: string;
  readonly resourcesTerminal: unknown;
  readonly safeBoundaryObserved: unknown;
}

/** Exactly the seven keys `releaseWork` accepts. Spreading the caller's record
 *  instead would let one extra key refuse the whole release as malformed. */
const kernelRequest = (request: AttemptReleaseRequest): Record<string, unknown> => ({
  disposition: request.disposition, effectsTerminal: request.effectsTerminal,
  handoff: request.handoff, intentRefs: request.intentRefs, reason: request.reason,
  resourcesTerminal: request.resourcesTerminal,
  safeBoundaryObserved: request.safeBoundaryObserved,
});

/** Every field comes off the durable lease itself, so there is no channel for a
 *  caller to present a proof for a lease it does not hold. */
const proofOf = (lease: LeaseRecord): AuthorityProof => ({
  authorityHashRef: lease.authorityHashRef, epoch: lease.epoch, expectedVersion: lease.version,
  leaseToken: lease.leaseToken, ownerSessionRef: lease.ownerSessionRef,
});

function releaseRecordBody(
  bound: FoundationAttemptBound, durable: ActivationLedgerRecord,
  result: Extract<ReleaseResult, { outcome: "DRAINING" | "RELEASED" }>, reason: string,
): Record<string, unknown> {
  const { disposition, lease } = result;
  return {
    attemptAggregateId: bound.aggregateId,
    attemptRef: durable.attempt.attemptId, attemptState: durable.attempt.state,
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
    // The provider slot is task-4731ba34's transition; `releaseWork` does not
    // touch slots, so this stays the durable activation-time fact.
    providerSlotRef: durable.providerSlot.slotRef,
    providerSlotState: durable.providerSlot.state,
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

/**
 * The one writer. Re-read the activation -> agree on identity -> take the lease
 * the kernel last answered -> let `releaseWork` decide -> commit ONE row ->
 * answer from RE-DECODED durable bytes. The answer never comes from the value
 * just written, and no branch here judges the release itself.
 */
export function recordAttemptRelease(
  store: SqliteEventStore, bound: FoundationAttemptBound, record: ActivationLedgerRecord,
  request: AttemptReleaseRequest,
): AttemptReleaseOutcome {
  const durable = durableActivation(store, bound);
  if ("ok" in durable) return durable;
  if (!sameActivation(durable, record)) return refuse("ATTEMPT_RELEASE_BINDING_MISMATCH");
  const prior = readAttemptRelease(store, bound.aggregateId);
  // An absent row is the first release; any OTHER refusal means the durable
  // history is unreadable, and releasing over it would write a second truth.
  if (!prior.ok && prior.code !== "ATTEMPT_RELEASE_RECORD_ABSENT") return prior;
  // BOTH sources go through the scheduler's own parser. `proofOf` reads five
  // fields off this value, so an absent or malformed lease would be a TypeError
  // rather than a refusal — and a crash is not a fail-closed answer. The two
  // arms keep distinct codes because they demand opposite repairs.
  const lease = parseLeaseRecord(prior.ok ? prior.record["lease"] : durable.lease);
  if (lease === null) {
    return refuse(prior.ok
      ? "ATTEMPT_RELEASE_RECORD_DRIFT" : "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE");
  }
  const released = releaseWork(lease, proofOf(lease), kernelRequest(request));
  if (!released.ok) return carryAuthorityRejection(released);
  const result = released.value;
  if (result.outcome === "NO_OP") {
    // A release that already happened. The row that recorded it stands, so the
    // aggregate keeps exactly one row and no second truth is composed.
    return prior.ok ? withOutcome(prior, "NO_OP") : refuse("ATTEMPT_RELEASE_RECORD_ABSENT");
  }
  const encoded =
    encodeFoundationPayload(releaseRecordBody(bound, durable, result, request.reason));
  if (!encoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  // The event id is COPIED from the grant, never minted: a second release on the
  // same activation collides on store-wide event-id uniqueness instead of
  // quietly landing a second row nobody can choose between.
  if (!commitRelease(store, bound, encoded.bytes, `${durable.grant.grantId}:RELEASED`)) {
    return refuse("ATTEMPT_RELEASE_COMMIT_UNAVAILABLE");
  }
  return readAttemptRelease(store, bound.aggregateId);
}
