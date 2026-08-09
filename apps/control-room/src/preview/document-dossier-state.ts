/** Presentation input for one document in a supplied dossier result. */
export interface DocumentDossierSource {
  readonly excerpt?: string | undefined;
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

/** One advisory presentation candidate and the exact source ids that support it. */
export interface DocumentDossierCandidate {
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
  readonly candidates: readonly DocumentDossierCandidate[];
  readonly decompositionTruthClass: unknown;
  readonly dossierIdentity: string;
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
