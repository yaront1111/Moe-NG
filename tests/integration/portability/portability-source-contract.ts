export const PORTABILITY_EVIDENCE_LAYER = "PORTABILITY_EVIDENCE" as const;

/** Stable refusal codes shared by current and historical evidence readers. */
export const SOURCE_COMMIT_CODES = Object.freeze({
  absent: "PORTABILITY_SOURCE_COMMIT_ABSENT",
  checkoutDirty: "PORTABILITY_SOURCE_CHECKOUT_DIRTY",
  checkoutMismatch: "PORTABILITY_SOURCE_COMMIT_CHECKOUT_MISMATCH",
  malformed: "PORTABILITY_SOURCE_COMMIT_MALFORMED",
  observationFailed: "PORTABILITY_SOURCE_CHECKOUT_OBSERVATION_FAILED",
  pinUnreadable: "PORTABILITY_SOURCE_COMMIT_PIN_UNREADABLE",
  repositoryMismatch: "PORTABILITY_SOURCE_REPOSITORY_MISMATCH",
} as const);

export type SourceCommitCode = (typeof SOURCE_COMMIT_CODES)[keyof typeof SOURCE_COMMIT_CODES];

export interface SourceCommitRefused {
  readonly code: SourceCommitCode;
  readonly layer: typeof PORTABILITY_EVIDENCE_LAYER;
  readonly ok: false;
}

export function refuseSourceCommit(code: SourceCommitCode): SourceCommitRefused {
  return Object.freeze({ code, layer: PORTABILITY_EVIDENCE_LAYER, ok: false as const });
}
