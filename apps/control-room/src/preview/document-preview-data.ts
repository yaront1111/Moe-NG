import type {
  DocumentDossierCandidate,
  DocumentDossierReadyState,
  DocumentDossierSource,
} from "./document-dossier-state.js";

const PREVIEW_DOCUMENT_SOURCES: readonly DocumentDossierSource[] = Object.freeze([
  Object.freeze({
    excerpt: "A stale ownership record keeps the daemon from reclaiming its discovery port.",
    id: "incident-note",
    label: "Incident note",
    path: "docs/incidents/stale-port.md",
  }),
  Object.freeze({
    excerpt: "Startup must prove whether the recorded process still owns the configured port.",
    id: "startup-contract",
    label: "Startup contract",
    path: "docs/contracts/startup-ownership.md",
  }),
  Object.freeze({
    excerpt: "Restart succeeds with the old port occupied and preserves the live owner.",
    id: "recovery-acceptance",
    label: "Recovery acceptance",
    path: "docs/acceptance/recovery.md",
  }),
]);

const PREVIEW_WORK_CANDIDATES: readonly DocumentDossierCandidate[] = Object.freeze([
  Object.freeze({
    id: "recovery-contract",
    role: "Docs",
    sourceIds: Object.freeze(["incident-note", "startup-contract"]),
    title: "Write the recovery contract",
    truthClass: "AGENT_REPORTED",
  }),
  Object.freeze({
    id: "startup-ownership",
    role: "Implementation",
    sourceIds: Object.freeze(["recovery-acceptance", "startup-contract"]),
    title: "Guard startup ownership",
    truthClass: "AGENT_REPORTED",
  }),
  Object.freeze({
    id: "stale-recovery-proof",
    role: "Verification",
    sourceIds: Object.freeze(["incident-note", "recovery-acceptance"]),
    title: "Prove stale-record recovery",
    truthClass: "AGENT_REPORTED",
  }),
]);

/** The deterministic preview is explicit input, never a component fallback. */
export const PREVIEW_DOCUMENT_DOSSIER_STATE: DocumentDossierReadyState = Object.freeze({
  admissionLabel: "Admission not requested",
  advisoryOnly: true,
  authority: "NONE",
  boundaryText: "No daemon attached; no task records were created.",
  candidateSummaryLabel: "3 sample work candidates · not submitted",
  candidates: PREVIEW_WORK_CANDIDATES,
  decompositionTruthClass: "AGENT_REPORTED",
  dossierIdentity: "sample/docs@7f3a:stale-port-recovery",
  heading: "Stale-port recovery dossier",
  originLabel: "Document intake · development fixture",
  planQualityTruthClass: "UNKNOWN",
  provenanceNote: "Preview fixture only; no daemon event, actor, session, or receipt exists.",
  revisionLabel: "sample/docs@7f3a",
  sources: PREVIEW_DOCUMENT_SOURCES,
  status: "READY",
});
