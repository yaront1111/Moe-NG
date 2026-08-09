import { fenceAuthority } from "@moe/scheduler";

import { refused, workFailure } from "./work-kernel.js";
import type { WorkFailure, WorkResult } from "./work-kernel.js";

/**
 * The single lease-authority gate for every work command.
 *
 * `fenceAuthority` is the sole decider of refuse-or-not — this module never
 * independently concludes that a lease is invalid. It only CLASSIFIES a
 * rejection that already happened, because `AUTHORITY_STALE_LEASE` covers four
 * distinct causes (token, authority hash, session, record version) and DoD 3
 * requires stale-token and stale-epoch to be separately assertable. The
 * upstream code is preserved verbatim on every failure.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyLeaseRejection(
  issues: readonly { readonly code: string; readonly message: string }[],
  record: Record<string, unknown>,
  proof: Record<string, unknown>,
): WorkFailure {
  const issue = issues[0];
  const upstream = issue?.code ?? null;
  const message = issue?.message ?? "lease authority was refused";
  if (upstream === "AUTHORITY_MALFORMED_INPUT") {
    return workFailure("WORK_PAYLOAD_MALFORMED", "lease", "AUTHORITY", message, upstream);
  }
  if (upstream === "AUTHORITY_SUPERSEDED_AUTHORITY") {
    return workFailure("WORK_AUTHORITY_SUPERSEDED", "lease", "AUTHORITY", message, upstream);
  }
  if (upstream === "AUTHORITY_STALE_EPOCH") {
    return workFailure("WORK_STALE_EPOCH", "lease", "AUTHORITY", message, upstream);
  }
  const staleToken = proof["leaseToken"] !== record["leaseToken"];
  return workFailure(
    staleToken ? "WORK_STALE_TOKEN" : "WORK_LEASE_NOT_CURRENT",
    "lease",
    "AUTHORITY",
    message,
    upstream,
  );
}

export type LeaseGate =
  | { readonly ok: true; readonly lease: Record<string, unknown> }
  | { readonly ok: false; readonly result: WorkResult };

/**
 * Revalidates the caller's proof against the current record through the
 * scheduler fencing surface. Every mutation routes through here, so a handler
 * cannot accidentally skip the design-749 check order.
 */
export function fenceWorkLease(
  lease: Record<string, unknown>,
  commandKind: string,
  legalStates: readonly string[],
): LeaseGate {
  const record = lease["record"];
  const proof = lease["proof"];
  const fenced = fenceAuthority(record, proof, commandKind, legalStates as never);
  if (fenced.ok) return { lease: fenced.lease as unknown as Record<string, unknown>, ok: true };
  return {
    ok: false,
    result: refused(
      classifyLeaseRejection(
        fenced.rejection.issues,
        isRecord(record) ? record : {},
        isRecord(proof) ? proof : {},
      ),
    ),
  };
}
