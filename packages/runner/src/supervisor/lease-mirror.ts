import { deepFreeze } from "../canonical.js";
import {
  supervisorFailure,
  type SupervisorErrorCode,
  type SupervisorFailure,
} from "./effect-kernel.js";
import {
  MAX_SUPERVISOR_COUNT,
  parseMirroredLease,
  parseMirroredProof,
  type MirroredLeaseProof,
  type MirroredLeaseRecord,
  type MirroredLeaseState,
} from "./effect-shape.js";

/**
 * The lease fence, re-derived over the structurally mirrored record.
 *
 * `@moe/runner` cannot import `@moe/scheduler`, so this is a clone rather than a
 * call. It is deliberately a RE-VALIDATION and not a shape cast: comparing a
 * token and an epoch on an unparsed object would accept records the scheduler's
 * own parser refuses, and a fence that accepts what the authority rejects is a
 * fencing bypass, not a convenience.
 *
 * Check order is the scheduler's published one — token, epoch, authority hash,
 * session, version, state — with a malformed shape answered first and plainly.
 * A syntactically invalid attempt is not a security event, so its refusal
 * carries no detail beyond the command that was attempted.
 *
 * REDACTION: no refusal here names the lease token. The scheduler redacts it in
 * its security record and this mirror must not become the nearer leak.
 *
 * The verdict-EQUALITY drift test against the real `fenceAuthority` cannot live
 * in this package; it is deferred to the daemon package in child 4, which will
 * depend on both. What ships here is hostile-fixture parity.
 */
export type MirrorVerdict =
  | {
      readonly kind: "FENCED";
      readonly ok: true;
      readonly lease: MirroredLeaseRecord;
      readonly proof: MirroredLeaseProof;
    }
  | { readonly kind: "REFUSED"; readonly failure: SupervisorFailure };

function refuse(
  code: SupervisorErrorCode,
  message: string,
  state: string | null,
  commandKind: string,
): MirrorVerdict {
  return Object.freeze({
    kind: "REFUSED" as const,
    failure: supervisorFailure(code, "LEASE_MIRROR", message, {
      state,
      command: commandKind,
      leg: null,
    }),
  });
}

export function fenceMirroredLease(
  record: unknown,
  authority: unknown,
  commandKind: string,
  legalStates: readonly MirroredLeaseState[],
): MirrorVerdict {
  const lease = parseMirroredLease(record);
  const proof = parseMirroredProof(authority);
  if (lease === null || proof === null) {
    return refuse(
      "LEASE_MIRROR_MALFORMED",
      `${commandKind} received a malformed authority shape`,
      null,
      commandKind,
    );
  }
  // A record at the counter ceiling still reads, but it may not be mutated: a
  // successor above the ceiling would never parse again, leaving the lease
  // unrevocable. That is a property of the record, not of the attempt, so it
  // carries no security detail either.
  if (lease.version >= MAX_SUPERVISOR_COUNT || lease.epoch >= MAX_SUPERVISOR_COUNT) {
    return refuse(
      "LEASE_MIRROR_MALFORMED",
      `${commandKind} found an exhausted lease counter`,
      null,
      commandKind,
    );
  }
  const no = (code: SupervisorErrorCode, message: string): MirrorVerdict =>
    refuse(code, message, lease.state, commandKind);
  if (proof.leaseToken !== lease.leaseToken) {
    return no("LEASE_MIRROR_STALE", "lease token is not current");
  }
  if (proof.epoch !== lease.epoch) {
    return proof.epoch < lease.epoch && lease.state === "REVOKED"
      ? no("LEASE_MIRROR_SUPERSEDED_AUTHORITY", "authority was superseded by a revocation epoch")
      : no("LEASE_MIRROR_STALE_EPOCH", "lease epoch is not current");
  }
  if (proof.authorityHashRef !== lease.authorityHashRef) {
    return no("LEASE_MIRROR_STALE", "authority hash does not bind this lease");
  }
  if (proof.ownerSessionRef !== lease.ownerSessionRef) {
    return no("LEASE_MIRROR_STALE", "session does not own this lease");
  }
  if (proof.expectedVersion !== lease.version) {
    return no("LEASE_MIRROR_STALE", "lease record version is stale");
  }
  if (!legalStates.includes(lease.state)) {
    return no("LEASE_MIRROR_STALE", `lease state ${lease.state} cannot accept ${commandKind}`);
  }
  return deepFreeze({ kind: "FENCED" as const, ok: true as const, lease, proof });
}
