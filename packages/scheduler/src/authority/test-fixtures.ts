/**
 * Shared authority-kernel test fixtures.
 *
 * Mirrors `../test-fixtures.ts`: it lives under `src/` so `tsc` typechecks it,
 * but it carries no `.js` shim because nothing on the Node runtime entrypoint
 * path imports it (see `mem:gotcha-scheduler-js-shims`).
 */
import type { AuthorityProof, ClockObservation, LeaseRecord } from "./lease-state.js";
import type { ReleaseRequest } from "./lease-drain.js";

export const HASH = "a".repeat(64);
export const OTHER_HASH = "b".repeat(64);
export const DIGEST = "c".repeat(64);

export function lease(over: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    leaseId: "lease-1", kind: "ASSIGNMENT", ownerSessionRef: "session-1",
    leaseToken: "token-current", epoch: 3, state: "ACTIVE", serverWallDeadline: 1_000,
    bootId: "boot-1", monotonicObservation: 500, authorityHashRef: HASH, version: 7, ...over,
  };
}

export function proof(over: Partial<AuthorityProof> = {}): AuthorityProof {
  return {
    leaseToken: "token-current", epoch: 3, authorityHashRef: HASH,
    ownerSessionRef: "session-1", expectedVersion: 7, ...over,
  };
}

export function clock(over: Partial<ClockObservation> = {}): ClockObservation {
  return { serverWallSeconds: 960, bootId: "boot-1", monotonicObservation: 600, ...over };
}

export function handoff(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    completedSteps: ["step-1"], activeProcessResourceFacts: [], inputDigest: DIGEST,
    worktreeDigest: DIGEST, contextDigest: DIGEST, journalDigest: DIGEST,
    artifactDigest: DIGEST, nextSafeAction: "resume-step-2", truthClass: "DAEMON_VERIFIED",
    ...over,
  };
}

export function release(over: Partial<ReleaseRequest> = {}): ReleaseRequest {
  return {
    reason: "WORK_RELEASE_OR_PAUSE", safeBoundaryObserved: true, effectsTerminal: true,
    resourcesTerminal: true, handoff: handoff(), intentRefs: [], disposition: null, ...over,
  };
}
