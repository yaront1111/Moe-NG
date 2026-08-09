import type { DocumentWorkProposal } from "@moe/contracts";

export type DocumentDossierOrigin = "FIXTURE" | "DAEMON";

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

/** A READY state contains facts from the proposal and no caller-authored presentation claims. */
export interface DocumentDossierReadyState {
  readonly dossierIdentity: string;
  readonly origin: DocumentDossierOrigin;
  readonly proposal: DocumentWorkProposal;
  readonly status: "READY";
}

export type DocumentDossierState =
  | DocumentDossierLoadingState
  | DocumentDossierReadyState
  | DocumentDossierErrorState;

export interface DocumentDossierProposalInput {
  readonly dossierIdentity: string;
  readonly origin: DocumentDossierOrigin;
  readonly proposal: DocumentWorkProposal;
}

const INVALID_DOSSIER_STATE: DocumentDossierErrorState = Object.freeze({
  advisoryOnly: true,
  authority: "NONE",
  code: "DOCUMENT_DOSSIER_STATE_INVALID",
  layer: "CONTROL_ROOM_PRESENTATION",
  status: "ERROR",
});

function proposalBindingsAreValid(proposal: DocumentWorkProposal): boolean {
  if (!Array.isArray(proposal.sources) || proposal.sources.length === 0
    || !Array.isArray(proposal.candidates) || proposal.candidates.length === 0) return false;
  const sourceRefs = new Set<string>();
  for (const source of proposal.sources) {
    if (typeof source?.sourceRef !== "string" || sourceRefs.has(source.sourceRef)) return false;
    sourceRefs.add(source.sourceRef);
  }
  const candidateRefs = new Set<string>();
  for (const candidate of proposal.candidates) {
    if (typeof candidate?.candidateRef !== "string"
      || candidateRefs.has(candidate.candidateRef)
      || !Array.isArray(candidate.sourceRefs)
      || candidate.sourceRefs.length === 0) return false;
    candidateRefs.add(candidate.candidateRef);
    const citations = new Set<string>();
    for (const sourceRef of candidate.sourceRefs) {
      if (typeof sourceRef !== "string" || citations.has(sourceRef) || !sourceRefs.has(sourceRef)) {
        return false;
      }
      citations.add(sourceRef);
    }
  }
  return true;
}

function frozenProposal(proposal: DocumentWorkProposal): DocumentWorkProposal {
  const sources = proposal.sources.map((source) => Object.freeze({ ...source }));
  const candidates = proposal.candidates.map((candidate) => Object.freeze({
    ...candidate,
    sourceRefs: Object.freeze([...candidate.sourceRefs]),
  }));
  return Object.freeze({
    ...proposal,
    candidates: Object.freeze(candidates),
    sources: Object.freeze(sources),
  });
}

/** Deterministic presentation adapter; it grants no authority and performs no admission. */
export function documentDossierStateFromProposal(
  input: DocumentDossierProposalInput,
): DocumentDossierState {
  try {
    if ((input.origin !== "FIXTURE" && input.origin !== "DAEMON")
      || input.dossierIdentity.length === 0
      || input.proposal.advisoryOnly !== true
      || input.proposal.authority !== "NONE"
      || input.proposal.submissionState !== "NOT_SUBMITTED"
      || !proposalBindingsAreValid(input.proposal)) return INVALID_DOSSIER_STATE;
    return Object.freeze({
      dossierIdentity: input.dossierIdentity,
      origin: input.origin,
      proposal: frozenProposal(input.proposal),
      status: "READY",
    });
  } catch {
    return INVALID_DOSSIER_STATE;
  }
}
