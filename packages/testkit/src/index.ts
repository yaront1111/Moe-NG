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
