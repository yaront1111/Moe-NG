/**
 * Lease authority transitions (design 12.2, lines 741-751).
 *
 * Pure, deterministic reducers over caller-supplied observations. The module
 * mints no clock and no randomness: every wall/monotonic/boot fact arrives as a
 * `ClockObservation`, so replay and restart reproduce identical results.
 *
 * State machine (design 743-745):
 *   ACTIVE -> SUSPECT -> ACTIVE
 *   ACTIVE | SUSPECT -> DRAINING -> RELEASED | REVOKED   (see ./lease-drain.ts)
 *   ACTIVE | SUSPECT | DRAINING -> REVOKED               (privileged)
 */
import {
  DRAIN_REASONS,
  MAX_AUTHORITY_ITEMS,
  RENEWAL_WINDOW_SECONDS,
  RENEW_AFTER_SECONDS,
  accept,
  compareStrings,
  deepFreeze,
  isRef,
  malformed,
  oneOf,
  readList,
  type AuthorityOutcome,
  type ClockObservation,
  type DrainReason,
  type LeaseKind,
  type LeaseRecord,
} from "./authority-kernel.js";
import { fenceAuthority, parseClock, parseLeaseRecord } from "./lease-fencing.js";

export type {
  AuthorityErrorCode, AuthorityIssue, AuthorityOutcome, AuthorityProof, AuthorityRejection,
  ClockObservation, DrainReason, LeaseKind, LeaseRecord, LeaseState, RejectionSecurityRecord,
  TruthClass,
} from "./authority-kernel.js";
export {
  DRAIN_REASONS, DRAIN_REASON_RANKS, LEASE_KINDS, LEASE_STATES, MAX_AUTHORITY_COUNT,
  MAX_AUTHORITY_ITEMS, RENEWAL_WINDOW_SECONDS, RENEW_AFTER_SECONDS, TRUTH_CLASSES,
} from "./authority-kernel.js";

export interface LeaseRenewal {
  readonly lease: LeaseRecord;
  readonly renewAfterSeconds: number;
}
export interface SuspectEvent {
  readonly leaseId: string;
  readonly kind: LeaseKind;
  readonly observedAtSeconds: number;
  readonly bootId: string;
  readonly monotonicObservation: number;
  readonly dueDeadlineSeconds: number;
}
export interface LeaseSuspicion {
  readonly lease: LeaseRecord;
  readonly event: SuspectEvent;
}
export interface LeaseExtension {
  readonly lease: LeaseRecord;
  readonly reason: string;
}
export interface LeaseRevocation {
  readonly lease: LeaseRecord;
  readonly reason: DrainReason;
}
export interface RestartReconstruction {
  readonly bootId: string;
  readonly observedAtSeconds: number;
  readonly overdue: readonly SuspectEvent[];
}

function advance(lease: LeaseRecord, patch: Partial<LeaseRecord>): LeaseRecord {
  return deepFreeze({ ...lease, ...patch, version: lease.version + 1 });
}

/**
 * Dueness is a server-wall fact only. The stored boot id scopes the monotonic
 * observation, so a daemon restart alone must never make a live lease due —
 * that would mark every ACTIVE lease SUSPECT on every restart.
 */
function isOverdue(lease: LeaseRecord, clock: ClockObservation): boolean {
  return clock.serverWallSeconds > lease.serverWallDeadline;
}

function suspectEvent(lease: LeaseRecord, clock: ClockObservation): SuspectEvent {
  return deepFreeze({
    leaseId: lease.leaseId, kind: lease.kind, observedAtSeconds: clock.serverWallSeconds,
    bootId: clock.bootId, monotonicObservation: clock.monotonicObservation,
    dueDeadlineSeconds: lease.serverWallDeadline,
  });
}

function renewed(lease: LeaseRecord, clock: ClockObservation): LeaseRecord {
  return advance(lease, {
    state: "ACTIVE", serverWallDeadline: clock.serverWallSeconds + RENEWAL_WINDOW_SECONDS,
    bootId: clock.bootId, monotonicObservation: clock.monotonicObservation,
  });
}

