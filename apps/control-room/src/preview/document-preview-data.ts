import { DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION } from "@moe/contracts";
import type { DocumentWorkProposal } from "@moe/contracts";

import { documentDossierStateFromProposal } from "./document-dossier-state.js";

const PREVIEW_SOURCES = Object.freeze([
  Object.freeze({
    byteLength: 734,
    contentSha256: "1".repeat(64),
    displayPath: "docs/incidents/stale-port.md",
    sourceRef: "incident-note",
  }),
  Object.freeze({
    byteLength: 936,
    contentSha256: "2".repeat(64),
    displayPath: "docs/acceptance/recovery.md",
    sourceRef: "recovery-acceptance",
  }),
  Object.freeze({
    byteLength: 1182,
    contentSha256: "3".repeat(64),
    displayPath: "docs/contracts/startup-ownership.md",
    sourceRef: "startup-contract",
  }),
]);

const PREVIEW_CANDIDATES = Object.freeze([
  Object.freeze({
    candidateRef: "recovery-contract",
    objective: "Specify stale ownership recovery without granting startup authority.",
    sourceRefs: Object.freeze(["incident-note", "startup-contract"]),
    title: "Write the recovery contract",
  }),
  Object.freeze({
    candidateRef: "stale-recovery-proof",
    objective: "Verify stale record recovery while preserving a live port owner.",
    sourceRefs: Object.freeze(["incident-note", "recovery-acceptance"]),
    title: "Prove stale-record recovery",
  }),
  Object.freeze({
    candidateRef: "startup-ownership",
    objective: "Check live port ownership before reclaiming a stale startup record.",
    sourceRefs: Object.freeze(["recovery-acceptance", "startup-contract"]),
    title: "Guard startup ownership",
  }),
]);

/** Exact deterministic input for the preview; it has the public proposal shape. */
export const PREVIEW_DOCUMENT_WORK_PROPOSAL: DocumentWorkProposal = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  candidates: PREVIEW_CANDIDATES,
  contextManifestDigest: `9c2d${"0".repeat(60)}`,
  projectId: "stale-port-recovery",
  repositoryBaseHash: `7f3a${"0".repeat(60)}`,
  schemaVersion: DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION,
  sources: PREVIEW_SOURCES,
  submissionState: "NOT_SUBMITTED",
  truthClass: "AGENT_REPORTED",
});

/** The fixture crosses the same deterministic adapter seam intended for daemon results. */
export const PREVIEW_DOCUMENT_DOSSIER_STATE = documentDossierStateFromProposal({
  dossierIdentity: "sample/docs@7f3a:stale-port-recovery",
  origin: "FIXTURE",
  proposal: PREVIEW_DOCUMENT_WORK_PROPOSAL,
});
