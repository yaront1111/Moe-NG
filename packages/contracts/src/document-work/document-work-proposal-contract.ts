import type { BoundedJsonDecodeError } from "../bounded-json-model.js";

export const DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION =
  "moe-document-work-proposal/1" as const;

export const DOCUMENT_WORK_PROPOSAL_ERROR_CODES = Object.freeze([
  "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED",
  "DOCUMENT_WORK_PROPOSAL_SCHEMA_UNSUPPORTED",
  "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID",
  "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED",
  "DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF",
  "DOCUMENT_WORK_PROPOSAL_SOURCE_UNBOUND",
] as const);

export const DOCUMENT_WORK_PROPOSAL_LAYERS = Object.freeze([
  "BOUNDED_JSON", "SCHEMA", "SHAPE", "LIMIT", "IDENTITY", "PROVENANCE",
] as const);

/** Advisory bounds; authoritative graph admission may be stricter. */
export const DOCUMENT_WORK_PROPOSAL_LIMITS = Object.freeze({
  maxCandidates: 24,
  maxCitations: 64,
  maxDisplayPathCodeUnits: 256,
  maxObjectiveUtf8Bytes: 32 * 1024,
  maxRefCodeUnits: 256,
  maxSources: 32,
  maxTitleCodeUnits: 256,
} as const);

export type DocumentWorkProposalErrorCode =
  (typeof DOCUMENT_WORK_PROPOSAL_ERROR_CODES)[number];
export type DocumentWorkProposalLayer =
  (typeof DOCUMENT_WORK_PROPOSAL_LAYERS)[number];

export interface DocumentWorkSourceBinding {
  readonly byteLength: number;
  readonly contentSha256: string;
  /** Display evidence only. It must never be passed to a filesystem operation. */
  readonly displayPath: string;
  readonly sourceRef: string;
}

export interface DocumentWorkCandidate {
  readonly candidateRef: string;
  readonly objective: string;
  readonly sourceRefs: readonly string[];
  readonly title: string;
}

/** Agent synthesis only: this shape cannot express task, graph, or execution authority. */
export interface DocumentWorkProposal {
  readonly advisoryOnly: true;
  readonly authority: "NONE";
  readonly candidates: readonly DocumentWorkCandidate[];
  readonly contextManifestDigest: string;
  readonly projectId: string;
  readonly repositoryBaseHash: string;
  readonly schemaVersion: typeof DOCUMENT_WORK_PROPOSAL_SCHEMA_VERSION;
  readonly sources: readonly DocumentWorkSourceBinding[];
  readonly submissionState: "NOT_SUBMITTED";
  readonly truthClass: "AGENT_REPORTED";
}

export interface DocumentWorkProposalAccepted {
  readonly ok: true;
  readonly outcome: "PROPOSED";
  readonly proposal: DocumentWorkProposal;
}

export interface DocumentWorkProposalInputRejected {
  readonly code: "DOCUMENT_WORK_PROPOSAL_INPUT_REJECTED";
  readonly decodeError: BoundedJsonDecodeError;
  readonly layer: "BOUNDED_JSON";
  readonly ok: false;
  readonly outcome: "REFUSED";
}

export type DocumentWorkProposalContractRefused =
  | { readonly code: "DOCUMENT_WORK_PROPOSAL_SCHEMA_UNSUPPORTED";
    readonly layer: "SCHEMA"; readonly ok: false; readonly outcome: "REFUSED" }
  | { readonly code: "DOCUMENT_WORK_PROPOSAL_SHAPE_INVALID";
    readonly layer: "SHAPE"; readonly ok: false; readonly outcome: "REFUSED" }
  | { readonly code: "DOCUMENT_WORK_PROPOSAL_LIMIT_EXCEEDED";
    readonly layer: "LIMIT"; readonly ok: false; readonly outcome: "REFUSED" }
  | { readonly code: "DOCUMENT_WORK_PROPOSAL_DUPLICATE_REF";
    readonly layer: "IDENTITY"; readonly ok: false; readonly outcome: "REFUSED" }
  | { readonly code: "DOCUMENT_WORK_PROPOSAL_SOURCE_UNBOUND";
    readonly layer: "PROVENANCE"; readonly ok: false; readonly outcome: "REFUSED" };

export type DocumentWorkProposalResult =
  | DocumentWorkProposalAccepted
  | DocumentWorkProposalInputRejected
  | DocumentWorkProposalContractRefused;
