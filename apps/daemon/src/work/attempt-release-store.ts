/**
 * The durable half of the attempt-level release record: its frozen vocabulary,
 * its aggregate derivation, the two store reads it depends on, and the single
 * append that lands one row.
 *
 * SPLIT OUT OF `./attempt-release-disposition.ts`, which keeps the composition.
 * The vocabulary travelled WITH the storage rather than staying behind, because
 * every function here refuses through `refuse` and every one of them is called
 * by the composer: leaving the codes on the other side would make the two
 * modules import each other, and a const-initialised `refuse` reached through an
 * import cycle is a temporal-dead-zone crash, not a type error. The composer
 * re-exports every public name, so `./attempt-release-disposition.js` remains
 * the one import site for consumers.
 *
 * NOTHING HERE GRANTS AUTHORITY. It creates no hold, no PlanningRun and no
 * terminal decision; it writes one advisory row saying what happened to ONE
 * attempt at release. The lease and provider-slot facts are RE-READ from the
 * committed activation, never taken from a caller's copy.
 */

import type { AuthorityErrorCode, AuthorityRejection } from "@moe/scheduler";
import type { SqliteEventStore, StoredEvent } from "@moe/store";

import type { ActivationLedgerRecord } from "../activation/activation-ledger-contracts.js";
import { readFoundationActivationHistory } from "../activation/activation-ledger-reader.js";
import {
  decodeFoundationPayload, encodeFoundationPayload, sameBytes, sha256Hex,
} from "./foundation-attempt-codec.js";
import type { FoundationAttemptBound } from "./foundation-attempt-contracts.js";
import type {
  ReleaseTerminalCode, ReleaseTerminalLayer, ReleaseTerminalRefusal,
} from "./release-terminal-evidence.js";
import type {
  SafeBoundaryObservationLayer, SafeBoundaryRefusalCode, SafeBoundaryRefused,
} from "./safe-boundary-observation.js";

export const ATTEMPT_RELEASE_RECORD_VERSION = "moe-attempt-release-record/1" as const;
export const ATTEMPT_RELEASE_EVENT_TYPE = "AttemptReleaseRecorded" as const;
export const ATTEMPT_RELEASE_COMMAND_KIND = "work.attempt_release" as const;

/** This module's own layer. A refusal raised by the activation reader keeps ITS
 *  code; only decisions made here are reported under this name. */
export const DAEMON_ATTEMPT_RELEASE = "DAEMON_ATTEMPT_RELEASE" as const;
/** The OTHER layer that can refuse this path. `releaseWork` fences the lease and
 *  parses the whole release request itself, so its rejection is carried under
 *  ITS name: a daemon code standing in for a kernel refusal would hide the fact
 *  that the daemon no longer judges dispositions at all. */
export const SCHEDULER_LEASE_DRAIN = "SCHEDULER_LEASE_DRAIN" as const;
/** The THIRD layer, and the reason it is a layer rather than a code. The slot
 *  transition is a second, independent scheduler kernel on this path, and both
 *  kernels answer out of the SAME closed two-member `AuthorityErrorCode`
 *  vocabulary — `releaseProviderSlot` in particular stamps AUTHORITY_STALE_LEASE
 *  on all four of its identity, binding and state guards. Carrying its refusals
 *  under `SCHEDULER_LEASE_DRAIN` would make a slot that cannot be released
 *  indistinguishable from a lease that could not be fenced, and they demand
 *  opposite repairs. The layer is what disambiguates; the code and the kernel's
 *  own message ride along unchanged. */
export const SCHEDULER_PROVIDER_SLOT_RELEASE = "SCHEDULER_PROVIDER_SLOT_RELEASE" as const;
/** The FOURTH layer, and the one that is not a kernel. `safeBoundaryObserved`
 *  is DERIVED from the durable provider-run record by task-ded026d6's producer,
 *  so a release can now fail because the HOST never recorded a run — which is a
 *  different fact, and a different repair, from a lease that would not fence or
 *  a row this daemon composed badly. Its five refusal codes ride along verbatim
 *  under its own name rather than being flattened into a daemon code. */
/** The FIFTH layer, and the second that is not a kernel. Both terminality flags
 *  are DERIVED by task-6d400781's producer, so a release can fail because an
 *  ITEM's state cannot be READ — a different repair from an unrecorded run or an
 *  unfenceable lease, so its five codes ride along verbatim. */
export type AttemptReleaseLayer = typeof DAEMON_ATTEMPT_RELEASE
  | ReleaseTerminalLayer | SafeBoundaryObservationLayer
  | typeof SCHEDULER_LEASE_DRAIN | typeof SCHEDULER_PROVIDER_SLOT_RELEASE;

/** Closed, and every member names a DIFFERENT repair. Zero rows, two rows and
 *  bytes that no longer re-encode stay three codes for the reason the sibling
 *  dispatch reader keeps them apart. NO disposition or drain-reason code lives
 *  here any more: `releaseWork` owns that judgement, and a member only this
 *  daemon could raise would be a dead entry that still read as coverage. */
