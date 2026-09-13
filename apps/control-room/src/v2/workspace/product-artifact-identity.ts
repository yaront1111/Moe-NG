import { sameProductContract } from "@moe/control-room-model";
import type { ProductArtifact } from "@moe/control-room-model";
import type { ProductArtifactReads } from "./product-artifact-history.js";
import { productArtifacts } from "./product-model-artifacts.js";

/** Reconstruct identity from decoded bytes. Artifact IDs are opaque and are never parsed. */
export function productArtifactPayloadMatches(artifact: ProductArtifact, reads: ProductArtifactReads): boolean {
  if (artifact.availability !== "PRESENT" && artifact.availability !== "STALE") return false;
  const candidates = productArtifacts({ ...reads, scope: artifact.scope, goalRef: artifact.scope.goalId,
    planningRunRef: null, coverage: null, criteria: null }, null, null);
  return candidates.some((candidate) => candidate.id === artifact.id && candidate.kind === artifact.kind
    && candidate.availability === "PRESENT" && candidate.sha === artifact.sha
    && (artifact.kind !== "DESIGN" || sameProductContract(candidate.contractRef, artifact.contractRef)));
}
