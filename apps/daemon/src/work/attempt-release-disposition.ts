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
 *   - `releaseProviderSlot`, from the same ROOT, is the sole authority over the
 *     provider slot. The daemon derives its command from the durable activation
 *     and persists the successor it answers; it never composes a slot state.
 *     Its refusals are carried under a THIRD layer, because both kernels answer
 *     out of one two-member code vocabulary and a slot that cannot be released
 *     is not a lease that could not be fenced.
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

import { parseLeaseRecord, releaseProviderSlot, releaseWork } from "@moe/scheduler";
import type {
  AuthorityProof, LeaseRecord, ProviderSlotReleaseCommand, ProviderSlotReservation, ReleaseResult,
} from "@moe/scheduler";
import type { SqliteEventStore } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import {
  carriesBoundaryClaim, deriveSafeBoundary, refuseBoundaryClaim,
} from "./attempt-release-boundary.js";
import {
  carriesTerminalClaim, deriveReleaseTerminal, refuseTerminalClaim,
} from "./attempt-release-terminal.js";
import type { ReleaseTerminalFlags } from "./attempt-release-terminal.js";
import {
  ATTEMPT_RELEASE_RECORD_VERSION, carryAuthorityRejection, carrySlotRejection, commitRelease,
  durableActivation, readAttemptRelease, refuse, sameActivation, withOutcome,
} from "./attempt-release-store.js";
import type { AttemptReleaseOutcome } from "./attempt-release-store.js";
import { encodeFoundationPayload } from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";

export {
  ATTEMPT_RELEASE_CODES, ATTEMPT_RELEASE_COMMAND_KIND, ATTEMPT_RELEASE_EVENT_TYPE,
  ATTEMPT_RELEASE_OUTCOMES, ATTEMPT_RELEASE_RECORD_VERSION, DAEMON_ATTEMPT_RELEASE,
  SCHEDULER_LEASE_DRAIN, SCHEDULER_PROVIDER_SLOT_RELEASE, deriveAttemptReleaseAggregateId,
  readAttemptRelease,
} from "./attempt-release-store.js";
export type {
  AttemptReleaseAnswer, AttemptReleaseCode, AttemptReleaseLayer, AttemptReleaseOutcome,
  AttemptReleaseOutcomeName, AttemptReleaseRefused,
} from "./attempt-release-store.js";

/**
 * What THIS release carried. FOUR keys, and NONE of the three settle facts the
 * kernel wants is one of them.
 *
 * ALL THREE ARE DERIVED NOW, and none has a key here at all. `safeBoundaryObserved`
 * came off first (task-ded026d6's producer, see `./attempt-release-boundary.js`);
 * `effectsTerminal` and `resourcesTerminal` follow the same route against
 * task-6d400781's, in `./attempt-release-terminal.js` — which likewise REFUSES a
 * request still carrying a retired key rather than ignoring it. `handoff` remains
 * a relay pending task-af9454f4; do not read its `unknown` typing as drift.
 *
 * An agent may still say WHICH attempt is being released and why. It may no
 * longer say that its own boundary was safe, or that its own effects and
 * resources were finished.
 */
export interface AttemptReleaseRequest {
  readonly disposition: unknown;
  readonly handoff: unknown;
  readonly intentRefs: unknown;
  readonly reason: string;
}

/** Exactly the seven keys `releaseWork` accepts. Spreading the CALLER's record
 *  instead would let one extra key refuse the whole release as malformed. Three
 *  arrive SEPARATELY because they are server-derived: there is no field on the
 *  request for this function to reach for. The terminality pair is spread as ONE
 *  frozen two-key record rather than written key by key, so this seam holds no
 *  place to transpose two booleans the kernel could not tell apart. */
const kernelRequest = (
  request: AttemptReleaseRequest, safeBoundaryObserved: boolean,
  terminal: ReleaseTerminalFlags,
): Record<string, unknown> => ({
  disposition: request.disposition, handoff: request.handoff,
  intentRefs: request.intentRefs, reason: request.reason, safeBoundaryObserved, ...terminal,
});

/** Every field comes off the durable lease itself, so there is no channel for a
 *  caller to present a proof for a lease it does not hold. */
