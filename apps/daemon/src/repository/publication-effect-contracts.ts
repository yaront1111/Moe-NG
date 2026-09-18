import type { PublicationCandidate, PublicationRefusal } from "./publication-approval-contracts.js";

export interface PublicationGitPort {
  /** Only the immutable approved SHA is eligible for transmission. */
  push(candidate: PublicationCandidate): Promise<Readonly<{ ok: true }> | PublicationRefusal>;
  observe(candidate: PublicationCandidate): Promise<Readonly<{ ok: true; sha: string | null }> | PublicationRefusal>;
  /**
   * Pre-flight, before any intent is journaled: is `remoteSha` (the observed remote tip) an
   * ancestor of, or equal to, the approved sha in the candidate's own repository? `known`
   * is false when the repository holds no such object at all — an operator's commits pushed
   * behind Moe's back — and such a tip is therefore not contained. A null tip (branch absent
   * on the remote) is a fast-forward.
   */
  contains(candidate: PublicationCandidate, remoteSha: string | null): Promise<Readonly<{ ok: true; contains: boolean; known: boolean }> | PublicationRefusal>;
}

export interface PublicationEffectIntent {
  readonly version: "moe-publication-intent/1";
  readonly projectId: string;
  readonly goalId: string;
  readonly decisionId: string;
  readonly candidate: PublicationCandidate;
  readonly ownerDigest: string;
  readonly reservationRevision: number;
  readonly controllerId: string;
  readonly intendedAt: string;
}
