import type { PublicationCandidate, PublicationRefusal } from "./publication-approval-contracts.js";

export interface PublicationGitPort {
  /** Only the immutable approved SHA is eligible for transmission. */
  push(candidate: PublicationCandidate): Promise<Readonly<{ ok: true }> | PublicationRefusal>;
  observe(candidate: PublicationCandidate): Promise<Readonly<{ ok: true; sha: string | null }> | PublicationRefusal>;
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
