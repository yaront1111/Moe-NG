/**
 * Lease record parsing and the design-749 fencing check.
 *
 * Every authoritative mutation in this subtree routes through
 * `fenceAuthority`, so a new command cannot accidentally skip a check.
 */
import {
  LEASE_KINDS,
  LEASE_STATES,
  MAX_AUTHORITY_COUNT,
  RENEWAL_WINDOW_SECONDS,
  deepFreeze,
  exactRecord,
  isCount,
  isDigest,
  isRef,
  makeIssue,
  malformed,
  oneOf,
  reject,
  type AuthorityErrorCode,
  type AuthorityProof,
  type AuthorityRejection,
  type ClockObservation,
  type LeaseRecord,
  type LeaseState,
  type RejectionSecurityRecord,
} from "./authority-kernel.js";

const LEASE_KEYS = [
  "leaseId", "kind", "ownerSessionRef", "leaseToken", "epoch", "state", "serverWallDeadline",
  "bootId", "monotonicObservation", "authorityHashRef", "version",
] as const;
const PROOF_KEYS = [
  "leaseToken", "epoch", "authorityHashRef", "ownerSessionRef", "expectedVersion",
] as const;
const CLOCK_KEYS = ["serverWallSeconds", "bootId", "monotonicObservation"] as const;

export function parseLeaseRecord(value: unknown): LeaseRecord | null {
  const parsed = exactRecord(value, LEASE_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["leaseId"]) || !oneOf(parsed["kind"], LEASE_KINDS)) return null;
  if (!isRef(parsed["ownerSessionRef"]) || !isRef(parsed["leaseToken"])) return null;
  if (!isCount(parsed["epoch"]) || !oneOf(parsed["state"], LEASE_STATES)) return null;
  if (!isCount(parsed["serverWallDeadline"]) || !isRef(parsed["bootId"])) return null;
  if (!isCount(parsed["monotonicObservation"]) || !isCount(parsed["version"])) return null;
  if (!isDigest(parsed["authorityHashRef"])) return null;
  return parsed as unknown as LeaseRecord;
}

export function parseProof(value: unknown): AuthorityProof | null {
  const parsed = exactRecord(value, PROOF_KEYS);
  if (parsed === null) return null;
  if (!isRef(parsed["leaseToken"]) || !isCount(parsed["epoch"])) return null;
  if (!isRef(parsed["ownerSessionRef"]) || !isCount(parsed["expectedVersion"])) return null;
  if (!isDigest(parsed["authorityHashRef"])) return null;
  return parsed as unknown as AuthorityProof;
}

/** The observation is capped so `serverWallSeconds + RENEWAL_WINDOW_SECONDS`, the
 * deadline this kernel derives from it, still parses as a counter. */
export function parseClock(value: unknown): ClockObservation | null {
  const parsed = exactRecord(value, CLOCK_KEYS);
  if (parsed === null) return null;
  if (!isCount(parsed["serverWallSeconds"]) || !isRef(parsed["bootId"])) return null;
  if (!isCount(parsed["monotonicObservation"])) return null;
  if (parsed["serverWallSeconds"] > MAX_AUTHORITY_COUNT - RENEWAL_WINDOW_SECONDS) return null;
  return parsed as unknown as ClockObservation;
}

function securityRecord(
  lease: LeaseRecord,
  proof: AuthorityProof,
  code: AuthorityErrorCode,
  commandKind: string,
): RejectionSecurityRecord {
  return deepFreeze({
    aggregateKind: "LEASE" as const, code, commandKind, leaseId: lease.leaseId,
    sourceState: lease.state, expectedEpoch: lease.epoch, observedEpoch: proof.epoch,
  });
}

export type Fenced =
  | { readonly ok: true; readonly lease: LeaseRecord; readonly proof: AuthorityProof }
  | { readonly ok: false; readonly rejection: AuthorityRejection };

/**
 * Design line 749, in the published check order: token, epoch, authority hash,
 * session, (capability — out of scope for a dependency-free reducer), version,
 * lease state. The first failing check decides the code, so one rejected
 * command never reports two causes and the outcome stays deterministic.
 *
 * A syntactically invalid attempt is NOT a security event: it yields plain
 * `AUTHORITY_MALFORMED_INPUT` with no record, because design line 749 reserves
 * the redacted event for authenticated, syntactically valid attempts.
 */
export function fenceAuthority(
  record: unknown,
  authority: unknown,
  commandKind: string,
  legalStates: readonly LeaseState[],
): Fenced {
  const lease = parseLeaseRecord(record);
  const proof = parseProof(authority);
  if (lease === null || proof === null) {
    return {
      ok: false,
      rejection: malformed(`${commandKind} received a malformed authority shape`),
    };
  }
  // A record at the counter ceiling still parses and can still be read, but it
  // may not be mutated: emitting a successor above the ceiling would produce a
  // record that never parses again, leaving the lease unrevocable. Refusing
  // explicitly is the fail-closed reading; it is a property of the record, not
  // of the attempt, so it carries no security event.
  if (lease.version >= MAX_AUTHORITY_COUNT || lease.epoch >= MAX_AUTHORITY_COUNT) {
    return { ok: false, rejection: malformed(`${commandKind} found an exhausted lease counter`) };
  }
  const fail = (code: AuthorityErrorCode, message: string): Fenced => ({
    ok: false,
    rejection: reject([makeIssue(code, message)], securityRecord(lease, proof, code, commandKind)),
  });
  if (proof.leaseToken !== lease.leaseToken) {
    return fail("AUTHORITY_STALE_LEASE", "lease token is not current");
  }
  if (proof.epoch !== lease.epoch) {
    return proof.epoch < lease.epoch && lease.state === "REVOKED"
      ? fail("AUTHORITY_SUPERSEDED_AUTHORITY", "authority was superseded by a revocation epoch")
      : fail("AUTHORITY_STALE_EPOCH", "lease epoch is not current");
  }
  if (proof.authorityHashRef !== lease.authorityHashRef) {
    return fail("AUTHORITY_STALE_LEASE", "authority hash does not bind this lease");
  }
  if (proof.ownerSessionRef !== lease.ownerSessionRef) {
    return fail("AUTHORITY_STALE_LEASE", "session does not own this lease");
  }
  if (proof.expectedVersion !== lease.version) {
    return fail("AUTHORITY_STALE_LEASE", "lease record version is stale");
  }
  if (!legalStates.includes(lease.state)) {
    return fail("AUTHORITY_STALE_LEASE", `lease state ${lease.state} cannot accept ${commandKind}`);
  }
  return { ok: true, lease, proof };
}
