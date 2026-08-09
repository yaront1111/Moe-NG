import type { MirroredLeaseKind, MirroredLeaseState } from "@moe/runner";
import type { AuthorityErrorCode, LeaseKind, LeaseState } from "@moe/scheduler";

/**
 * The shared lease table the supervisor mirror and the scheduler authority are
 * compared over.
 *
 * `@moe/runner` depends only on `@moe/contracts`, so `lease-mirror.ts` clones
 * the design-749 fence rather than calling it. A clone drifts silently; this
 * table exists so the drift is loud. Every expectation below is HAND-WRITTEN
 * from the published check order (token, epoch, authority hash, session,
 * version, state) and from the two parsers read side by side — never recorded
 * from a run, which could only ever agree with itself.
 */

const DIGEST_A = "a".repeat(64);

export const BASE_RECORD: Readonly<Record<string, unknown>> = Object.freeze({
  authorityHashRef: DIGEST_A,
  bootId: "boot-1",
  epoch: 3,
  kind: "ASSIGNMENT",
  leaseId: "lease-1",
  leaseToken: "token-1",
  monotonicObservation: 500,
  ownerSessionRef: "session-1",
  serverWallDeadline: 1_000,
  state: "ACTIVE",
  version: 7,
});

export const BASE_PROOF: Readonly<Record<string, unknown>> = Object.freeze({
  authorityHashRef: DIGEST_A,
  epoch: 3,
  expectedVersion: 7,
  leaseToken: "token-1",
  ownerSessionRef: "session-1",
});

export function leaseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_RECORD, ...overrides };
}

export function leaseProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_PROOF, ...overrides };
}

/**
 * Compile-time vocabulary parity in BOTH directions.
 *
 * `Record<LeaseState, MirroredLeaseState>` demands one key per scheduler state
 * and one mirrored state per value, so a state added on either side turns
 * `pnpm --filter @moe/daemon typecheck` red. Neither closed set is published as
 * a runtime array from `@moe/scheduler`, so the type system is the only place
 * the two names can be compared; the identity of each entry is asserted at
 * runtime by `work-races.test.ts` so a transposed pair cannot pass either.
 */
export const LEASE_STATE_PARITY: Readonly<Record<LeaseState, MirroredLeaseState>> = Object.freeze({
  ACTIVE: "ACTIVE",
  DRAINING: "DRAINING",
  RELEASED: "RELEASED",
  REVOKED: "REVOKED",
  SUSPECT: "SUSPECT",
});

export const LEASE_KIND_PARITY: Readonly<Record<LeaseKind, MirroredLeaseKind>> = Object.freeze({
  ASSIGNMENT: "ASSIGNMENT",
  RESOURCE: "RESOURCE",
  WORKSPACE: "WORKSPACE",
});

/**
 * `EQUAL` — both surfaces must return the same verdict, code and message.
 * `MIRROR_STRICTER` — the mirror refuses input the authority accepts, because
 * its `isRef` additionally demands well-formed NFC text within 400 chars. That
 * direction fails closed. The reverse direction is a fencing bypass and is
 * asserted never to occur anywhere in this table.
 */
export type DriftParity = "EQUAL" | "MIRROR_STRICTER";

export interface DriftCase {
  readonly name: string;
  readonly parity: DriftParity;
  readonly record: unknown;
  readonly proof: unknown;
  readonly commandKind: string;
  readonly legalStates: readonly string[];
  /** Hand-written authority verdict: a code, or `FENCED` when it accepts. */
  readonly authorityCode: AuthorityErrorCode | "FENCED";
  /** Hand-written refusal message; `null` when the case is accepted. */
  readonly message: string | null;
}
