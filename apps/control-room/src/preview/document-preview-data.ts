/** Presentation input for one document in a supplied dossier result. */
export interface DocumentDossierSource {
  readonly excerpt?: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

/** One advisory work candidate and the exact source ids that support it. */
export interface DocumentWorkCandidate {
  readonly id: string;
  readonly role?: string | undefined;
  readonly sourceIds: readonly string[];
  readonly title: string;
  readonly truthClass: unknown;
}

interface DocumentDossierAdvisoryState {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
}

export interface DocumentDossierLoadingState extends DocumentDossierAdvisoryState {
  readonly status: "LOADING";
}

export interface DocumentDossierErrorState extends DocumentDossierAdvisoryState {
  readonly code: string;
  readonly layer: string;
  readonly status: "ERROR";
}

export interface DocumentDossierReadyState extends DocumentDossierAdvisoryState {
  readonly admissionLabel: string;
  readonly boundaryText: string;
  readonly candidateSummaryLabel: string;
  readonly candidates: readonly DocumentWorkCandidate[];
  readonly decompositionTruthClass: unknown;
  readonly heading: string;
  readonly originLabel: string;
  readonly planQualityTruthClass: unknown;
  readonly provenanceNote: string;
  readonly revisionLabel: string;
  readonly sources: readonly DocumentDossierSource[];
  readonly status: "READY";
}

/** Closed presentation state. Every arm is advisory and has zero authority. */
export type DocumentDossierState =
  | DocumentDossierLoadingState
  | DocumentDossierReadyState
  | DocumentDossierErrorState;

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

const PREVIEW_WORK_CANDIDATES: readonly DocumentWorkCandidate[] = Object.freeze([
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
  heading: "Stale-port recovery dossier",
  originLabel: "Document intake · development fixture",
  planQualityTruthClass: "UNKNOWN",
  provenanceNote: "Preview fixture only; no daemon event, actor, session, or receipt exists.",
  revisionLabel: "sample/docs@7f3a",
  sources: PREVIEW_DOCUMENT_SOURCES,
  status: "READY",
});