export const ATTEMPT_RELEASE_CODES = Object.freeze([
  "ATTEMPT_RELEASE_BINDING_MISMATCH", "ATTEMPT_RELEASE_ACTIVATION_UNREADABLE",
  "ATTEMPT_RELEASE_COMMIT_UNAVAILABLE", "ATTEMPT_RELEASE_RECORD_ABSENT",
  "ATTEMPT_RELEASE_RECORD_AMBIGUOUS", "ATTEMPT_RELEASE_RECORD_DRIFT",
  "ATTEMPT_RELEASE_RECORD_UNREADABLE", "ATTEMPT_RELEASE_REQUEST_MALFORMED",
] as const);
export type AttemptReleaseCode = (typeof ATTEMPT_RELEASE_CODES)[number];

/** The kernel's three answers, recorded verbatim. `NO_OP` never composes a row:
 *  it names a release that had already happened, and the row that recorded it
 *  stands untouched. */
export const ATTEMPT_RELEASE_OUTCOMES = Object.freeze([
  "DRAINING", "NO_OP", "RELEASED",
] as const);
export type AttemptReleaseOutcomeName = (typeof ATTEMPT_RELEASE_OUTCOMES)[number];

export interface AttemptReleaseRefused {
  readonly advisoryOnly: true; readonly authority: "NONE";
  readonly code: AttemptReleaseCode | AuthorityErrorCode | ReleaseTerminalCode
    | SafeBoundaryRefusalCode;
  /** The refusing layer's own words when it had any; never rewritten here. */
  readonly message: string | null;
  readonly ok: false; readonly refusedBy: AttemptReleaseLayer;
}
export interface AttemptReleaseAnswer {
  readonly advisoryOnly: true; readonly authority: "ADVISORY_RECORD"; readonly digest: string;
  readonly ok: true;
  /** What the kernel answered for THIS call. A replay answers `NO_OP` while the
   *  row it hands back still records the `RELEASED` that actually happened. */
  readonly outcome: AttemptReleaseOutcomeName;
  readonly record: Record<string, unknown>;
}
export type AttemptReleaseOutcome = AttemptReleaseAnswer | AttemptReleaseRefused;

const encoder = new TextEncoder();

export const refuse = (code: AttemptReleaseCode): AttemptReleaseRefused => Object.freeze({
  advisoryOnly: true as const, authority: "NONE" as const, code, message: null, ok: false as const,
  refusedBy: DAEMON_ATTEMPT_RELEASE,
});

/** A kernel's own rejection, surfaced UNCHANGED under the kernel's own layer.
 *  Flattening it into a daemon code would leave a reviewer unable to tell a
 *  fencing refusal from a malformed row; they demand opposite repairs. The layer
 *  is a PARAMETER because two kernels refuse on this path and their shared code
 *  vocabulary cannot tell them apart — see `SCHEDULER_PROVIDER_SLOT_RELEASE`. */
function carryRejection(
  rejection: AuthorityRejection, refusedBy: AttemptReleaseLayer,
): AttemptReleaseRefused {
  const issue = rejection.issues[0];
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const,
    code: issue?.code ?? "AUTHORITY_MALFORMED_INPUT",
    message: issue?.message ?? null, ok: false as const, refusedBy,
  });
}

/** `releaseWork`'s refusal: the lease could not be drained. Both carriers stay
 *  HOISTED declarations, as this one always was — a const-initialised export
 *  reached during another module's evaluation is a temporal-dead-zone crash
 *  rather than a type error, which is the hazard this file's header names. */
export function carryAuthorityRejection(rejection: AuthorityRejection): AttemptReleaseRefused {
  return carryRejection(rejection, SCHEDULER_LEASE_DRAIN);
}

/** `releaseProviderSlot`'s refusal: the lease drained, the SLOT would not go. */
export function carrySlotRejection(rejection: AuthorityRejection): AttemptReleaseRefused {
  return carryRejection(rejection, SCHEDULER_PROVIDER_SLOT_RELEASE);
}

/** The safe-boundary producer's refusal, under ITS layer with ITS code, and its
 *  `upstreamCode` kept as the message so the ORIGINAL refuser — the provider-run
 *  reader, the codec or the store — survives two hops instead of one. */
export function carryBoundaryRefusal(refusal: SafeBoundaryRefused): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code: refusal.code,
    message: refusal.upstreamCode, ok: false as const, refusedBy: refusal.layer,
  });
}

/** The terminality producer's refusal, under ITS layer with ITS code, its
 *  upstream's code kept as the message so the ORIGINAL refuser survives two hops. */