/** The owner's liveness path. `SUSPECT -> ACTIVE` is reached only from here. */
export function fencedRenew(
  record: unknown,
  authority: unknown,
  observation: unknown,
): AuthorityOutcome<LeaseRenewal> {
  const fenced = fenceAuthority(record, authority, "fencedRenew", ["ACTIVE", "SUSPECT"]);
  if (!fenced.ok) return fenced.rejection;
  const clock = parseClock(observation);
  if (clock === null) return malformed("fencedRenew received a malformed clock observation");
  return accept({
    lease: renewed(fenced.lease, clock),
    renewAfterSeconds: RENEW_AFTER_SECONDS,
  });
}

/**
 * A timer has no authority (design 751): the caller must present a due
 * observation, and the durable artefact is the returned observation event.
 */
export function markSuspect(
  record: unknown,
  authority: unknown,
  observation: unknown,
): AuthorityOutcome<LeaseSuspicion> {
  const fenced = fenceAuthority(record, authority, "markSuspect", ["ACTIVE"]);
  if (!fenced.ok) return fenced.rejection;
  const clock = parseClock(observation);
  if (clock === null) return malformed("markSuspect received a malformed clock observation");
  if (!isOverdue(fenced.lease, clock)) return malformed("lease renewal window has not elapsed");
  return accept({
    lease: advance(fenced.lease, { state: "SUSPECT" }),
    event: suspectEvent(fenced.lease, clock),
  });
}

/** The human-side recovery path: wait, extend, or confirm revocation. */
export function extend(
  record: unknown,
  authority: unknown,
  observation: unknown,
  reason: unknown,
): AuthorityOutcome<LeaseExtension> {
  const fenced = fenceAuthority(record, authority, "extend", ["ACTIVE", "SUSPECT"]);
  if (!fenced.ok) return fenced.rejection;
  const clock = parseClock(observation);
  if (clock === null) return malformed("extend received a malformed clock observation");
  if (!isRef(reason)) return malformed("extend requires a human-supplied reason");
  return accept({ lease: renewed(fenced.lease, clock), reason });
}

/**
 * Privileged revocation. Together with successor claim (owned by `work.claim`)
 * this is the only transition that moves the epoch, and it moves it by exactly
 * one, so two stale commands can never both mint the same successor.
 */
export function confirmRevoke(
  record: unknown,
  authority: unknown,
  reason: unknown,
): AuthorityOutcome<LeaseRevocation> {
  const fenced = fenceAuthority(record, authority, "confirmRevoke",
    ["ACTIVE", "SUSPECT", "DRAINING"]);
  if (!fenced.ok) return fenced.rejection;
  if (!oneOf(reason, DRAIN_REASONS)) return malformed("confirmRevoke requires a drain reason");
  return accept({
    lease: advance(fenced.lease, { state: "REVOKED", epoch: fenced.lease.epoch + 1 }),
    reason,
  });
}

/**
 * Restart re-observation (design 751). Pure: it commits nothing and returns the
 * overdue suspect observations the caller must commit through `markSuspect`
 * before scheduling resumes.
 */
export function restartReconstruct(
  records: unknown,
  observation: unknown,
): AuthorityOutcome<RestartReconstruction> {
  const clock = parseClock(observation);
  if (clock === null) return malformed("restartReconstruct received a malformed observation");
  const items = readList(records, MAX_AUTHORITY_ITEMS);
  if (items === null) return malformed("restartReconstruct requires a bounded lease list");
  const overdue: SuspectEvent[] = [];
  for (const item of items) {
    const lease = parseLeaseRecord(item);
    if (lease === null) return malformed("restartReconstruct received a malformed lease");
    if (lease.state === "ACTIVE" && isOverdue(lease, clock)) {
      overdue.push(suspectEvent(lease, clock));
    }
  }
  overdue.sort((left, right) => compareStrings(left.leaseId, right.leaseId));
  return accept({
    bootId: clock.bootId, observedAtSeconds: clock.serverWallSeconds,
    overdue: deepFreeze(overdue),
  });
}
