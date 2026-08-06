export { CANONICAL_JSON_VERSION, canonicalize } from "./canonical-json.js";
export {
  EVIDENCE_IDENTITY_VERSION,
  identifyCanonicalEvidence,
  identifyEvidence,
  snapshotEvidenceBytes,
} from "./evidence-digest.js";
export type { CanonicalEvidenceIdentity, EvidenceIdentity } from "./evidence-digest.js";
export { capturePhase0Evidence } from "./phase0-evidence-capture.js";
export type {
  Phase0EvidenceCapturePort,
  Phase0EvidenceObjectLocation,
  Phase0HeadPathIdentity,
  Phase0PathAtCommitObservation,
  Phase0RawEvidenceObject,
  Phase0RawRepositorySnapshot,
  Phase0RawSourceFile,
} from "./phase0-evidence-capture.js";
export { verifyPhase0EvidenceManifest } from "./phase0-evidence-manifest-verifier.js";
export type {
  Phase0FreezeObjectReader,
  VerifiedPhase0EvidenceManifest,
} from "./phase0-evidence-manifest-verifier.js";
export { evaluatePhase0FreezeCandidate } from "./phase0-freeze-verifier.js";
export type {
  EvaluatePhase0FreezeCandidateInput,
  EvaluatedPhase0FreezeCandidate,
} from "./phase0-freeze-verifier.js";
export {
  createDefaultNodePhase0EvidenceCapturePort,
  createNodePhase0EvidenceCapturePort,
} from "./phase0-node-capture-port.js";
export type { NodePhase0EvidenceCapturePortOptions } from "./phase0-node-capture-port.js";