export function carryTerminalRefusal(refusal: ReleaseTerminalRefusal): AttemptReleaseRefused {
  return Object.freeze({
    advisoryOnly: true as const, authority: "NONE" as const, code: refusal.code,
    message: refusal.upstream?.code ?? null, ok: false as const, refusedBy: refusal.layer,
  });
}

/** Re-states a durable answer under the outcome THIS call earned. The row is
 *  passed through byte-identically; only the caller-facing outcome changes. */
export const withOutcome = (
  answer: AttemptReleaseAnswer, outcome: AttemptReleaseOutcomeName,
): AttemptReleaseAnswer => Object.freeze({ ...answer, outcome });

/** Framed by this record version, as the dispatch aggregate is framed by its
 *  own. The row may NOT share the activation aggregate: that stream is read by
 *  a strict exactly-one-plus-ordered-tail reader, and an event of an unexpected
 *  type there would make the activation itself unreadable. */
export function deriveAttemptReleaseAggregateId(attemptAggregateId: string): string {
  const framed =
    `${ATTEMPT_RELEASE_RECORD_VERSION}\n${attemptAggregateId.length}\n${attemptAggregateId}`;
  return `attempt-release-${sha256Hex(encoder.encode(framed))}`;
}

/** The activation as the STORE holds it, never as the caller describes it. */
export function durableActivation(
  store: SqliteEventStore, bound: FoundationAttemptBound,
): ActivationLedgerRecord | AttemptReleaseRefused {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(bound.aggregateId); }
  catch { return refuse("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE"); }
  const history = readFoundationActivationHistory(bound.aggregateId, events, bound.projectId);
  return history.ok ? history.history.record : refuse("ATTEMPT_RELEASE_ACTIVATION_UNREADABLE");
}

/** Identity only. States are deliberately absent: a caller that could make its
 *  claimed lease state part of the agreement test could refuse the durable one. */
export function sameActivation(
  left: ActivationLedgerRecord, right: ActivationLedgerRecord,
): boolean {
  return left.activationDigest === right.activationDigest
    && left.grant.grantId === right.grant.grantId
    && left.grant.wrapperIdentity === right.grant.wrapperIdentity
    && left.effectIntent.intentId === right.effectIntent.intentId
    && left.attempt.attemptId === right.attempt.attemptId;
}

export function commitRelease(
  store: SqliteEventStore, bound: FoundationAttemptBound, bytes: Uint8Array, eventId: string,
): boolean {
  const { commandId, principalId, projectId } = bound;
  try { // expectedVersion 0: a second release on this aggregate cannot append.
    const written = store.commitExpectedVersionDecision({
      commandKind: ATTEMPT_RELEASE_COMMAND_KIND, committedResultBytes: bytes,
      correlationId: `${bound.correlationId}:RELEASED`, decidedAt: new Date().toISOString(),
      events: [{ eventId, eventType: ATTEMPT_RELEASE_EVENT_TYPE, payload: bytes }],
      expectedVersion: 0, key: { commandId: `${commandId}:RELEASED`, principalId, projectId },
      requestBytes: bytes, targetAggregateId: deriveAttemptReleaseAggregateId(bound.aggregateId),
    });
    return written.decision.effectDisposition === "EFFECTS_COMMITTED";
  } catch { return false; }
}

/** The durable answer, always from re-decoded bytes that still re-encode. The
 *  reported outcome is the ROW's own recorded one: a reader states what the
 *  stored release was, never what a later call would decide. */
export function readAttemptRelease(
  store: SqliteEventStore, attemptAggregateId: string,
): AttemptReleaseOutcome {
  let events: readonly StoredEvent[];
  try { events = store.readEvents(deriveAttemptReleaseAggregateId(attemptAggregateId)); }
  catch { return refuse("ATTEMPT_RELEASE_RECORD_UNREADABLE"); }
  const found = events.filter((event) => event.eventType === ATTEMPT_RELEASE_EVENT_TYPE);
  if (found.length > 1) return refuse("ATTEMPT_RELEASE_RECORD_AMBIGUOUS");
  const event = found[0];
  if (event === undefined) return refuse("ATTEMPT_RELEASE_RECORD_ABSENT");
  const decoded = decodeFoundationPayload(event.payload);
  if (!decoded.ok) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  const again = encodeFoundationPayload(decoded.value);
  if (!again.ok || !sameBytes(again.bytes, event.payload)) {
    return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  }
  // Re-read through the frozen vocabulary: a row carrying an outcome no kernel
  // ever answered would otherwise be handed on as if a kernel had.
  const stored = decoded.value["outcome"];
  const outcome = ATTEMPT_RELEASE_OUTCOMES.find((name) => name === stored);
  if (outcome === undefined) return refuse("ATTEMPT_RELEASE_RECORD_DRIFT");
  return Object.freeze({
    advisoryOnly: true as const, authority: "ADVISORY_RECORD" as const, digest: again.digest,
    ok: true as const, outcome, record: Object.freeze(decoded.value),
  });
}
