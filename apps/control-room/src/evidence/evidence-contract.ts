import type { AdvisoryMessage, AdvisoryReceipt } from "../data/data-contract.js";
import type { TimelineProvenance } from "../timeline/timeline-contract.js";

/**
 * The §2.9 receipt as the daemon states it.
 *
 * Every field is required-and-nullable rather than optional, because
 * `exactOptionalPropertyTypes` is on and an unstated fact must be representable as ABSENT
 * rather than as a key nobody wrote. No field here is computed, and there is deliberately
 * no "passed", "healthy", or "score" field: those would be this layer's opinion of
 * evidence it is only allowed to display.
 *
 * Provenance reuses the timeline's vocabulary rather than declaring a second one, so
 * actor/session/effect/command/aggregate mean exactly the same thing on both surfaces.
 */

export interface EvidenceRecipe {
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly envFingerprint: string | null;
}

export interface EvidenceRun {
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
}

export interface EvidenceOutput {
  readonly digest: string | null;
  readonly tail: string | null;
}

export interface EvidenceArtifactDigest {
  readonly artifactId: string;
  readonly digest: string | null;
}

export interface EvidenceTree {
  readonly baseSha: string | null;
  readonly dirtyTreeDigest: string | null;
  readonly headSha: string | null;
}

export interface EvidenceReceiptRecord {
  readonly artifacts: readonly EvidenceArtifactDigest[];
  readonly output: EvidenceOutput;
  readonly provenance: TimelineProvenance;
  readonly receiptId: string;
  readonly recipe: EvidenceRecipe;
  readonly run: EvidenceRun;
  readonly tree: EvidenceTree;
  readonly truthClass: unknown;
}

/**
 * A comparison the DAEMON performed, carrying the daemon's own word for the outcome.
 * This app never compares two digests itself; doing so would be deriving evidence
 * strength from values it is only permitted to display.
 */
export interface EvidenceComparison {
  readonly againstReceiptId: string;
  readonly statedOutcome: string | null;
}

/** §8.2: a refusal names its stable code and the layer that produced it. */
export interface EvidenceRejection {
  readonly detail: string | null;
  readonly reasonCode: string | null;
  readonly refusedLayer: string | null;
}

/**
 * One typed session message and the receipt it produced. The receipt is the existing
 * `AdvisoryReceipt` — `advisoryOnly: true`, `authority: "NONE"` — which is precisely the
 * mechanism that keeps a session message visible without letting it become authority.
 */
export interface EvidenceSessionEntry {
  readonly message: AdvisoryMessage;
  readonly receipt: AdvisoryReceipt;
}