const proofOf = (lease: LeaseRecord): AuthorityProof => ({
  authorityHashRef: lease.authorityHashRef, epoch: lease.epoch, expectedVersion: lease.version,
  leaseToken: lease.leaseToken, ownerSessionRef: lease.ownerSessionRef,
});

/**
 * The slot-release command, derived from the DURABLE ACTIVATION and nothing
 * else: the slot's own three identity fields plus the attempt the activation
 * committed. No caller can present a slot, a state or a command here — that is
 * why `AttemptReleaseRequest` carries no slot field at all.
 *
 * `attemptRef` deliberately comes from the ATTEMPT rather than from the slot's
 * own binding, so the kernel's binding guard stays a real cross-check between
 * two durable facts instead of comparing the slot with itself. An activation
 * whose slot names another attempt — or names none, `attemptRef` being `null`
 * on a slot that was never activated and never a wildcard — is refused.
 */
const slotReleaseCommand = (durable: ActivationLedgerRecord): ProviderSlotReleaseCommand => ({
  attemptRef: durable.attempt.attemptId, dimension: durable.providerSlot.dimension,
  requestId: durable.providerSlot.requestId, slotRef: durable.providerSlot.slotRef,
});

function releaseRecordBody(
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
  // BEFORE ANY STORE READ. A caller that spoke about ANY settle fact is refused
  // here, so a spoofed flag cannot even cause an observation to be recorded on
  // its way to being discarded. THE ORDER IS LOAD-BEARING: the boundary predicate
  // is the total one over `unknown`, so it answers for a null or non-object
  // request and the terminality predicate below only ever sees a real object.
  if (carriesBoundaryClaim(request)) return refuseBoundaryClaim();
  if (carriesTerminalClaim(request)) return refuseTerminalClaim();
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
  // THE BOUNDARY IS DERIVED HERE, before the kernel is asked anything. A run the
  // host never recorded refuses under the PRODUCER's layer rather than draining:
  // an unknown boundary is not an unsafe one, and they demand opposite repairs.
  const boundary = deriveSafeBoundary(store, bound, durable);
  if (!boundary.ok) return boundary;
  // AND SO IS TERMINALITY, from the ledgers that own it. An item whose state
  // cannot be read refuses under the PRODUCER's layer rather than draining: an
  // unknown terminality is not an unfinished one, and treating it as false would
  // drain a release nobody could investigate — while treating it as true would
  // release work nothing proved finished.
  const terminal = deriveReleaseTerminal(store, bound, durable);
  if (!terminal.ok) return terminal;
  const released = releaseWork(lease, proofOf(lease),
    kernelRequest(request, boundary.safeBoundaryObserved, terminal.flags));
  if (!released.ok) return carryAuthorityRejection(released);
  const result = released.value;
  if (result.outcome === "NO_OP") {
    // A release that already happened. The row that recorded it stands, so the
    // aggregate keeps exactly one row and no second truth is composed.
    return prior.ok ? withOutcome(prior, "NO_OP") : refuse("ATTEMPT_RELEASE_RECORD_ABSENT");
  }
  // THE SLOT TRANSITION RUNS BEFORE ANY WRITE, and that ORDER IS the all-or-none
  // rule: once `commitRelease` lands a decision there is no compensating path,
  // so a refused slot must leave zero rows rather than a row describing a
  // transition that never happened. Only a SETTLED boundary reaches it — a
  // draining release keeps the durable slot fact exactly as the activation left
  // it, because a slot released mid-drain would claim the safe boundary the
  // kernel just declined to certify.
  let slot: ProviderSlotReservation = durable.providerSlot;
  if (result.outcome === "RELEASED") {
    const settled = releaseProviderSlot(durable.providerSlot, slotReleaseCommand(durable));
    if (!settled.ok) return carrySlotRejection(settled);
    slot = settled.value;
  }
  const encoded =
    encodeFoundationPayload(releaseRecordBody(bound, durable, result, request.reason, slot));
  if (!encoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  // The event id is COPIED from the grant, never minted: a second release on the
  // same activation collides on store-wide event-id uniqueness instead of
  // quietly landing a second row nobody can choose between.
  if (!commitRelease(store, bound, encoded.bytes, `${durable.grant.grantId}:RELEASED`)) {
    return refuse("ATTEMPT_RELEASE_COMMIT_UNAVAILABLE");
  }
  return readAttemptRelease(store, bound.aggregateId);
}
